import { useEffect, useState } from 'react'
import { useCartStore } from '../stores/cartStore.js'
import { getFiscalNotice } from '../lib/fiscalNotice.js'
import type { FiscalNoticeKind } from '../lib/fiscalNotice.js'
import { isValidKraPinFormat, KRA_PIN_MAX_LENGTH } from '../lib/kraPin.js'
import { FISCAL_NOTICE_TIMEOUT_MS } from '../lib/toastTimeouts.js'
import { useToastStore } from '../stores/toastStore.js'
import type { ToastTone } from '../stores/toastStore.js'
import { useKeyboardStore } from '../stores/keyboardStore.js'

const FISCAL_TOAST_ID = 'fiscal-notice'

/** Tone per notice kind — `data`/`system` share `warning` (amber), matching the pre-unification styling. */
const NOTICE_TONE: Record<FiscalNoticeKind, ToastTone> = {
  waiting: 'info',
  data: 'warning',
  system: 'warning'
}

/**
 * Reports a sale's fiscal outcome (phase-78) through the shared toast
 * stack (phase-84) when it didn't fiscalize immediately. The sale
 * itself is already complete either way — this never blocks the till.
 *
 * Reads `lastReceipt` directly rather than `checkoutStatus`, since
 * `PosCheckoutPanel` resets `checkoutStatus` back to idle moments after
 * a checkout completes, while `lastReceipt` stays set until the next
 * checkout overwrites it.
 *
 * `timeoutMs` is always `FISCAL_NOTICE_TIMEOUT_MS` (`null` — see that
 * constant's doc comment): this is the one toast in the app that never
 * auto-dismisses, because it's currently the only place a flagged sale
 * surfaces to a person at all. The × button (and, for a wrong-PIN
 * rejection, "Send to Office") is the only way it goes away.
 *
 * For a wrong-PIN rejection (`notice.fixableAs === 'wrong-pin'`,
 * phase-78 Part C) this also offers the same-visit fix: correct the
 * PIN, remove it, or send the sale to the office. Both actions go
 * through `window.api.correctPinAndResend`, which updates only the
 * buyer PIN on the sale's STORED fiscal request and resends via the
 * same guarded `resendFiscalization` path every other retry uses — so
 * Rule 1 (never file twice) holds here exactly as it does everywhere
 * else. A successful resend updates `lastReceipt` via
 * `applyFiscalResendResult`, which re-derives this notice — a
 * fiscalized result simply makes it disappear.
 *
 * Renders nothing itself; `ToastStack` is the only thing that draws it
 * on screen.
 *
 * @returns {null}
 */
export default function FiscalNotice() {
  const lastReceipt = useCartStore((state) => state.lastReceipt)
  const applyFiscalResendResult = useCartStore((state) => state.applyFiscalResendResult)
  const [dismissedLocalId, setDismissedLocalId] = useState<number | null>(null)
  const [editingPin, setEditingPin] = useState(false)
  const [pinInput, setPinInput] = useState('')
  const [resending, setResending] = useState(false)
  const [resendError, setResendError] = useState<string | null>(null)

  const notice =
    lastReceipt && lastReceipt.localId !== dismissedLocalId ? getFiscalNotice(lastReceipt) : null

  const dismiss = (): void => {
    if (lastReceipt) setDismissedLocalId(lastReceipt.localId)
    setEditingPin(false)
    setPinInput('')
    setResendError(null)
    useToastStore.getState().dismiss(FISCAL_TOAST_ID)
  }

  const resend = async (buyerPin: string | null): Promise<void> => {
    if (!lastReceipt) return
    setResending(true)
    setResendError(null)
    try {
      const result = await window.api.correctPinAndResend(lastReceipt.localId, buyerPin)
      if (result.success && result.data) {
        applyFiscalResendResult(result.data)
        setEditingPin(false)
        setPinInput('')
      } else {
        setResendError(result.error ?? 'Could not resend. Please try again.')
      }
    } catch {
      setResendError('Could not resend. Please try again.')
    } finally {
      setResending(false)
    }
  }

  const trimmedPin = pinInput.trim().toUpperCase()
  const pinFormatValid = trimmedPin.length > 0 && isValidKraPinFormat(trimmedPin)

  useEffect(() => {
    if (!notice) {
      useToastStore.getState().dismiss(FISCAL_TOAST_ID)
      return
    }

    useToastStore.getState().show({
      id: FISCAL_TOAST_ID,
      tone: NOTICE_TONE[notice.kind],
      message: notice.message,
      timeoutMs: FISCAL_NOTICE_TIMEOUT_MS,
      onDismiss: dismiss,
      // Never dropped by the stack's 3-toast cap (docs/phase-166 Commit
      // E4) — see `toastVisibility.ts` and this toast's own `timeoutMs`
      // (also never-expiring) for why this one plays by different rules.
      pinned: true,
      actions:
        notice.fixableAs === 'wrong-pin' ? (
          <div className="flex flex-col gap-2">
            {editingPin ? (
              <>
                <input
                  type="text"
                  value={pinInput}
                  readOnly
                  onClick={() =>
                    useKeyboardStore.getState().open({
                      value: pinInput,
                      onChange: (next) => setPinInput(next.toUpperCase()),
                      maxLength: KRA_PIN_MAX_LENGTH,
                      label: 'Corrected Customer KRA PIN'
                    })
                  }
                  maxLength={KRA_PIN_MAX_LENGTH}
                  placeholder="P051234567Z"
                  aria-label="Corrected customer KRA PIN"
                  className="h-11 rounded-lg border border-amber-300 bg-white px-3 text-lg uppercase text-slate-900 focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={!pinFormatValid || resending}
                    onClick={() => void resend(trimmedPin)}
                    className="h-10 flex-1 rounded-lg bg-rose-600 text-sm font-semibold text-white transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {resending ? 'Sending…' : 'Save & Resend'}
                  </button>
                  <button
                    type="button"
                    disabled={resending}
                    onClick={() => {
                      setEditingPin(false)
                      setPinInput('')
                    }}
                    className="h-10 rounded-lg border border-amber-300 bg-white px-3 text-sm font-semibold text-amber-900 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={resending}
                  onClick={() => setEditingPin(true)}
                  className="h-10 w-full rounded-lg bg-rose-600 text-sm font-semibold text-white transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Correct PIN
                </button>
                <button
                  type="button"
                  disabled={resending}
                  onClick={() => void resend(null)}
                  className="h-10 w-full rounded-lg border border-amber-300 bg-white text-sm font-semibold text-amber-900 transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {resending ? 'Sending…' : 'Remove PIN & Resend'}
                </button>
                <button
                  type="button"
                  disabled={resending}
                  onClick={dismiss}
                  className="h-10 w-full rounded-lg text-sm font-medium text-amber-800 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Send to Office
                </button>
              </>
            )}
            {resendError && <p className="text-sm font-medium text-rose-700">{resendError}</p>}
          </div>
        ) : undefined
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notice, editingPin, pinInput, resending, resendError, trimmedPin, pinFormatValid])

  return null
}
