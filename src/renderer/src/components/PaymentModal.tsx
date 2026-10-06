import { useEffect, useRef, useState } from 'react'
import { formatCurrency } from '../lib/currency.js'
import { useKeyboardStore } from '../stores/keyboardStore.js'
import { usePaymentActivityStore } from '../stores/paymentActivityStore.js'
import {
  createMpesaPaymentPoller,
  MPESA_POLL_TIMEOUT_MS,
  type MpesaPaymentPoller
} from '../lib/mpesaPaymentPoller.js'

/** How this till confirms an M-Pesa payment — mirrors `MpesaConfirmationMethod` in the main process. */
type MpesaMode = 'manual' | 'daraja' | 'sms'

/**
 * `getMpesaCapabilities`'s lifecycle: `'loading'` until the first reply,
 * `'unavailable'` if the call fails or returns no usable data, `'ready'`
 * with the resolved mode otherwise.
 *
 * Added per a user correction to this component's original fail-safe
 * choice: falling back to the Daraja STK form while loading or on error
 * was the right default when Daraja was the default *method* — now that
 * manual is, that fallback would briefly (or, on a real failure,
 * indefinitely) show a manual till a phone-number form it cannot use
 * (a manual-mode till's provider refuses `initiateStkPush`, so no money
 * is ever at risk — it is just the wrong screen). A neutral "Loading…"
 * and an explicit "unavailable" notice are honest about what's actually
 * known instead.
 */
export type MpesaCapabilitiesState =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'ready'; mode: MpesaMode; manualEntryEnabled: boolean }

/** Which M-Pesa flow tab is active, within `'daraja'` mode only. Hidden once an STK Push is in flight or has failed. */
type PaymentTab = 'stk' | 'unverified'

/** The shape of a Safaricom confirmation code, mirrored from `checkout.ts`. */
export const MANUAL_CODE_PATTERN = /^[A-Z0-9]{10}$/

/**
 * STK Push sub-flow state — `'form'` is the phone-number entry screen,
 * `'waiting'` is the polling overlay shown after a push is accepted,
 * `'failed'` is the terminal failure/timeout screen with Retry/Cancel.
 */
type StkPhase =
  | { kind: 'form' }
  | { kind: 'waiting'; checkoutRequestId: string; msRemaining: number }
  | { kind: 'failed'; reason: string }

/**
 * A manually entered code. `confirmUnverified` is always `true`: pressing
 * Complete Sale on a full code is the cashier's confirmation, and the
 * checkout contract still requires the field.
 *
 * No manager credentials here (docs/phase-150.md step 3 — per-sale
 * manager approval was removed). Passed straight through to
 * `orders:checkout`, where the cashier is established from the
 * authenticated session, never from this object.
 */
export interface ManualMpesaEntryInput {
  code: string
  confirmUnverified: true
}

interface PaymentModalProps {
  /** Amount to charge, shown to the cashier and sent to the mock provider. */
  total: number
  /**
   * Called once a payment is confirmed, with the reference number to
   * record on the order.
   *
   * `manual` is present only on the unverified route, and its presence
   * is what tells the caller this sale was **not** confirmed by anyone.
   */
  onPaid: (referenceNumber: string, manual?: ManualMpesaEntryInput) => void
  /** Called when the cashier backs out to pick a different payment method. */
  onCancel: () => void
  /**
   * Set only while the sale on screen was resumed from hold (docs/phase-217): its label
   * and total show in large type above the code field, so the cashier checks the code on
   * the customer's phone against the right amount.
   */
  heldLabel?: string
  /**
   * Test-hook-only (docs/phase-167 Part B item 1): skips the real
   * `getMpesaCapabilities()` call and renders as if it had already
   * resolved to this value — this till's ACTUAL mode is whatever a real
   * admin configured, which `check:fit`'s `'mpesaManualKeyboard'` screen
   * cannot rely on being `'manual'`. Always `undefined` on every real
   * launch (see `PosCheckoutPanel`'s own doc comment on where this comes
   * from), so the real capabilities call is never skipped there.
   */
  forcedCapabilities?: MpesaCapabilitiesState
}

/** `2547XXXXXXXX` — Safaricom MSISDN format expected by the mock Daraja provider. */
const PHONE_PATTERN = /^254\d{9}$/

/** Kenyan country code, fixed in the UI so the cashier only ever types the subscriber number. */
const COUNTRY_CODE = '254'

/**
 * Strips non-digits and, since cashiers commonly read a number off a
 * customer's phone as `0712345678`, a single leading `0` — so typing
 * either `712345678` or `0712345678` after the fixed `254` prefix
 * yields the same subscriber number.
 */
function stripLeadingZero(rawInput: string): string {
  const digits = rawInput.replace(/\D/g, '')
  return digits.startsWith('0') ? digits.slice(1) : digits
}

/**
 * M-Pesa payment collection UI. Renders an entirely different screen
 * depending on the resolved mode (`'manual'` | `'daraja'` | `'sms'`,
 * reported by `getMpesaCapabilities`) — the client's POC decision
 * (docs/phase-148.md step 2) that manual recording is this till's
 * default, exclusive method unless an administrator explicitly turned on
 * Daraja:
 *   - **`'manual'`** (the default): one screen only, "Record M-Pesa
 *     payment" — the cashier checks the confirmation message on the
 *     customer's own phone and types the code in, with no manager PIN
 *     (docs/phase-150.md step 3). No request is ever sent anywhere.
 *   - **`'daraja'`**: the STK Push flow — phone number (entered after a
 *     fixed `254` prefix — a leading `0`, as in `0712345678`, is
 *     stripped automatically) → push prompt → a "Waiting for M-Pesa
 *     Confirmation" overlay that polls `queryMpesaStatus` every 5s (see
 *     `mpesaPaymentPoller.ts`) for up to 90s, only calling `onPaid` once
 *     Daraja actually confirms the payment — this component never checks
 *     out on push-*acceptance* alone. If an administrator also enabled
 *     the manual fallback (for a payment Daraja never confirmed), a
 *     second "Manual verification" tab appears alongside STK and is the
 *     tab selected when the panel opens (owner's ruling, docs/phase-235);
 *     the cashier taps "STK Push" to send a prompt instead.
 *   - **`'sms'`**: a plain notice that this till cannot take M-Pesa by
 *     message yet — its parser is still a stub (`MPESA_SMS_PARSER_READY`
 *     in `src/main/lib/mpesaSms.ts`).
 *
 * While the capabilities reply is in flight, this shows a plain
 * "Loading…" notice, and if the call fails (or never resolves), a plain
 * "M-Pesa is unavailable right now" notice with no form at all — a user
 * correction to this component's earlier choice of falling back to the
 * Daraja STK form in both cases, which was the right default when Daraja
 * was the default *method* but became the wrong screen once manual is:
 * showing a manual till a phone-number form it cannot use (its provider
 * refuses `initiateStkPush` outright, so no money is ever at risk — it
 * is just confusing) rather than saying plainly that M-Pesa isn't ready.
 *
 * Every STK Push attempt — accepted or rejected — is also logged via
 * `logMpesaTransaction` for the M-Pesa Logs screen.
 *
 * The M-Pesa amount always equals the cart `total` passed in as a
 * prop — there is no editable amount field for the cashier to
 * mistype, so "amount must exactly match the cart total" holds by
 * construction. A blocking notice replaces the whole UI when `total`
 * is not positive, since there is nothing to charge for an empty cart.
 *
 * @param {PaymentModalProps} props
 * @returns {JSX.Element}
 */
export default function PaymentModal({
  total,
  onPaid,
  onCancel,
  heldLabel,
  forcedCapabilities
}: PaymentModalProps) {
  const [capabilities, setCapabilities] = useState<MpesaCapabilitiesState>(
    forcedCapabilities ?? { status: 'loading' }
  )
  /** Manual verification opens first (docs/phase-235); only read through `activeTab` below. */
  const [tab, setTab] = useState<PaymentTab>('unverified')

  /** Raw digits typed after the fixed `254` prefix — may still include a leading `0`. */
  const [localPhoneInput, setLocalPhoneInput] = useState('')
  const phoneNumber = `${COUNTRY_CODE}${stripLeadingZero(localPhoneInput)}`
  const [stkLoading, setStkLoading] = useState(false)
  const [stkError, setStkError] = useState<string | null>(null)
  const [stkPhase, setStkPhase] = useState<StkPhase>({ kind: 'form' })

  const [unverifiedCode, setUnverifiedCode] = useState('')
  const isManualCodeComplete = MANUAL_CODE_PATTERN.test(unverifiedCode)

  /**
   * Tells Hold that a payment is in progress (docs/phase-217): a push waiting, a push
   * request in flight, or a code typed. Cleared when this panel goes away.
   */
  const setPaymentActive = usePaymentActivityStore((state) => state.setActive)
  const paymentInProgress = stkPhase.kind === 'waiting' || stkLoading || unverifiedCode.length > 0
  useEffect(() => {
    setPaymentActive('mpesa', paymentInProgress)
  }, [paymentInProgress, setPaymentActive])
  useEffect(() => () => setPaymentActive('mpesa', false), [setPaymentActive])

  useEffect(() => {
    if (forcedCapabilities) return
    let cancelled = false
    void window.api
      .getMpesaCapabilities()
      .then((result) => {
        if (cancelled) return
        if (result.success && result.data) {
          setCapabilities({
            status: 'ready',
            mode: result.data.mode,
            manualEntryEnabled: result.data.manualEntryEnabled
          })
        } else {
          setCapabilities({ status: 'unavailable' })
        }
      })
      .catch(() => {
        if (!cancelled) setCapabilities({ status: 'unavailable' })
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pollerRef = useRef<MpesaPaymentPoller | null>(null)

  /** Stops and discards any in-flight poller. Idempotent. */
  const stopPolling = () => {
    pollerRef.current?.stop()
    pollerRef.current = null
  }

  useEffect(() => stopPolling, [])

  /**
   * Records a rejected/erroring STK Push attempt for the M-Pesa Logs
   * screen. Daraja never issues a `CheckoutRequestID` for a request it
   * didn't accept, so a client-generated placeholder id is used —
   * there is nothing to later "Check Status" on, only an audit trail
   * of the attempt. Best-effort: a logging failure must not block the
   * cashier from retrying the payment.
   */
  const logFailedStkPushAttempt = async () => {
    try {
      await window.api.logMpesaTransaction({
        checkoutRequestId: `failed-${Date.now()}`,
        merchantRequestId: '',
        phoneNumber,
        amount: total,
        status: 'failed'
      })
    } catch {
      // Best-effort — see doc comment above.
    }
  }

  /**
   * Starts polling `checkoutRequestId` for a definitive outcome.
   * `onPaid` fires only from the poller's `onSuccess` callback — a
   * mere STK Push *acceptance* is never treated as a completed sale.
   */
  const startPolling = (checkoutRequestId: string) => {
    stopPolling()
    setStkPhase({ kind: 'waiting', checkoutRequestId, msRemaining: MPESA_POLL_TIMEOUT_MS })
    const poller = createMpesaPaymentPoller({
      checkoutRequestId,
      queryStatus: (id) => window.api.queryMpesaStatus(id),
      callbacks: {
        onPending: (msRemaining) => {
          setStkPhase((prev) => (prev.kind === 'waiting' ? { ...prev, msRemaining } : prev))
        },
        onSuccess: (receiptNumber) => {
          pollerRef.current = null
          onPaid(receiptNumber ?? checkoutRequestId)
        },
        onFailed: (reason) => {
          pollerRef.current = null
          setStkPhase({ kind: 'failed', reason })
        },
        onTimeout: () => {
          pollerRef.current = null
          setStkPhase({
            kind: 'failed',
            reason: 'Payment timed out — the customer did not respond in time.'
          })
        }
      }
    })
    pollerRef.current = poller
    poller.start()
  }

  const handleSendStkPush = async () => {
    setStkError(null)
    if (!PHONE_PATTERN.test(phoneNumber)) {
      setStkError('Enter a valid phone number, e.g. 712345678')
      return
    }
    setStkLoading(true)
    try {
      const result = await window.api.initiateMpesaStkPush({
        phoneNumber,
        amount: total,
        accountReference: `RUBIS-${Date.now()}`,
        transactionDesc: 'RUBIS POS sale'
      })
      if (result.success && result.data) {
        await window.api.logMpesaTransaction({
          checkoutRequestId: result.data.checkoutRequestId,
          merchantRequestId: result.data.merchantRequestId,
          phoneNumber,
          amount: total,
          status: 'pending'
        })
        startPolling(result.data.checkoutRequestId)
        return
      }
      setStkError(result.error ?? 'STK Push request failed')
      await logFailedStkPushAttempt()
    } catch (err) {
      setStkError(err instanceof Error ? err.message : 'STK Push request failed')
      await logFailedStkPushAttempt()
    } finally {
      setStkLoading(false)
    }
  }

  /**
   * Opens the shared on-screen keyboard for the M-Pesa code field (caps
   * layout, a live echo of what's typed, and a "Submit" key that closes
   * the overlay — the same pattern every other till field on a touch
   * screen uses via `keyboardStore`, e.g. the customer KRA PIN field in
   * `PosCheckoutPanel`). Docked to the bottom, matching the pre-login
   * setup screens' choice for a field low in a scrollable form, so the
   * Complete Sale button below stays reachable while typing.
   */
  const openCodeKeyboard = () => {
    useKeyboardStore.getState().open({
      value: unverifiedCode,
      onChange: (next) => setUnverifiedCode(next.toUpperCase().replace(/[^A-Z0-9]/g, '')),
      maxLength: 10,
      label: 'M-Pesa code from the customer’s message',
      mode: 'caps',
      docked: true
    })
  }

  /**
   * Completes the sale directly on a full code — no manager PIN
   * (docs/phase-150.md step 3). The button is disabled until the code is
   * complete; the guard here and the main process's own check are the
   * controls, this is not.
   */
  const handleUnverifiedContinue = () => {
    if (!isManualCodeComplete) return
    onPaid(unverifiedCode, { code: unverifiedCode, confirmUnverified: true })
  }

  /**
   * The code-entry form, shared between `'manual'` mode's
   * sole screen and `'daraja'` mode's optional "Manual verification" tab — the two
   * contexts differ only in framing (manual mode is this till's normal
   * way of taking every M-Pesa payment; Daraja's Manual verification tab is an
   * exception for a payment Daraja itself never confirmed), never in
   * mechanics. Neither asks for a manager's PIN or a tick box — Complete
   * Sale only becomes active once the whole code is typed, and a manager's
   * approval is deferred to the end-of-day report (docs/phase-150.md step
   * 3/4).
   */
  const renderManualEntryPanel = (heading: string, description: string) => (
    <div className="rounded-xl border-2 border-amber-400 bg-amber-50/60 p-3">
      <p className="text-lg font-semibold text-amber-900">{heading}</p>
      {heldLabel ? (
        <p className="mt-1 truncate text-2xl font-extrabold tabular-nums text-amber-950" data-testid="held-sale-banner">
          {heldLabel} · {formatCurrency(total)}
        </p>
      ) : (
        <p className="mt-1 text-base text-amber-900/80">{description}</p>
      )}

      <label className="mb-1 mt-3 block text-base font-medium text-slate-700">
        M-Pesa code from the customer&rsquo;s message
      </label>
      <input
        type="text"
        value={unverifiedCode}
        readOnly
        onClick={openCodeKeyboard}
        placeholder="e.g. QDF73HK9LM"
        aria-label="M-Pesa code from the customer’s message"
        className="w-full rounded-lg border border-amber-400 bg-white px-3 py-3 text-xl uppercase tracking-wide focus:border-amber-500 focus:outline-none"
      />

      <button
        type="button"
        disabled={!isManualCodeComplete}
        onClick={handleUnverifiedContinue}
        className="mt-4 w-full rounded-xl border-2 border-amber-600 bg-white py-4 text-xl font-semibold text-amber-900 transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Complete Sale
      </button>
    </div>
  )

  /** Cashier cancels while waiting for confirmation — stops polling and returns to the cart. */
  const handleCancelWaiting = () => {
    stopPolling()
    onCancel()
  }

  /** Cashier retries after a failed/timed-out push — back to the phone-number form. */
  const handleRetry = () => {
    stopPolling()
    setStkError(null)
    setStkPhase({ kind: 'form' })
  }

  if (total <= 0) {
    return (
      <div>
        <button
          type="button"
          onClick={onCancel}
          className="mb-3 text-base text-slate-500 hover:text-slate-700"
        >
          ← Change payment method
        </button>
        <p className="rounded-lg bg-rose-50 px-4 py-3 text-base font-medium text-rose-700">
          Cart is empty. Please add items before paying.
        </p>
      </div>
    )
  }

  if (stkPhase.kind === 'waiting') {
    const secondsRemaining = Math.max(0, Math.ceil(stkPhase.msRemaining / 1000))
    return (
      <div className="flex flex-col items-center text-center">
        <div className="mb-4 h-12 w-12 animate-spin rounded-full border-4 border-rose-600 border-t-transparent" />
        <h4 className="mb-1 text-xl font-semibold text-slate-900">
          Waiting for M-Pesa Confirmation
        </h4>
        <p className="mb-4 text-base text-slate-500">
          A prompt was sent to <span className="font-semibold text-slate-800">{phoneNumber}</span>{' '}
          for <span className="font-semibold text-slate-800">{formatCurrency(total)}</span>. Ask the
          customer to enter their M-Pesa PIN to approve.
        </p>
        <p className="mb-6 text-3xl font-bold tabular-nums text-rose-600">{secondsRemaining}s</p>
        <button
          type="button"
          onClick={handleCancelWaiting}
          className="w-full rounded-xl border border-slate-300 py-3 text-lg font-semibold text-slate-700 hover:bg-slate-50"
        >
          Cancel Payment
        </button>
      </div>
    )
  }

  if (stkPhase.kind === 'failed') {
    return (
      <div className="text-center">
        <h4 className="mb-2 text-xl font-semibold text-slate-900">Payment Not Completed</h4>
        <p className="mb-6 rounded-lg bg-rose-50 px-4 py-3 text-base font-medium text-rose-700">
          {stkPhase.reason}
        </p>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-xl border border-slate-300 py-3 text-lg font-semibold text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleRetry}
            className="flex-1 rounded-xl bg-rose-600 py-3 text-lg font-semibold text-white hover:bg-rose-700"
          >
            Retry Payment
          </button>
        </div>
      </div>
    )
  }

  if (capabilities.status === 'loading') {
    return (
      <div>
        <button
          type="button"
          onClick={onCancel}
          className="mb-3 text-base text-slate-500 hover:text-slate-700"
        >
          ← Change payment method
        </button>
        <p className="text-base text-slate-400">Loading…</p>
      </div>
    )
  }

  if (capabilities.status === 'unavailable') {
    return (
      <div>
        <button
          type="button"
          onClick={onCancel}
          className="mb-3 text-base text-slate-500 hover:text-slate-700"
        >
          ← Change payment method
        </button>
        <p className="rounded-lg bg-rose-50 px-4 py-3 text-base font-medium text-rose-700">
          M-Pesa is unavailable right now. Take payment another way.
        </p>
      </div>
    )
  }

  if (capabilities.mode === 'sms') {
    // The parser is still a stub (MPESA_SMS_PARSER_READY, phase-147
    // §1.4) — no code path in this mode can ever confirm a payment, so
    // there is nothing useful to show but this notice.
    return (
      <div>
        <button
          type="button"
          onClick={onCancel}
          className="mb-3 text-base text-slate-500 hover:text-slate-700"
        >
          ← Change payment method
        </button>
        <p className="rounded-lg bg-slate-100 px-4 py-3 text-base font-medium text-slate-600">
          M-Pesa by SMS is not available on this till.
        </p>
      </div>
    )
  }

  if (capabilities.mode === 'manual') {
    // The till's default, exclusive method (docs/phase-148.md step 2):
    // one screen, no STK tab, no Manual Code tab.
    return (
      <div>
        <button
          type="button"
          onClick={onCancel}
          className="mb-3 text-base text-slate-500 hover:text-slate-700"
        >
          ← Change payment method
        </button>
        <p className="mb-4 text-base text-slate-500">
          Charging <span className="font-semibold text-slate-800">{formatCurrency(total)}</span>
        </p>
        {renderManualEntryPanel(
          'Record M-Pesa payment',
          "Check the confirmation message on the customer's phone, then enter the code below."
        )}
      </div>
    )
  }

  const { manualEntryEnabled } = capabilities
  /** Without the manual fallback there is no tab bar and STK is the only screen. */
  const activeTab: PaymentTab = manualEntryEnabled ? tab : 'stk'

  return (
    <div>
      <button
        type="button"
        onClick={onCancel}
        className="mb-3 text-base text-slate-500 hover:text-slate-700"
      >
        ← Change payment method
      </button>

      {manualEntryEnabled && (
        <div className="mb-4 flex rounded-lg bg-slate-100 p-1">
          <button
            type="button"
            onClick={() => setTab('stk')}
            className={`flex-1 rounded-md py-2 text-base font-semibold transition ${
              activeTab === 'stk' ? 'bg-white text-rose-700 shadow-sm' : 'text-slate-500'
            }`}
          >
            STK Push
          </button>
          {/*
            Styled apart from the confirming route on purpose. This tab
            completes a sale nobody has checked, and a cashier should never
            reach it by accident or mistake it for the verified one beside
            it. The amber carries through to the panel and the button.
          */}
          <button
            type="button"
            onClick={() => setTab('unverified')}
            className={`flex-1 rounded-md py-2 text-base font-semibold transition ${
              activeTab === 'unverified' ? 'bg-amber-100 text-amber-900 shadow-sm' : 'text-amber-700'
            }`}
          >
            Manual verification
          </button>
        </div>
      )}

      <p className="mb-4 text-base text-slate-500">
        Charging <span className="font-semibold text-slate-800">{formatCurrency(total)}</span>
      </p>

      {activeTab === 'stk' && (
        <div>
          <label className="mb-1 block text-base font-medium text-slate-600">Phone Number</label>
          <div className="flex items-stretch overflow-hidden rounded-lg border border-slate-300 focus-within:border-rose-400 focus-within:outline-none focus-within:ring-4 focus-within:ring-rose-100">
            <span className="flex items-center bg-slate-100 px-3 text-xl font-medium text-slate-500">
              +{COUNTRY_CODE}
            </span>
            <input
              type="tel"
              readOnly
              value={localPhoneInput}
              onClick={() =>
                useKeyboardStore.getState().open({
                  value: localPhoneInput,
                  onChange: (next) => setLocalPhoneInput(next.replace(/\D/g, '').slice(0, 10)),
                  label: 'Phone Number',
                  mode: 'numeric'
                })
              }
              placeholder="712345678 or 0712345678"
              disabled={stkLoading}
              aria-label="Phone Number"
              className="w-full border-0 px-3 py-3 text-xl focus:outline-none disabled:bg-slate-50"
            />
          </div>

          <label className="mb-1 mt-3 block text-base font-medium text-slate-600">Amount</label>
          <input
            type="text"
            value={formatCurrency(total)}
            readOnly
            disabled
            aria-label="Amount (fixed to the cart total)"
            className="w-full cursor-not-allowed rounded-lg border border-slate-300 bg-slate-50 px-3 py-3 text-xl text-slate-700"
          />

          {stkError && (
            <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">
              {stkError}
            </p>
          )}

          <button
            type="button"
            disabled={stkLoading}
            onClick={() => void handleSendStkPush()}
            className="mt-4 w-full rounded-xl bg-rose-600 py-4 text-xl font-semibold text-white transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {stkLoading ? (
              <span className="flex items-center justify-center gap-2">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                Sending request…
              </span>
            ) : (
              'Send Request'
            )}
          </button>
        </div>
      )}

      {activeTab === 'unverified' &&
        renderManualEntryPanel(
          'Checked by the cashier, not by Safaricom.',
          'Use this only when the customer has paid but the confirmation has not reached this till. Check the code on the customer’s phone; the manager approves it at End of Day against the M-Pesa statement.'
        )}
    </div>
  )
}
