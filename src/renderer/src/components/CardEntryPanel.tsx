import { useState } from 'react'
import { formatCurrency } from '../lib/currency.js'
import { canCompleteSale } from '../lib/checkoutMath.js'
import { useKeyboardStore } from '../stores/keyboardStore.js'
import type { CardManualEntry } from '../../../main/services/database.js'

/**
 * The shape of a PDQ slip reference this till accepts, mirrored from
 * `checkout.ts`'s `CARD_REFERENCE_PATTERN` — this copy is a courtesy to
 * the cashier (see `handleContinue`'s own doc comment); the main
 * process's copy is the control.
 */
export const CARD_REFERENCE_PATTERN = /^[A-Z0-9]{1,12}$/

interface CardEntryPanelProps {
  total: number
  /** Fires once the cashier has entered a reference and ticked the attestation — the caller completes the sale. */
  onPaid: (reference: string, manual: CardManualEntry) => void
  onCancel: () => void
}

/**
 * Card (PDQ) tender entry — copies `PaymentModal`'s manual M-Pesa entry
 * pattern (docs/phase-176.md Part 2 §3), not the STK pattern: Rubis
 * takes cards on a separate PDQ machine the till has no link to, so
 * there is nothing here to poll or confirm, only a reference and the
 * cashier's attestation that the slip printed Approved.
 *
 * Unlike the manual M-Pesa panel's own Complete Sale button (always
 * clickable, validated on click), this one is disabled until valid —
 * matching Cash's `canSubmitCash` pattern in `PosCheckoutPanel`,
 * per docs/phase-176.md Part 2 §3's brief.
 *
 * @param {CardEntryPanelProps} props
 * @returns {JSX.Element}
 */
export default function CardEntryPanel({ total, onPaid, onCancel }: CardEntryPanelProps) {
  const [reference, setReference] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /**
   * Opens the shared on-screen keyboard for the reference field (caps
   * layout, docked to the bottom) — the same pattern the manual M-Pesa
   * code field uses (`PaymentModal.tsx`'s `openCodeKeyboard`).
   */
  const openReferenceKeyboard = () => {
    useKeyboardStore.getState().open({
      value: reference,
      onChange: (next) => setReference(next.toUpperCase().replace(/[^A-Z0-9]/g, '')),
      maxLength: 12,
      label: 'Reference from the PDQ slip',
      mode: 'caps',
      docked: true
    })
  }

  const canSubmit = canCompleteSale('card', total, 0, reference) && acknowledged

  /**
   * Re-validates before calling `onPaid` — belt-and-braces alongside the
   * button's own `disabled` state, since the real decision is made
   * server-side by `checkout.ts`'s card gate; this only tells the
   * cashier what is wrong before they tap Complete, the same reasoning
   * as `PaymentModal.tsx`'s `handleUnverifiedContinue`.
   */
  const handleContinue = () => {
    setError(null)
    if (!CARD_REFERENCE_PATTERN.test(reference)) {
      setError('Enter the reference from the PDQ slip (letters and numbers only).')
      return
    }
    if (!acknowledged) {
      setError('Confirm that the PDQ slip shows Approved for this amount.')
      return
    }
    onPaid(reference, { reference, confirmRecorded: true })
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

      <div className="rounded-xl border-2 border-amber-400 bg-amber-50/60 p-3">
        <p className="text-lg font-semibold text-amber-900">Record card payment</p>
        <p className="mt-1 text-base text-amber-900/80">
          Check the PDQ slip shows Approved, then enter the reference below.
        </p>

        <label className="mb-1 mt-3 block text-base font-medium text-slate-700">
          Reference from the PDQ slip
        </label>
        <input
          type="text"
          value={reference}
          readOnly
          onClick={openReferenceKeyboard}
          placeholder="e.g. TXN9001"
          aria-label="Reference from the PDQ slip"
          className="w-full rounded-lg border border-amber-400 bg-white px-3 py-3 text-xl uppercase tracking-wide focus:border-amber-500 focus:outline-none"
        />

        <label className="mt-3 flex items-start gap-2 text-base text-amber-900">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="mt-1 h-5 w-5"
          />
          I have checked the PDQ slip shows Approved for this amount.
        </label>

        {error && (
          <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">
            {error}
          </p>
        )}

        <button
          type="button"
          disabled={!canSubmit}
          onClick={handleContinue}
          className="mt-4 w-full rounded-xl border-2 border-amber-600 bg-white py-4 text-xl font-semibold text-amber-900 transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Complete Sale
        </button>
      </div>
    </div>
  )
}
