import { useEffect, useState } from 'react'
import type { PastShiftPreview, UnattachedDay } from '../../../main/services/past-shifts.js'
import { formatCurrency } from '../lib/currency.js'
import { MPESA_BALANCE_INVALID, parseOptionalBalance, parseRequiredAmount } from '../lib/optionalBalance.js'
import { paginate } from '../lib/paginate.js'
import { nairobiMinuteText, periodEdgeToIso } from '../lib/pastShiftPeriod.js'
import { SHIFT_TYPES, shiftWindowLabel, type ShiftType } from '../lib/shiftWindows.js'
import { useKeyboardStore, type KeyboardMode } from '../stores/keyboardStore.js'
import ManagerPinModal from './ManagerPinModal.js'

/** Sales listed per page: the form never scrolls, so a long list is paged. */
const SALES_PER_PAGE = 4

const FIELD_CLASS =
  'h-11 w-full rounded-lg border border-slate-300 px-3 text-lg focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100'

interface PastShiftFormProps {
  /** The day whose sales with no shift this form starts from; the manager may widen the period. */
  day: UnattachedDay
  onCancel: () => void
  /** Called once the shift is recorded, with the sentence to show on the history screen. */
  onRecorded: (message: string) => void
}

/**
 * Records a shift for a period that already happened (docs/phase-223): the sales that had no shift are shown
 * exactly as they will be attached, the cash (and optional M-Pesa) figures are entered, a reason is required, and
 * a manager PIN confirms. The main process re-checks every rule inside the transaction that writes; what this
 * screen shows is a courtesy and is never the guard.
 *
 * Fits the design box with no scrolling: two columns, the sales list paged.
 *
 * @param {PastShiftFormProps} props
 * @returns {JSX.Element}
 */
export default function PastShiftForm({ day, onCancel, onRecorded }: PastShiftFormProps) {
  const [startText, setStartText] = useState(() => nairobiMinuteText(day.firstAt))
  const [endText, setEndText] = useState(() => nairobiMinuteText(day.lastAt))
  const [preview, setPreview] = useState<PastShiftPreview | null>(null)
  const [periodError, setPeriodError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [page, setPage] = useState(1)

  const [shiftType, setShiftType] = useState<ShiftType>('day')
  const [typeTouched, setTypeTouched] = useState(false)
  const [startingCash, setStartingCash] = useState('')
  const [endingCash, setEndingCash] = useState('')
  const [mpesaOpening, setMpesaOpening] = useState('')
  const [mpesaClosing, setMpesaClosing] = useState('')
  const [reason, setReason] = useState('')

  const [error, setError] = useState<string | null>(null)
  const [collectingPin, setCollectingPin] = useState(false)
  const [saving, setSaving] = useState(false)

  const startIso = periodEdgeToIso(startText, 'start')
  const endIso = periodEdgeToIso(endText, 'end')

  useEffect(() => {
    let cancelled = false
    setPage(1)
    if (!startIso || !endIso) {
      setPreview(null)
      setPeriodError('Enter the start and the end as YYYY-MM-DD HH:MM, Nairobi time')
      return
    }
    setPeriodError(null)
    void window.api.previewPastShift(startIso, endIso).then((result) => {
      if (cancelled) return
      if (result.success && result.data) {
        setPreview(result.data)
        if (!typeTouched) setShiftType(result.data.suggestedShiftType)
      } else {
        setPreview(null)
        setPeriodError(result.error ?? 'Failed to read the sales in this period')
      }
    })
    return () => {
      cancelled = true
    }
    // typeTouched only decides whether the label follows the start; it must not refetch the preview.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startIso, endIso, refreshKey])

  const openField = (
    value: string,
    onChange: (next: string) => void,
    label: string,
    mode: KeyboardMode,
    maxLength?: number
  ): void => {
    useKeyboardStore.getState().open({ value, onChange, label, mode, maxLength })
  }

  const problem = periodError ?? preview?.problem ?? null

  /** Checks everything the screen can check, then asks for the manager's PIN. */
  const handleRecord = (): void => {
    setError(null)
    if (!preview || problem) {
      setError(problem ?? 'Choose a period first')
      return
    }
    if (parseRequiredAmount(startingCash) === null || parseRequiredAmount(endingCash) === null) {
      setError('Enter the starting cash and the counted ending cash')
      return
    }
    if (parseOptionalBalance(mpesaOpening) === 'invalid' || parseOptionalBalance(mpesaClosing) === 'invalid') {
      setError(MPESA_BALANCE_INVALID)
      return
    }
    if (reason.trim() === '') {
      setError('Say why this shift is being recorded after the fact')
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
    if (!preview || !startIso || !endIso || starting === null || ending === null) return
    if (opening === 'invalid' || closing === 'invalid') return

    void (async () => {
      setSaving(true)
      setError(null)
      try {
        const result = await window.api.createPastShift({
          managerId,
          managerPin,
          startIso,
          endIso,
          orderIds: preview.sales.map((sale) => sale.id),
          startingCash: starting,
          endingCash: ending,
          mpesaOpeningBalance: opening,
          mpesaClosingBalance: closing,
          shiftType,
          reason: reason.trim()
        })
        if (result.success && result.data) {
          onRecorded(
            `Shift #${result.data.shiftId} recorded for ${result.data.attachedCount} ${
              result.data.attachedCount === 1 ? 'sale' : 'sales'
            }.`
          )
          return
        }
        setError(result.error ?? 'Failed to record this shift')
        // A refusal may mean the list went stale: show what is there now.
        setRefreshKey((key) => key + 1)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to record this shift')
      } finally {
        setSaving(false)
      }
    })()
  }

  const sales = paginate(preview?.sales ?? [], page, SALES_PER_PAGE)

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-2xl font-bold text-slate-800">Record a shift for {day.localDay}</h3>
        <button
          type="button"
          onClick={onCancel}
          className="h-10 rounded-lg border border-slate-300 px-4 text-base font-medium text-slate-600 hover:bg-slate-50"
        >
          Cancel
        </button>
      </div>

      {error && (
        <p role="alert" className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">
          {error}
        </p>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="mb-2 grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-base font-medium text-slate-600">From (Nairobi)</label>
              <input
                readOnly
                value={startText}
                aria-label="Period start"
                onClick={() => openField(startText, setStartText, 'Period start, YYYY-MM-DD HH:MM', 'text', 16)}
                className={FIELD_CLASS}
              />
            </div>
            <div>
              <label className="mb-1 block text-base font-medium text-slate-600">To (end of that minute)</label>
              <input
                readOnly
                value={endText}
                aria-label="Period end"
                onClick={() => openField(endText, setEndText, 'Period end, YYYY-MM-DD HH:MM', 'text', 16)}
                className={FIELD_CLASS}
              />
            </div>
          </div>

          {problem ? (
            <p role="status" className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-base font-medium text-amber-800">
              {problem}
            </p>
          ) : preview ? (
            <p role="status" className="mb-2 text-base text-slate-600">
              {preview.count} {preview.count === 1 ? 'sale' : 'sales'}, {formatCurrency(preview.total)}. Cash{' '}
              {formatCurrency(preview.totalsByMethod.cash)}, M-Pesa {formatCurrency(preview.totalsByMethod.mpesa)},
              card {formatCurrency(preview.totalsByMethod.card)}.
            </p>
          ) : (
            <p className="mb-2 text-base text-slate-400">Loading…</p>
          )}

          {preview && preview.count > 0 && (
            <>
              <table className="w-full text-left text-base">
                <thead className="text-slate-500">
                  <tr>
                    <th className="py-1">Sale</th>
                    <th className="py-1">Time</th>
                    <th className="py-1">Paid by</th>
                    <th className="py-1 text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {sales.items.map((sale) => (
                    <tr key={sale.id} className="border-t border-slate-100">
                      <td className="py-1 text-slate-800">#{sale.id}</td>
                      <td className="py-1 text-slate-500">{nairobiMinuteText(sale.createdAt).slice(11)}</td>
                      <td className="py-1 text-slate-500">{sale.method ?? ''}</td>
                      <td className="py-1 text-right text-slate-800">{formatCurrency(sale.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {sales.pageCount > 1 && (
                <div className="mt-2 flex items-center justify-between gap-3">
                  <button
                    type="button"
                    disabled={!sales.hasPrev}
                    onClick={() => setPage(sales.page - 1)}
                    className="h-10 rounded-lg border border-slate-300 px-3 text-base font-medium text-slate-600 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Previous
                  </button>
                  <span className="text-base text-slate-500">
                    Page {sales.page} of {sales.pageCount}
                  </span>
                  <button
                    type="button"
                    disabled={!sales.hasNext}
                    onClick={() => setPage(sales.page + 1)}
                    className="h-10 rounded-lg border border-slate-300 px-3 text-base font-medium text-slate-600 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        <div>
          <div role="radiogroup" aria-label="Shift" className="mb-2 flex flex-wrap gap-2">
            {SHIFT_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                role="radio"
                aria-checked={shiftType === type}
                onClick={() => {
                  setShiftType(type)
                  setTypeTouched(true)
                }}
                className={`rounded-lg border px-3 py-2 text-base font-medium ${
                  shiftType === type
                    ? 'border-rose-500 bg-rose-50 text-rose-700'
                    : 'border-slate-300 text-slate-600 hover:bg-slate-50'
                }`}
              >
                {shiftWindowLabel(type)}
              </button>
            ))}
          </div>

          <div className="mb-2 grid grid-cols-2 gap-2">
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

          <label className="mb-1 block text-base font-medium text-slate-600">Why is this recorded after the fact?</label>
          <input
            readOnly
            value={reason}
            aria-label="Reason"
            placeholder="e.g. till was used without opening a shift"
            onClick={() => openField(reason, setReason, 'Reason for recording this shift now', 'text', 300)}
            className={`${FIELD_CLASS} mb-3`}
          />

          <button
            type="button"
            disabled={saving}
            onClick={handleRecord}
            className="h-12 w-full rounded-xl bg-rose-600 text-lg font-semibold text-white transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? 'Recording…' : 'Record shift'}
          </button>
        </div>
      </div>

      {collectingPin && (
        <ManagerPinModal
          title={`Record a shift for ${preview?.count ?? 0} ${preview?.count === 1 ? 'sale' : 'sales'} on ${day.localDay}. It cannot be edited afterwards.`}
          onAuthorized={handleAuthorized}
          onCancel={() => setCollectingPin(false)}
        />
      )}
    </div>
  )
}
