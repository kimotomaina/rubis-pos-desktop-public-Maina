import { useEffect, useState } from 'react'
import type { ShiftType } from '../lib/shiftWindows.js'
import type { WindowReport } from '../../../main/services/window-report.js'
import { formatCurrency } from '../lib/currency.js'
import { CloseIcon } from './icons.js'

interface WindowReportModalProps {
  type: ShiftType
  startDate: string
  onClose: () => void
  /** Opens one shift's own Z report. */
  onOpenShift: (shiftId: number) => void
}

/**
 * The combined report of one Day or Night window that holds more than one shift (docs/phase-231, S10): each shift
 * with its own figures, then the sums that are safe to add. Starting, expected and counted cash are never added
 * across shifts: a drawer that carries over would be counted twice. On screen only; the printed form comes with the
 * Z report layout.
 *
 * @param {WindowReportModalProps} props
 * @returns {JSX.Element}
 */
export default function WindowReportModal({ type, startDate, onClose, onOpenShift }: WindowReportModalProps) {
  const [report, setReport] = useState<WindowReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.api.getWindowReport(type, startDate).then((result) => {
      if (cancelled) return
      if (result.success && result.data) setReport(result.data)
      else setError(result.error ?? 'Failed to build the window report')
    })
    return () => {
      cancelled = true
    }
  }, [type, startDate])

  return (
    <div role="dialog" aria-label="Window report" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-6">
      <div className="w-full max-w-3xl rounded-2xl bg-white p-5 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-xl font-semibold text-slate-900">{report?.window.name ?? 'Window report'}</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-full p-2 text-slate-400 hover:bg-slate-100">
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>
        {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">{error}</p>}
        {!report && !error && <p className="text-base text-slate-400">Loading…</p>}
        {report && (
          <>
            <table className="mb-3 w-full text-left text-base">
              <thead className="text-slate-500">
                <tr>
                  <th className="py-1">Shift</th>
                  <th className="py-1">Orders</th>
                  <th className="py-1">Revenue</th>
                  <th className="py-1">Starting</th>
                  <th className="py-1">Counted</th>
                  <th className="py-1">Difference</th>
                </tr>
              </thead>
              <tbody>
                {report.shifts.map(({ report: shift, difference }) => (
                  <tr
                    key={shift.shiftId}
                    onClick={() => onOpenShift(shift.shiftId)}
                    className="cursor-pointer border-t border-slate-100 hover:bg-slate-50"
                  >
                    <td className="py-1 text-slate-800">#{shift.shiftId}</td>
                    <td className="py-1">{shift.orderCount}</td>
                    <td className="py-1">{formatCurrency(shift.totalRevenue)}</td>
                    <td className="py-1">{shift.cashNotCounted ? 'Not counted' : formatCurrency(shift.startingCash)}</td>
                    <td className="py-1">
                      {shift.cashNotCounted || shift.endingCash === null ? 'Not counted' : formatCurrency(shift.endingCash)}
                    </td>
                    <td className="py-1">{difference === null ? 'Not counted' : formatCurrency(difference)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="space-y-1 rounded-lg bg-slate-50 p-3 text-base">
              <p className="font-semibold text-slate-800">Whole window</p>
              <p>
                {report.totals.orderCount} orders, {formatCurrency(report.totals.totalRevenue)} (cash{' '}
                {formatCurrency(report.totals.byMethod.cash)}, M-Pesa {formatCurrency(report.totals.byMethod.mpesa)}, card{' '}
                {formatCurrency(report.totals.byMethod.card)})
              </p>
              <p>
                Sum of the shifts&apos; differences: {formatCurrency(report.totals.differenceSum)}
                {report.totals.notCountedShifts > 0 &&
                  `. ${report.totals.notCountedShifts} ${report.totals.notCountedShifts === 1 ? 'shift' : 'shifts'} not counted.`}
              </p>
              <p className="text-sm text-slate-500">
                Starting, expected and counted cash are not added across shifts: a drawer carried over would count twice.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
