import { useState } from 'react'
import type { ZReport } from '../../../main/services/reports.js'
import { formatCurrency } from '../lib/currency.js'
import { closeShiftBlockedMessage } from '../lib/heldSale.js'
import { CARD_BALANCE_INVALID, MPESA_BALANCE_INVALID, parseOptionalBalance } from '../lib/optionalBalance.js'
import { useShiftWindowStatus } from '../lib/useShiftWindowStatus.js'
import { useAuthStore } from '../stores/authStore.js'
import { useHeldSalesStore } from '../stores/heldSalesStore.js'
import { useKeyboardStore } from '../stores/keyboardStore.js'
import { useShiftStore } from '../stores/shiftStore.js'

interface CloseShiftDialogProps {
  /** The till's open shift. */
  shiftId: number
  onCancel: () => void
  /** The shift is closed; `report` is its Z, unlocked now, or `null` if it could not be read. */
  onClosed: (report: ZReport | null) => void
}

/** The three figures, as typed. */
interface Counts {
  cash: number
  mpesa: number | null
  card: number | null
}

/**
 * Opens the docked keyboard for one figure.
 *
 * @param {string} value
 * @param {(next: string) => void} onChange
 * @param {string} label
 */
function openFigure(value: string, onChange: (next: string) => void, label: string): void {
  useKeyboardStore.getState().open({ value, onChange, label, mode: 'decimal' })
}

/**
 * Closing the till's shift (docs/phase-256): the one flow every screen that shows shifts or a Z report uses, so a
 * shift is closed the same way wherever it is closed.
 *
 * 1. The counted figures: cash, required; the M-Pesa balance and the card settlement, optional ("Not recorded" when
 *    blank, never 0). A held sale stops the close here, as it does in the main process.
 * 2. A review of what was typed, and what closing means, before anything is written.
 * 3. The close. The main process checks everything again: who is signed in, the window's end (a cashier waits for it;
 *    an admin may close early, docs/phase-255), held sales, and that the shift is still open. Its refusal is shown and
 *    the figures stay for another try.
 *
 * Then the caller is given the Z, which the close has unlocked.
 *
 * @param {CloseShiftDialogProps} props
 * @returns {JSX.Element}
 */
export default function CloseShiftDialog({ shiftId, onCancel, onClosed }: CloseShiftDialogProps) {
  const isAdmin = useAuthStore((state) => state.currentStaff?.role === 'admin')
  const { status } = useShiftWindowStatus()
  const [cash, setCash] = useState('')
  const [mpesa, setMpesa] = useState('')
  const [card, setCard] = useState('')
  const [review, setReview] = useState<Counts | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [closing, setClosing] = useState(false)

  const timing = status?.openShift?.id === shiftId ? status.openShift : null
  const early = timing !== null && !timing.closeAllowed
  const heldBlock = closeShiftBlockedMessage(useHeldSalesStore((state) => state.sales))
  const blocked = heldBlock ?? (early && !isAdmin ? timing.closeMessage : null)

  const toReview = (): void => {
    setError(null)
    const counted = cash.trim() === '' ? NaN : Number(cash)
    if (!Number.isFinite(counted) || counted < 0) {
      setError('Enter a valid ending cash amount')
      return
    }
    const mpesaFigure = parseOptionalBalance(mpesa)
    if (mpesaFigure === 'invalid') {
      setError(MPESA_BALANCE_INVALID)
      return
    }
    const cardFigure = parseOptionalBalance(card)
    if (cardFigure === 'invalid') {
      setError(CARD_BALANCE_INVALID)
      return
    }
    setReview({ cash: counted, mpesa: mpesaFigure, card: cardFigure })
  }

  const confirm = async (counts: Counts): Promise<void> => {
    setError(null)
    setClosing(true)
    try {
      // docs/phase-246, R5: blank optional figures send nothing, so a close with none sends the call it always sent.
      const result = await window.api.closeShift(
        shiftId,
        counts.cash,
        ...(counts.card !== null ? [counts.mpesa, counts.card] : counts.mpesa === null ? [] : [counts.mpesa])
      )
      if (!result.success) {
        setError(result.error ?? 'Failed to close shift')
        setReview(null)
        return
      }
      void useShiftStore.getState().load()
      const report = await window.api.getZReport(shiftId)
      onClosed(report.success && report.data ? report.data : null)
    } catch {
      setError('Failed to close shift')
      setReview(null)
    } finally {
      setClosing(false)
    }
  }

  const figureText = (value: number | null): string => (value === null ? 'Not recorded' : formatCurrency(value))

  return (
    <div role="dialog" aria-label="Close shift" className="fixed inset-0 z-[55] flex items-center justify-center bg-slate-900/40 p-6">
      <div className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-xl">
        <h3 className="mb-3 text-2xl font-bold text-slate-800">Close shift #{shiftId}</h3>

        {error && (
          <p role="alert" className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">
            {error}
          </p>
        )}

        {blocked ? (
          <>
            <p role="alert" className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-base font-medium text-amber-900" data-testid="close-blocked">
              {blocked}
            </p>
            <div className="flex justify-end">
              <button type="button" onClick={onCancel} className="h-12 rounded-lg border border-slate-300 px-5 text-lg text-slate-600 hover:bg-slate-50">
                OK
              </button>
            </div>
          </>
        ) : review ? (
          <>
            <dl className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg bg-slate-50 p-3 text-lg" data-testid="close-review">
              <dt className="text-slate-600">Counted cash</dt>
              <dd className="text-right font-semibold">{formatCurrency(review.cash)}</dd>
              <dt className="text-slate-600">M-Pesa balance</dt>
              <dd className="text-right font-semibold">{figureText(review.mpesa)}</dd>
              <dt className="text-slate-600">Card settlement</dt>
              <dd className="text-right font-semibold">{figureText(review.card)}</dd>
            </dl>
            {early && (
              <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-base font-medium text-amber-900" data-testid="close-early">
                Closing early: the {timing.windowName.toLowerCase()} window ends at {timing.endClock}.
              </p>
            )}
            <p className="mb-4 text-base text-slate-600">
              Check the figures. A closed shift cannot be opened again; only an admin can correct its figures afterwards.
            </p>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                disabled={closing}
                onClick={() => setReview(null)}
                className="h-12 rounded-lg border border-slate-300 px-5 text-lg text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                Back
              </button>
              <button
                type="button"
                disabled={closing}
                onClick={() => void confirm(review)}
                className="h-12 rounded-lg bg-rose-600 px-5 text-lg font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {closing ? 'Closing…' : 'Close shift'}
              </button>
            </div>
          </>
        ) : (
          <>
            {early && (
              <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-base font-medium text-amber-900" data-testid="close-early">
                {timing.closeMessage} As an admin you may close it early.
              </p>
            )}
            <div className="mb-4 flex flex-wrap gap-3" data-testid="close-shift-form">
              {[
                { label: 'Ending Cash (counted)', value: cash, set: setCash, placeholder: '' },
                { label: 'M-Pesa balance (optional)', value: mpesa, set: setMpesa, placeholder: 'Not recorded' },
                { label: 'Card settlement (optional)', value: card, set: setCard, placeholder: 'Not recorded' }
              ].map((field) => (
                <div key={field.label}>
                  <label className="mb-1 block text-lg font-medium text-slate-600">{field.label}</label>
                  <input
                    type="text"
                    readOnly
                    value={field.value}
                    placeholder={field.placeholder}
                    onClick={() => openFigure(field.value, field.set, field.label)}
                    onFocus={() => openFigure(field.value, field.set, field.label)}
                    className="h-12 w-48 rounded-lg border border-slate-300 px-3 text-xl focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
                  />
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-3">
              <button type="button" onClick={onCancel} className="h-12 rounded-lg border border-slate-300 px-5 text-lg text-slate-600 hover:bg-slate-50">
                Cancel
              </button>
              <button
                type="button"
                onClick={toReview}
                className="h-12 rounded-lg bg-rose-600 px-5 text-lg font-semibold text-white hover:bg-rose-700"
              >
                Review
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
