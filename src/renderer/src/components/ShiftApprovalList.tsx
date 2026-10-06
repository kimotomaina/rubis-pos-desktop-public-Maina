import { useEffect, useState } from 'react'
import type { ShiftApprovalRow, ShiftApprovalState } from '../../../main/services/reports.js'
import type { ReportScope } from '../../../main/lib/reportScope.js'
import { formatCurrency } from '../lib/currency.js'
import { shiftScopeLabel } from '../lib/reportScopeChoice.js'

interface ShiftApprovalListProps {
  scope: ReportScope
  /** Switches the whole page to this shift: approval happens only on a shift. */
  onOpenShift: (shift: ShiftApprovalRow, label: string) => void
}

const STATE_LABEL: Record<ShiftApprovalState, string> = {
  approved: 'Approved',
  'approved-earlier': 'Approved earlier',
  'not-approved': 'Not approved',
  'nothing-to-approve': 'Nothing to approve',
  open: 'Open'
}

const STATE_CLASS: Record<ShiftApprovalState, string> = {
  approved: 'bg-emerald-100 text-emerald-700',
  'approved-earlier': 'bg-emerald-50 text-emerald-700',
  'not-approved': 'bg-amber-100 text-amber-800',
  'nothing-to-approve': 'bg-slate-100 text-slate-600',
  open: 'bg-sky-100 text-sky-800'
}

/**
 * The shifts that have sales in a day, a week or a typed range, each with where its end-of-day approval stands
 * (docs/phase-246, the amendment). There is no approve button here: approval only ever happens on a shift, so each row
 * has one button that scopes the page to that shift, where the entries are and Approve is. A shift settled by a
 * per-day review before shifts were approved one by one reads "Approved earlier". The list is read from the main
 * process; nothing is worked out here.
 *
 * @param {ShiftApprovalListProps} props
 * @returns {JSX.Element}
 */
export default function ShiftApprovalList({ scope, onOpenShift }: ShiftApprovalListProps) {
  const [rows, setRows] = useState<ShiftApprovalRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const key = JSON.stringify(scope)

  useEffect(() => {
    let cancelled = false
    setRows(null)
    setError(null)
    void window.api.getEndOfDayShifts(scope).then((result) => {
      if (cancelled) return
      if (result.success && result.data) setRows(result.data)
      else setError(result.error ?? 'Failed to load the shifts')
    })
    return () => {
      cancelled = true
    }
    // The scope is compared by value: a new object with the same figures is the same scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  if (error) return <p className="rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">{error}</p>
  if (!rows) return <p className="text-base text-slate-400">Loading…</p>
  if (rows.length === 0) return <p className="text-base text-slate-500">No shift has sales in this range.</p>

  return (
    <div className="overflow-x-auto">
      <p className="mb-2 text-base text-slate-500">
        Approval is made on a shift. Open a shift to see its entries and approve them.
      </p>
      <table data-testid="shift-approval-list" className="w-full text-left text-base">
        <thead className="text-slate-500">
          <tr>
            <th className="py-2">Shift</th>
            <th className="py-2 text-right">Sales</th>
            <th className="py-2">Manual M-Pesa</th>
            <th className="py-2">State</th>
            <th className="py-2" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const label = shiftScopeLabel({ id: row.shiftId, windowType: row.windowType, openedAt: row.openedAt, closedAt: row.closedAt })
            return (
              <tr key={row.shiftId} className="border-t border-slate-100">
                <td className="py-2 pr-2 text-slate-800">{label}</td>
                <td className="py-2 pr-2 text-right text-slate-800">{row.orderCount}</td>
                <td className="py-2 pr-2 text-slate-600">
                  {row.manualCount === 0
                    ? 'No manual entries'
                    : row.pendingCount === 0
                      ? `${row.manualCount} entries, none waiting`
                      : `${row.pendingCount} of ${row.manualCount} waiting, ${formatCurrency(row.pendingAmount)}`}
                </td>
                <td className="py-2 pr-2">
                  <span className={`rounded-full px-2 py-1 text-sm font-medium ${STATE_CLASS[row.state]}`}>{STATE_LABEL[row.state]}</span>
                  {row.state === 'approved' && row.approvedByName && (
                    <span className="ml-2 text-sm text-slate-500">
                      by {row.approvedByName}, {new Date(row.approvedAt ?? '').toLocaleString()}
                    </span>
                  )}
                </td>
                <td className="py-2 text-right">
                  <button
                    type="button"
                    onClick={() => onOpenShift(row, label)}
                    className="h-10 rounded-lg border border-slate-300 px-3 text-base font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Open shift #{row.shiftId}
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
