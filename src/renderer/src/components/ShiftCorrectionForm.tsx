import { useState } from 'react'
import type { ZReport } from '../../../main/services/reports.js'
import { MPESA_BALANCE_INVALID, parseOptionalBalance, parseRequiredAmount } from '../lib/optionalBalance.js'
import { useKeyboardStore, type KeyboardMode } from '../stores/keyboardStore.js'
import ManagerPinModal from './ManagerPinModal.js'

const FIELD_CLASS =
  'h-11 w-full rounded-lg border border-slate-300 px-3 text-lg focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100'

interface ShiftCorrectionFormProps {
  /** The closed shift's Z report. Its latest correction, if any, is what the fields start from. */
  report: ZReport
  onCancel: () => void
  /** Called once the correction is recorded; the caller re-reads the Z report. */
  onCorrected: () => void
}

/** A figure as the field shows it: blank for "not recorded". */
const asText = (value: number | null | undefined): string => (value === null || value === undefined ? '' : String(value))

/**
 * Corrects the figures typed in for a closed shift (docs/phase-224): the starting cash, the counted cash and the
 * two optional M-Pesa balances. Nothing is edited: a correction is added under the shift's original figures, which
 * stay as they were, and the Z report shows both. The fields start from the current figures (the last correction's,
 * else the shift's own), a reason is required, and a manager PIN confirms. The main process re-checks everything.
 *
 * @param {ShiftCorrectionFormProps} props
 * @returns {JSX.Element}
 */
export default function ShiftCorrectionForm({ report, onCancel, onCorrected }: ShiftCorrectionFormProps) {
  const latest = report.corrections?.[report.corrections.length - 1]
  const [startingCash, setStartingCash] = useState(asText(latest ? latest.startingCash : report.startingCash))
  const [endingCash, setEndingCash] = useState(asText(latest ? latest.endingCash : report.endingCash))
  const [mpesaOpening, setMpesaOpening] = useState(
    asText(latest ? latest.mpesaOpeningBalance : report.mpesaOpeningBalance)
  )
  const [mpesaClosing, setMpesaClosing] = useState(
    asText(latest ? latest.mpesaClosingBalance : report.mpesaClosingBalance)
  )
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [collectingPin, setCollectingPin] = useState(false)
  const [saving, setSaving] = useState(false)

  const openField = (
    value: string,
    onChange: (next: string) => void,
    label: string,
    mode: KeyboardMode,
    maxLength?: number
  ): void => {
    useKeyboardStore.getState().open({ value, onChange, label, mode, maxLength })
  }

  const handleSubmit = (): void => {
    setError(null)
    if (parseRequiredAmount(startingCash) === null || parseRequiredAmount(endingCash) === null) {
      setError('Enter the starting cash and the counted ending cash')
      return
    }
    if (parseOptionalBalance(mpesaOpening) === 'invalid' || parseOptionalBalance(mpesaClosing) === 'invalid') {
      setError(MPESA_BALANCE_INVALID)
      return
    }
    if (reason.trim() === '') {
      setError('Say why the figures are being corrected')
      return
    }
    setCollectingPin(true)
  }

  const handleAuthorized = (managerId: number, managerPin: string): void => {
    setCollectingPin(false)
    const starting = parseRequiredAmount(startingCash)
    const ending = parseRequiredAmount(endingCash)
    const opening = parseOptionalBalance(mpesaOpening)
    const closing = parseOptionalBalance(mpesaClosing)
    if (starting === null || ending === null || opening === 'invalid' || closing === 'invalid') return

    void (async () => {
      setSaving(true)
      setError(null)
      try {
        const result = await window.api.correctShift({
          managerId,
          managerPin,
          shiftId: report.shiftId,
          startingCash: starting,
          endingCash: ending,
          mpesaOpeningBalance: opening,
          mpesaClosingBalance: closing,
          reason: reason.trim()
        })
        if (result.success) {
          onCorrected()
          return
        }
        setError(result.error ?? 'Failed to record this correction')
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to record this correction')
      } finally {
        setSaving(false)
      }
    })()
  }

  // The PIN dialog is a sibling of the form, not inside it: a click on its backdrop must close only itself.
  return (
    <>
      <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/50 p-4" onClick={onCancel}>
        <div className="w-full max-w-xl rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
          <h3 className="mb-1 text-2xl font-semibold text-slate-900">Correct the figures of shift #{report.shiftId}</h3>
          <p className="mb-3 text-base text-slate-500">
            The original figures stay on the report, and the correction is shown under them. It cannot be edited or
            removed afterwards.
          </p>

          {error && (
            <p role="alert" className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">
              {error}
            </p>
          )}

          <div className="mb-3 grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-base font-medium text-slate-600">Starting cash</label>
              <input
                readOnly
                value={startingCash}
                aria-label="Starting cash"
                onClick={() => openField(startingCash, setStartingCash, 'Starting cash', 'decimal')}
                className={FIELD_CLASS}
              />
            </div>
            <div>
              <label className="mb-1 block text-base font-medium text-slate-600">Ending cash (counted)</label>
              <input
                readOnly
                value={endingCash}
                aria-label="Ending cash (counted)"
                onClick={() => openField(endingCash, setEndingCash, 'Ending cash (counted)', 'decimal')}
                className={FIELD_CLASS}
              />
            </div>
            <div>
              <label className="mb-1 block text-base font-medium text-slate-600">M-Pesa at start (optional)</label>
              <input
                readOnly
                value={mpesaOpening}
                placeholder="Not recorded"
                aria-label="M-Pesa balance at start (optional)"
                onClick={() => openField(mpesaOpening, setMpesaOpening, 'M-Pesa balance at start (optional)', 'decimal')}
                className={FIELD_CLASS}
              />
            </div>
            <div>
              <label className="mb-1 block text-base font-medium text-slate-600">M-Pesa at end (optional)</label>
              <input
                readOnly
                value={mpesaClosing}
                placeholder="Not recorded"
                aria-label="M-Pesa balance at end (optional)"
                onClick={() => openField(mpesaClosing, setMpesaClosing, 'M-Pesa balance at end (optional)', 'decimal')}
                className={FIELD_CLASS}
              />
            </div>
          </div>

          <label className="mb-1 block text-base font-medium text-slate-600">Why are the figures being corrected?</label>
          <input
            readOnly
            value={reason}
            aria-label="Reason"
            placeholder="e.g. counted cash was typed as 1480, it was 1840"
            onClick={() => openField(reason, setReason, 'Reason for this correction', 'text', 300)}
            className={`${FIELD_CLASS} mb-4`}
          />

          <div className="flex gap-3">
            <button
              type="button"
              onClick={onCancel}
              className="h-12 flex-1 rounded-xl border border-slate-300 text-lg font-medium text-slate-600 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={handleSubmit}
              className="h-12 flex-1 rounded-xl bg-rose-600 text-lg font-semibold text-white transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? 'Recording…' : 'Record correction'}
            </button>
          </div>
        </div>

      </div>
      {collectingPin && (
        <ManagerPinModal
          title={`Correct the figures of shift #${report.shiftId}. The original stays on the report.`}
          onAuthorized={handleAuthorized}
          onCancel={() => setCollectingPin(false)}
        />
      )}
    </>
  )
}
