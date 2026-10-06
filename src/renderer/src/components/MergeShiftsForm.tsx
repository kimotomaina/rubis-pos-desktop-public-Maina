import { useEffect, useState } from 'react'
import type { ShiftMergePreview, ShiftRow } from '../../../main/services/database.js'
import type { WindowReport } from '../../../main/services/window-report.js'
import { formatCurrency } from '../lib/currency.js'
import { useKeyboardStore } from '../stores/keyboardStore.js'
import ManagerPinModal from './ManagerPinModal.js'

const FIELD_CLASS =
  'h-11 w-full rounded-lg border border-slate-300 px-3 text-lg focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100'

interface MergeShiftsFormProps {
  /** The closed shift to absorb; it must carry its window (`window_type`, `window_date`). */
  shift: ShiftRow
  onCancel: () => void
  /** Called once the shifts are merged, with the sentence to show on the history screen. */
  onMerged: (message: string) => void
}

/**
 * @param {number | null | undefined} amount
 * @returns {string}
 */
function moneyOrDash(amount: number | null | undefined): string {
  return amount === null || amount === undefined ? 'Not applicable' : formatCurrency(amount)
}

/**
 * Merges one closed shift into another of the same window (docs/phase-239). The admin picks the surviving shift
 * from the window's other shifts, sees how many sales move and what the survivor would show afterwards, gives a
 * reason and their PIN. No figure is typed: the survivor keeps its own float and count, and a recount afterwards is
 * a correction. The absorbed shift's figures stay as history. There is no undo; a sale can be moved back one at a
 * time. The main process re-checks every rule inside the transaction that writes.
 *
 * @param {MergeShiftsFormProps} props
 * @returns {JSX.Element}
 */
export default function MergeShiftsForm({ shift, onCancel, onMerged }: MergeShiftsFormProps) {
  const [candidates, setCandidates] = useState<WindowReport['shifts'] | null>(null)
  const [intoShiftId, setIntoShiftId] = useState<number | null>(null)
  const [preview, setPreview] = useState<ShiftMergePreview | null>(null)
  const [reason, setReason] = useState('')
  const [collectingPin, setCollectingPin] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!shift.window_type || !shift.window_date) {
      setError('The window of this shift cannot be read')
      setCandidates([])
      return
    }
    void window.api.getWindowReport(shift.window_type, shift.window_date).then((result) => {
      if (cancelled) return
      if (result.success && result.data) {
        setCandidates(result.data.shifts.filter((entry) => entry.report.shiftId !== shift.id && !entry.report.mergedInto))
      } else {
        setError(result.error ?? 'Failed to read the window')
        setCandidates([])
      }
    })
    return () => {
      cancelled = true
    }
  }, [shift.id, shift.window_type, shift.window_date])

  const choose = async (targetId: number): Promise<void> => {
    setIntoShiftId(targetId)
    setPreview(null)
    setError(null)
    try {
      const result = await window.api.previewShiftMerge(shift.id, targetId)
      if (result.success && result.data) setPreview(result.data)
      else setError(result.error ?? 'Failed to check this merge')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to check this merge')
    }
  }

  const handleMerge = (): void => {
    setError(null)
    if (!preview || preview.problem) {
      setError(preview?.problem ?? 'Choose the shift to merge into')
      return
    }
    if (reason.trim() === '') {
      setError('Say why these shifts are being merged')
      return
    }
    setCollectingPin(true)
  }

  const handleAuthorized = (managerId: number, managerPin: string): void => {
    setCollectingPin(false)
    if (intoShiftId === null) return
    void (async () => {
      setSaving(true)
      try {
        const result = await window.api.mergeShifts({ managerId, managerPin, absorbedShiftId: shift.id, intoShiftId, reason: reason.trim() })
        if (result.success && result.data) {
          onMerged(
            `Shift #${result.data.absorbedShiftId} merged into shift #${result.data.intoShiftId}: ${result.data.salesCount} ${
              result.data.salesCount === 1 ? 'sale' : 'sales'
            } moved.`
          )
          return
        }
        setError(result.error ?? 'Failed to merge these shifts')
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to merge these shifts')
      } finally {
        setSaving(false)
      }
    })()
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-2xl font-bold text-slate-800">Merge shift #{shift.id} into another shift</h3>
        <button
          type="button"
          onClick={onCancel}
          className="h-10 rounded-lg border border-slate-300 px-4 text-base font-medium text-slate-600 hover:bg-slate-50"
        >
          Cancel
        </button>
      </div>
      <p className="mb-3 text-base text-slate-600">
        Every sale of shift #{shift.id} moves to the shift you choose, which keeps its own float and counted cash. Shift #
        {shift.id} keeps its figures as history and is marked merged. Only an admin can do this, with a reason and their
        PIN, and it cannot be undone: a sale can be moved back one at a time. To change a counted figure afterwards, use
        Correct figures.
      </p>
      {error && <p role="alert" className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">{error}</p>}

      <p className="mb-1 text-base font-medium text-slate-600">Merge into</p>
      {candidates === null ? (
        <p className="mb-3 text-base text-slate-400">Loading the window's shifts…</p>
      ) : candidates.length === 0 ? (
        <p className="mb-3 text-base text-slate-500">No other shift in this window to merge into.</p>
      ) : (
        <div className="mb-3 flex flex-wrap gap-2">
          {candidates.map(({ report }) => (
            <button
              key={report.shiftId}
              type="button"
              onClick={() => void choose(report.shiftId)}
              className={`h-11 rounded-lg px-4 text-base font-semibold transition ${
                intoShiftId === report.shiftId ? 'bg-rose-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              Shift #{report.shiftId} · {report.status === 'open' ? 'open' : 'closed'} · {report.orderCount}{' '}
              {report.orderCount === 1 ? 'order' : 'orders'}
            </button>
          ))}
        </div>
      )}

      {preview && !preview.problem && (
        <div className="mb-3 rounded-lg bg-slate-50 p-3 text-base text-slate-700" data-testid="merge-preview">
          <p className="font-medium">
            {preview.salesCount} {preview.salesCount === 1 ? 'sale' : 'sales'} ({formatCurrency(preview.salesTotal)}) move from shift #
            {preview.absorbedShiftId} to shift #{preview.intoShiftId}.
          </p>
          <p className="mt-2 font-semibold">Shift #{preview.intoShiftId} afterwards</p>
          <p>Expected cash: {moneyOrDash(preview.into?.expectedCash)}</p>
          <p>Difference: {moneyOrDash(preview.into?.discrepancy)}</p>
        </div>
      )}
      {preview?.problem && <p className="mb-3 text-base font-medium text-rose-700">{preview.problem}</p>}

      <label className="mb-1 block text-base font-medium text-slate-600">Why are these shifts being merged?</label>
      <input
        readOnly
        value={reason}
        aria-label="Reason"
        onClick={() => useKeyboardStore.getState().open({ value: reason, onChange: setReason, label: 'Reason for merging', mode: 'text', maxLength: 300 })}
        className={`${FIELD_CLASS} mb-3`}
      />
      <button
        type="button"
        disabled={saving}
        onClick={handleMerge}
        className="h-12 w-full rounded-xl bg-rose-600 text-lg font-semibold text-white transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {saving ? 'Merging…' : 'Merge shifts'}
      </button>

      {collectingPin && intoShiftId !== null && (
        <ManagerPinModal
          title={`Merge shift #${shift.id} into shift #${intoShiftId}. This cannot be undone.`}
          onAuthorized={handleAuthorized}
          onCancel={() => setCollectingPin(false)}
        />
      )}
    </div>
  )
}
