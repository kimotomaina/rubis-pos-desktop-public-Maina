import { useEffect, useState } from 'react'
import type { ShiftRow } from '../../../main/services/database.js'
import type { ShiftType } from '../lib/shiftWindows.js'
import type {
  ZReport,
  SalesSummary,
  FiscalStatusDayCount,
  FiscalReconciliationReport
} from '../../../main/services/reports.js'
import type { ReportScope } from '../../../main/lib/reportScope.js'
import { formatCurrency } from '../lib/currency.js'
import { titleCaseName } from '../lib/text.js'
import { formatVatRateLabel } from '../lib/vatLabel.js'
import { paginate } from '../lib/paginate.js'
import { DEFAULT_SCOPE, scopeTitle, toReportScope, type ScopeChoice } from '../lib/reportScopeChoice.js'
import ZReportModal from '../components/ZReportModal.js'
import ZReportBlock from '../components/ZReportBlock.js'
import MoveSaleForm from '../components/MoveSaleForm.js'
import MergeShiftsForm from '../components/MergeShiftsForm.js'
import WindowReportModal from '../components/WindowReportModal.js'
import ScopePicker from '../components/ScopePicker.js'
import ShiftEndOfDay from '../components/ShiftEndOfDay.js'
import ShiftApprovalList from '../components/ShiftApprovalList.js'
import MpesaLogsPage from './MpesaLogsPage.js'

/** Orders/shifts per page — matches the server-side `REPORTS_PAGE_SIZE` in `index.ts`. */
const REPORTS_PAGE_SIZE = 10

/** Fiscal-status rows per page — this table is paginated client-side (a month is at most 31 rows). */
const FISCAL_ROWS_PER_PAGE = 10

/** Fiscal-reconciliation rows per page — the whole range is fetched at once (docs/phase-163) and paginated client-side, like {@link FISCAL_ROWS_PER_PAGE}. */
const RECONCILIATION_ROWS_PER_PAGE = 10

/** Shared Previous/Next pager, matching `EndOfDayPage.tsx`'s own control. */
function Pager({
  page,
  pageCount,
  onChange
}: {
  page: number
  pageCount: number
  onChange: (page: number) => void
}) {
  if (pageCount <= 1) return null
  return (
    <div className="mt-3 flex shrink-0 items-center justify-between gap-3">
      <button
        type="button"
        onClick={() => onChange(page - 1)}
        disabled={page <= 1}
        className="h-10 rounded-lg border border-slate-300 px-3 text-base font-medium text-slate-600 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Previous
      </button>
      <span className="text-base text-slate-500">
        Page {page} of {pageCount}
      </span>
      <button
        type="button"
        onClick={() => onChange(page + 1)}
        disabled={page >= pageCount}
        className="h-10 rounded-lg border border-slate-300 px-3 text-base font-medium text-slate-600 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Next
      </button>
    </div>
  )
}

/**
 * Shift history: ten shifts a page, newest first (docs/phase-245), tap a row to open its Z-report (with the
 * existing, unchanged Reprint action inside `ZReportModal`).
 *
 * Opening it gives every sale with no shift to the shift it belongs to (docs/phase-232), so there is no list of
 * sales with no shift to work through. A shift is shown by its window; an older one labelled otherwise says so. A
 * window that holds more than one shift (older data) has a combined report. An admin can move a sale to another
 * shift, with a reason and their PIN.
 *
 * The page always opens on page 1 and the main process returns one page and the total. The title, Move a sale and the
 * pager stay in view while the rows scroll in their own area (the End of Day pattern, docs/phase-220).
 */
function ShiftHistoryView({ staffName }: { staffName: (id: number) => string }) {
  const [page, setPage] = useState(1)
  const [data, setData] = useState<{ shifts: ShiftRow[]; total: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [openReport, setOpenReport] = useState<ZReport | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const [windowReport, setWindowReport] = useState<{ type: ShiftType; startDate: string } | null>(null)
  const [moving, setMoving] = useState(false)
  // docs/phase-239: the row actions. `merging` holds the shift being absorbed; `openCorrecting` opens the Z report on its form.
  const [merging, setMerging] = useState<ShiftRow | null>(null)
  const [openCorrecting, setOpenCorrecting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void (async () => {
      // docs/phase-232: every sale with no shift is given to its shift before the list is read. A failure is logged
      // by the main process and never stops the history showing.
      try {
        await window.api.autoAssignSales?.()
      } catch {
        // The history is still shown.
      }
      const result = await window.api.getShiftsList(page)
      if (cancelled) return
      if (result.success && result.data) {
        setData({ shifts: result.data.shifts, total: result.data.total })
      } else {
        setError(result.error ?? 'Failed to load shift history')
      }
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [page, reloadKey])

  const openShift = async (shiftId: number, correcting = false): Promise<void> => {
    setOpenError(null)
    setOpenCorrecting(correcting)
    const result = await window.api.getZReport(shiftId)
    if (result.success && result.data) {
      setOpenReport(result.data)
    } else {
      setOpenError(result.error ?? 'Failed to open this shift’s Z-report')
    }
  }

  const pageCount = Math.max(1, Math.ceil((data?.total ?? 0) / REPORTS_PAGE_SIZE))

  if (merging) {
    return (
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <MergeShiftsForm
          shift={merging}
          onCancel={() => setMerging(null)}
          onMerged={(message) => {
            setMerging(null)
            setNotice(message)
            setReloadKey((key) => key + 1)
          }}
        />
      </section>
    )
  }

  if (moving) {
    // docs/phase-246, R1: a column of the height given, so the form's body scrolls and its buttons stay in view.
    return (
      <section className="flex h-[34rem] flex-col rounded-xl border border-slate-200 bg-white">
        <MoveSaleForm
          onCancel={() => setMoving(false)}
          onMoved={(message) => {
            setMoving(false)
            setNotice(message)
            setReloadKey((key) => key + 1)
          }}
        />
      </section>
    )
  }

  // docs/phase-246: the page scrolls as a whole, so the history is a box of its own height: its rows scroll inside it while the
  // title, Move a sale and the pager stay in view (docs/phase-245).
  return (
    <section className="flex h-[34rem] flex-col rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-3 flex shrink-0 items-center justify-between gap-3">
        <h3 className="text-2xl font-bold text-slate-800">Shift History</h3>
        <button
          type="button"
          onClick={() => {
            setNotice(null)
            setMoving(true)
          }}
          className="h-10 rounded-lg border border-slate-300 px-4 text-base font-medium text-slate-600 hover:bg-slate-50"
        >
          Move a sale
        </button>
      </div>
      {notice && (
        <p role="status" className="mb-3 rounded-lg bg-emerald-50 px-3 py-2 text-base font-medium text-emerald-700">
          {notice}
        </p>
      )}
      {error && (
        <p className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">{error}</p>
      )}
      {openError && (
        <p className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">{openError}</p>
      )}
      {loading || !data ? (
        <p className="text-base text-slate-400">Loading…</p>
      ) : data.shifts.length === 0 ? (
        <p className="text-base text-slate-500">No shifts recorded yet.</p>
      ) : (
        <>
          <div data-testid="shift-history-scroll" className="touch-scrollbar min-h-0 flex-1 overflow-auto pr-2">
            <table className="w-full text-left text-base">
              <thead className="text-slate-500">
                <tr>
                  <th className="py-2">Shift</th>
                  <th className="py-2">Opened</th>
                  <th className="py-2">Closed</th>
                  <th className="py-2">Cashier</th>
                  <th className="py-2">Status</th>
                  <th className="py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.shifts.map((shift) => (
                  <tr
                    key={shift.id}
                    onClick={() => void openShift(shift.id)}
                    className="cursor-pointer border-t border-slate-100 hover:bg-slate-50"
                  >
                    <td className="py-2 pr-2 text-slate-800">
                      #{shift.id}
                      {shift.window_type && (
                        <span className="ml-2 text-sm text-slate-500">{shift.window_type === 'day' ? 'Day' : 'Night'}</span>
                      )}
                      {shift.labelled_as && (
                        <span className="ml-2 text-sm text-slate-500">
                          Labelled {shift.labelled_as === 'day' ? 'Day' : 'Night'} when opened
                        </span>
                      )}
                      {/* docs/phase-242: a window shows once. The shifts merged into this one are named here, each opening its own Z report. */}
                      {(shift.absorbed_shifts ?? []).map((absorbed) => (
                        <button
                          key={absorbed.id}
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation()
                            void openShift(absorbed.id)
                          }}
                          className="ml-2 rounded-full bg-amber-100 px-2 py-1 text-sm font-medium text-amber-800 hover:bg-amber-200"
                        >
                          includes #{absorbed.id}
                        </button>
                      ))}
                    </td>
                    <td className="py-2 pr-2 text-slate-500">{new Date(shift.clock_in).toLocaleString()}</td>
                    <td className="py-2 pr-2 text-slate-500">
                      {shift.clock_out ? new Date(shift.clock_out).toLocaleString() : 'In progress'}
                    </td>
                    <td className="py-2 pr-2 text-slate-800">
                      {shift.staff_id === 0 ? 'Created automatically' : staffName(shift.staff_id)}
                    </td>
                    <td className="py-2">
                      <span
                        className={`rounded-full px-2 py-1 text-sm font-medium ${
                          shift.status === 'open'
                            ? 'bg-emerald-100 text-emerald-700'
                            : 'bg-slate-100 text-slate-600'
                        }`}
                      >
                        {shift.status}
                      </span>
                      {shift.kind === 'retrospective' && shift.staff_id !== 0 && (
                        <span className="ml-2 rounded-full bg-amber-100 px-2 py-1 text-sm font-medium text-amber-800">
                          Recorded later
                        </span>
                      )}
                      {shift.cash_not_counted === 1 && (
                        <span className="ml-2 rounded-full bg-slate-100 px-2 py-1 text-sm font-medium text-slate-600">
                          Cash not counted
                        </span>
                      )}
                      {shift.merged_into != null && (
                        <span className="ml-2 rounded-full bg-amber-100 px-2 py-1 text-sm font-medium text-amber-800">
                          Merged into #{shift.merged_into}
                        </span>
                      )}
                      {(shift.window_shift_count ?? 1) > 1 && shift.window_type && shift.window_date && (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation()
                            setWindowReport({ type: shift.window_type as ShiftType, startDate: shift.window_date as string })
                          }}
                          className="ml-2 rounded-full bg-sky-100 px-2 py-1 text-sm font-medium text-sky-800 hover:bg-sky-200"
                        >
                          Window report ({shift.window_shift_count} shifts)
                        </button>
                      )}
                    </td>
                    {/* docs/phase-239: the actions of one shift. A merged shift is history: its Z report opens, nothing else. */}
                    <td className="py-2">
                      <div className="flex flex-wrap gap-1">
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation()
                            void openShift(shift.id)
                          }}
                          className="h-9 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-600 hover:bg-slate-50"
                        >
                          Z report
                        </button>
                        {shift.frozen && (
                          <span
                            title="Only the latest closed shift can be corrected or be given sales."
                            className="flex h-9 items-center rounded-lg bg-slate-100 px-3 text-sm font-medium text-slate-500"
                          >
                            Locked
                          </span>
                        )}
                        {shift.status === 'closed' && shift.merged_into == null && (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation()
                              void openShift(shift.id, true)
                            }}
                            className="h-9 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-600 hover:bg-slate-50"
                          >
                            Correct figures
                          </button>
                        )}
                        {shift.status === 'closed' && shift.merged_into == null && (shift.window_shift_count ?? 1) > 1 && (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation()
                              setNotice(null)
                              setMerging(shift)
                            }}
                            className="h-9 rounded-lg border border-amber-300 px-3 text-sm font-medium text-amber-800 hover:bg-amber-50"
                          >
                            Merge into…
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={page} pageCount={pageCount} onChange={setPage} />
        </>
      )}
      {openReport && (
        <ZReportModal
          report={openReport}
          startCorrecting={openCorrecting}
          onClose={() => {
            setOpenReport(null)
            setOpenCorrecting(false)
            setReloadKey((key) => key + 1)
          }}
        />
      )}
      {windowReport && (
        <WindowReportModal
          type={windowReport.type}
          startDate={windowReport.startDate}
          onClose={() => setWindowReport(null)}
          onOpenShift={(shiftId) => {
            setWindowReport(null)
            void openShift(shiftId)
          }}
        />
      )}
    </section>
  )
}

/**
 * The sales summary's figures (docs/phase-158), exactly as the main process returned them: nothing is added up here
 * (docs/phase-246, the first rule of the phase).
 *
 * @param {{ summary: SalesSummary }} props
 * @returns {JSX.Element}
 */
function SalesSummaryCards({ summary }: { summary: SalesSummary }) {
  return (
    <div>
      <p className="mb-2 text-base text-slate-500">{summary.label}</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-lg bg-slate-50 p-3">
          <p className="text-sm text-slate-500">Orders</p>
          <p className="text-xl font-semibold text-slate-900">{summary.orderCount}</p>
        </div>
        <div className="rounded-lg bg-slate-50 p-3">
          <p className="text-sm text-slate-500">Revenue</p>
          <p className="text-xl font-semibold text-slate-900">{formatCurrency(summary.totalRevenue)}</p>
        </div>
        <div className="rounded-lg bg-slate-50 p-3">
          <p className="text-sm text-slate-500">{formatVatRateLabel(summary.vatRate)}</p>
          <p className="text-xl font-semibold text-slate-900">{formatCurrency(summary.vatIncluded)}</p>
        </div>
        <div className="rounded-lg bg-slate-50 p-3">
          <p className="text-sm text-slate-500">VAT from device groups</p>
          <p className="text-xl font-semibold text-slate-900">{formatCurrency(summary.vatFromDeviceGroups)}</p>
          <p className="text-xs text-slate-400">
            from {summary.vatFromDeviceGroupsCoverage.ordersWithFigure} of {summary.vatFromDeviceGroupsCoverage.ordersFiscalized} sales;
            group D not included
          </p>
        </div>
        <div className="rounded-lg bg-slate-50 p-3">
          <p className="text-sm text-slate-500">Cash</p>
          <p className="text-xl font-semibold text-slate-900">{formatCurrency(summary.totalsByMethod.cash)}</p>
        </div>
        <div className="rounded-lg bg-slate-50 p-3">
          <p className="text-sm text-slate-500">M-Pesa (manual)</p>
          <p className="text-xl font-semibold text-slate-900">{formatCurrency(summary.mpesaByMode.manual)}</p>
        </div>
        <div className="rounded-lg bg-slate-50 p-3">
          <p className="text-sm text-slate-500">M-Pesa (Daraja)</p>
          <p className="text-xl font-semibold text-slate-900">{formatCurrency(summary.mpesaByMode.daraja)}</p>
        </div>
        <div className="rounded-lg bg-slate-50 p-3">
          <p className="text-sm text-slate-500">Card</p>
          <p className="text-xl font-semibold text-slate-900">{formatCurrency(summary.totalsByMethod.card)}</p>
        </div>
      </div>
    </div>
  )
}

/**
 * The takings of the scope (docs/phase-246, R2): the sales summary for it and, when the scope is one shift, that shift's
 * Z report beside it with Print. The summary reads the shift's range and the Z report reads the shift itself, so merged
 * and moved sales count in the Z exactly as they do today; when the two disagree on the number of sales, the page says
 * so instead of leaving the difference unexplained.
 *
 * @param {{ choice: ScopeChoice }} props
 * @returns {JSX.Element}
 */
function TakingsSection({ choice }: { choice: ScopeChoice }) {
  const scope = toReportScope(choice)
  const scopeKey = JSON.stringify(scope)
  const shiftId = choice.kind === 'shift' ? choice.shiftId : null
  const [summary, setSummary] = useState<SalesSummary | null>(null)
  const [zReport, setZReport] = useState<ZReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [zError, setZError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setSummary(null)
    setError(null)
    void window.api.getSalesSummary(scope).then((result) => {
      if (cancelled) return
      if (result.success && result.data) setSummary(result.data)
      else setError(result.error ?? 'Failed to load sales summary')
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey])

  useEffect(() => {
    let cancelled = false
    setZReport(null)
    setZError(null)
    if (shiftId === null) return
    void window.api.getZReport(shiftId).then((result) => {
      if (cancelled) return
      if (result.success && result.data) setZReport(result.data)
      else setZError(result.error ?? 'Failed to open this shift’s Z-report')
    })
    return () => {
      cancelled = true
    }
  }, [shiftId])

  const differs = summary !== null && zReport !== null && summary.orderCount !== zReport.orderCount

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h3 className="mb-3 text-2xl font-bold text-slate-800">Sales Summary</h3>
      {error && <p className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">{error}</p>}
      <div className={shiftId !== null ? 'grid gap-4 lg:grid-cols-2' : ''}>
        <div>
          {!summary ? <p className="text-base text-slate-400">Loading…</p> : <SalesSummaryCards summary={summary} />}
          {differs && summary && zReport && (
            <p data-testid="takings-count-note" className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-base font-medium text-amber-900">
              This time range holds {summary.orderCount} {summary.orderCount === 1 ? 'sale' : 'sales'} and the shift&apos;s Z report{' '}
              {zReport.orderCount}: the difference belongs to another shift.
            </p>
          )}
        </div>
        {shiftId !== null && (
          <div data-testid="takings-z-report">
            {zError && <p className="rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">{zError}</p>}
            {!zReport && !zError && <p className="text-base text-slate-400">Loading the Z report…</p>}
            {zReport && (
              <ZReportBlock report={zReport}>
                {({ body, footer, correctionForm }) => (
                  <div className="rounded-lg border border-slate-200 p-3">
                    <h4 className="mb-2 text-lg font-semibold text-slate-800">Z-Report</h4>
                    {body}
                    <div className="mt-3">{footer}</div>
                    {correctionForm}
                  </div>
                )}
              </ZReportBlock>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

/** Fiscal status counts, one row per Nairobi day, paginated client-side. */
function FiscalStatusView({ scope }: { scope: ReportScope }) {
  const scopeKey = JSON.stringify(scope)
  const [rows, setRows] = useState<FiscalStatusDayCount[]>([])
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setPage(1)
    void window.api.getFiscalStatusByDay(scope).then((result) => {
      if (cancelled) return
      if (result.success && result.data) {
        setRows(result.data)
      } else {
        setError(result.error ?? 'Failed to load fiscal status')
      }
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey])

  const pageResult = paginate(rows, page, FISCAL_ROWS_PER_PAGE)

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h3 className="mb-3 text-2xl font-bold text-slate-800">Fiscal Status by Day</h3>
      {error && (
        <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">{error}</p>
      )}
      {loading ? (
        <p className="mt-3 text-base text-slate-400">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="mt-3 text-base text-slate-500">No orders in this range.</p>
      ) : (
        <div className="mt-3">
          <table className="w-full text-left text-base">
            <thead className="text-slate-500">
              <tr>
                <th className="py-2">Day (Nairobi)</th>
                <th className="py-2 text-right">Fiscalised</th>
                <th className="py-2 text-right">Waiting</th>
                <th className="py-2 text-right">Needs fixing</th>
              </tr>
            </thead>
            <tbody>
              {pageResult.items.map((row) => (
                <tr key={row.localDay} className="border-t border-slate-100">
                  <td className="py-2 pr-2 text-slate-800">{row.localDay}</td>
                  <td className="py-2 text-right text-emerald-700">{row.fiscalized}</td>
                  <td className="py-2 text-right text-amber-700">{row.waiting}</td>
                  <td className="py-2 text-right text-rose-700">{row.needsFixing}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager page={pageResult.page} pageCount={pageResult.pageCount} onChange={setPage} />
        </div>
      )}
    </section>
  )
}

/** One reconciliation status's badge colours — shared between the table and would-be legends. */
function reconciliationStatusClasses(status: FiscalReconciliationReport['rows'][number]['status']): string {
  if (status === 'matched') return 'bg-emerald-100 text-emerald-700'
  if (status === 'mismatch') return 'bg-rose-100 text-rose-700'
  return 'bg-amber-100 text-amber-700'
}

/**
 * Fiscal reconciliation (docs/phase-163, Commit 2; VIL checklist item
 * 13): summary counts, then every fiscalised order in the preset
 * compared against the fiscal device's own stored total, mismatches
 * listed first (the backend already sorts them — see
 * `generateFiscalReconciliation`). The whole range is fetched in one
 * call and paginated client-side, the same shape {@link FiscalStatusView}
 * already uses.
 */
function FiscalReconciliationView({ scope }: { scope: ReportScope }) {
  const scopeKey = JSON.stringify(scope)
  const [report, setReport] = useState<FiscalReconciliationReport | null>(null)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setPage(1)
    void window.api.getFiscalReconciliation(scope).then((result) => {
      if (cancelled) return
      if (result.success && result.data) {
        setReport(result.data)
      } else {
        setError(result.error ?? 'Failed to load fiscal reconciliation')
      }
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey])

  const rows = report?.rows ?? []
  const pageResult = paginate(rows, page, RECONCILIATION_ROWS_PER_PAGE)

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h3 className="mb-3 text-2xl font-bold text-slate-800">Fiscal Reconciliation</h3>
      {error && (
        <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">{error}</p>
      )}
      {loading || !report ? (
        <p className="mt-3 text-base text-slate-400">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="mt-3 text-base text-slate-500">No fiscalised orders in this range.</p>
      ) : (
        <div className="mt-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <div className="rounded-lg bg-slate-50 p-3">
              <p className="text-sm text-slate-500">Matched</p>
              <p className="text-xl font-semibold text-emerald-700">{report.totals.matched}</p>
            </div>
            <div className="rounded-lg bg-slate-50 p-3">
              <p className="text-sm text-slate-500">Mismatch</p>
              <p className="text-xl font-semibold text-rose-700">{report.totals.mismatch}</p>
            </div>
            <div className="rounded-lg bg-slate-50 p-3">
              <p className="text-sm text-slate-500">No device figure</p>
              <p className="text-xl font-semibold text-amber-700">{report.totals.noDeviceFigure}</p>
            </div>
            <div className="rounded-lg bg-slate-50 p-3">
              <p className="text-sm text-slate-500">Charged</p>
              <p className="text-xl font-semibold text-slate-900">{formatCurrency(report.totals.sumCharged)}</p>
            </div>
            <div className="rounded-lg bg-slate-50 p-3">
              <p className="text-sm text-slate-500">Device</p>
              <p className="text-xl font-semibold text-slate-900">{formatCurrency(report.totals.sumDevice)}</p>
            </div>
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-base">
              <thead className="text-slate-500">
                <tr>
                  <th className="py-2">Time</th>
                  <th className="py-2">Trader invoice #</th>
                  <th className="py-2">CU invoice #</th>
                  <th className="py-2 text-right">Charged</th>
                  <th className="py-2 text-right">Device</th>
                  <th className="py-2 text-right">Difference</th>
                  <th className="py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {pageResult.items.map((row) => (
                  <tr key={row.localId} className="border-t border-slate-100">
                    <td className="py-2 pr-2 text-slate-500">{new Date(row.createdAt).toLocaleString()}</td>
                    <td className="py-2 pr-2 font-mono text-sm text-slate-800">{row.traderInvoiceNumber}</td>
                    <td className="py-2 pr-2 text-slate-800">{row.cuInvoiceNumber ?? ''}</td>
                    <td className="py-2 text-right text-slate-800">{formatCurrency(row.charged)}</td>
                    <td className="py-2 text-right text-slate-800">
                      {row.deviceTotal === null ? '—' : formatCurrency(row.deviceTotal)}
                    </td>
                    <td className="py-2 text-right text-slate-800">
                      {row.difference === null ? '—' : formatCurrency(row.difference)}
                    </td>
                    <td className="py-2">
                      <span
                        className={`rounded-full px-2 py-1 text-sm font-medium ${reconciliationStatusClasses(row.status)}`}
                      >
                        {row.status === 'no-device-figure' ? 'no device figure' : row.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={pageResult.page} pageCount={pageResult.pageCount} onChange={setPage} />
        </div>
      )}
    </section>
  )
}

/** Invoice list: time, trader invoice number, CU invoice number (or fiscal status), total, payment, cashier. */
function InvoiceListView({ staffName, scope }: { staffName: (id: number | null) => string; scope: ReportScope }) {
  const scopeKey = JSON.stringify(scope)
  const [page, setPage] = useState(1)
  const [data, setData] = useState<{
    invoices: Array<{
      order: { local_id: number; created_at: string; fiscal_invoice_number: string | null; fiscal_status: string | null; total: number; payment_method: string | null; staff_id: number | null }
      traderInvoiceNumber: string
    }>
    total: number
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void window.api.getInvoiceList(scope, page).then((result) => {
      if (cancelled) return
      if (result.success && result.data) {
        setData({ invoices: result.data.invoices, total: result.data.total })
      } else {
        setError(result.error ?? 'Failed to load invoices')
      }
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
    // The page that holds this view is keyed by the scope, so a new scope is a new view that starts on page 1.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, page])

  const pageCount = Math.max(1, Math.ceil((data?.total ?? 0) / REPORTS_PAGE_SIZE))

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h3 className="mb-3 text-2xl font-bold text-slate-800">Invoice List</h3>
      {error && (
        <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">{error}</p>
      )}
      {loading || !data ? (
        <p className="mt-3 text-base text-slate-400">Loading…</p>
      ) : data.invoices.length === 0 ? (
        <p className="mt-3 text-base text-slate-500">No orders in this range.</p>
      ) : (
        <div className="mt-3">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-base">
              <thead className="text-slate-500">
                <tr>
                  <th className="py-2">Time</th>
                  <th className="py-2">Trader invoice #</th>
                  <th className="py-2">CU invoice # / status</th>
                  <th className="py-2 text-right">Total</th>
                  <th className="py-2">Payment</th>
                  <th className="py-2">Cashier</th>
                </tr>
              </thead>
              <tbody>
                {data.invoices.map(({ order, traderInvoiceNumber }) => (
                  <tr key={order.local_id} className="border-t border-slate-100">
                    <td className="py-2 pr-2 text-slate-500">{new Date(order.created_at).toLocaleString()}</td>
                    <td className="py-2 pr-2 font-mono text-sm text-slate-800">{traderInvoiceNumber}</td>
                    <td className="py-2 pr-2 text-slate-800">
                      {order.fiscal_invoice_number ?? order.fiscal_status ?? 'not filed'}
                    </td>
                    <td className="py-2 text-right text-slate-800">{formatCurrency(order.total)}</td>
                    <td className="py-2 pr-2 text-slate-500">{order.payment_method ?? ''}</td>
                    <td className="py-2 text-slate-800">{staffName(order.staff_id)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={page} pageCount={pageCount} onChange={setPage} />
        </div>
      )}
    </section>
  )
}

/** CSV export of the scope: orders or line items. */
function ExportView({ scope }: { scope: ReportScope }) {
  const [exporting, setExporting] = useState<'orders' | 'lines' | null>(null)
  const [status, setStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)

  const runExport = async (kind: 'orders' | 'lines'): Promise<void> => {
    setExporting(kind)
    setStatus(null)
    try {
      const result = await window.api.exportReportsCsv(scope, kind)
      if (!result.success) {
        setStatus({ kind: 'error', message: result.error ?? 'Export failed' })
      } else if (!result.data?.saved) {
        setStatus(null)
      } else {
        setStatus({ kind: 'success', message: `Saved to ${result.data.filePath}` })
      }
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : 'Export failed' })
    } finally {
      setExporting(null)
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h3 className="mb-3 text-2xl font-bold text-slate-800">Export</h3>
      {status && (
        <p
          className={`mt-3 rounded-lg px-3 py-2 text-base font-medium ${
            status.kind === 'success' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'
          }`}
        >
          {status.message}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={exporting !== null}
          onClick={() => void runExport('orders')}
          className="h-12 rounded-lg bg-rose-600 px-5 text-base font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {exporting === 'orders' ? 'Exporting…' : 'Export orders CSV'}
        </button>
        <button
          type="button"
          disabled={exporting !== null}
          onClick={() => void runExport('lines')}
          className="h-12 rounded-lg bg-slate-800 px-5 text-base font-semibold text-white hover:bg-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {exporting === 'lines' ? 'Exporting…' : 'Export lines CSV'}
        </button>
      </div>
    </section>
  )
}

/** The end of day for the scope (docs/phase-246, the amendment): one shift with its Approve, or the shifts of a range. */
function EndOfDayBlock({ choice, onOpenShift }: { choice: ScopeChoice; onOpenShift: (shift: ShiftApprovalRowLike, label: string) => void }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h3 className="mb-3 text-2xl font-bold text-slate-800">End of Day</h3>
      {choice.kind === 'shift' ? (
        <ShiftEndOfDay shiftId={choice.shiftId} />
      ) : (
        <ShiftApprovalList scope={toReportScope(choice)} onOpenShift={onOpenShift} />
      )}
    </section>
  )
}

/** The part of a shift row the page needs to switch to that shift. */
type ShiftApprovalRowLike = { shiftId: number }

/** A numbered step of the routine, so the tab reads in the order the day is closed. */
function StepHeading({ step, title, hint }: { step: number; title: string; hint?: string }) {
  return (
    <div>
      <h2 className="text-xl font-semibold text-slate-900">
        {step}. {title}
      </h2>
      {hint && <p className="text-base text-slate-500">{hint}</p>}
    </div>
  )
}

/** A one-tap header that opens or closes a part of the detail (docs/phase-246, R2: collapsed by default). */
function DetailToggle({ label, open, onToggle, children }: { label: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex h-12 w-full items-center justify-between rounded-xl border border-slate-200 bg-white px-4 text-left text-lg font-semibold text-slate-800 hover:bg-slate-50"
      >
        <span>{label}</span>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="mt-3">{children}</div>}
    </div>
  )
}

/**
 * The Reports tab (docs/phase-246, R2), laid out as the end-of-day routine: 1. the scope, one picker for a shift, a
 * period or a typed range; 2. the takings, the sales summary and, for a shift, its Z report with Print; 3. the checks,
 * End of Day with its approval per shift, fiscal status and fiscal reconciliation; 4. the detail, the invoice list, the
 * M-Pesa logs and the CSV export, shut until opened; 5. the shifts, Shift History with Move a sale and Correct figures.
 * Every report keeps calling the function it called before: a shift's scope gives the Z report its shift id, and every
 * other report the range of the shift's sales; a period or a typed range gives every report the range and shows no Z.
 * The page scrolls as a whole; Shift History keeps its own scroll box.
 *
 * @returns {JSX.Element}
 */
export default function ReportsPage() {
  const [choice, setChoice] = useState<ScopeChoice>(DEFAULT_SCOPE)
  const [staffById, setStaffById] = useState<Map<number, string>>(new Map())
  const [detailOpen, setDetailOpen] = useState<{ invoices: boolean; mpesa: boolean; export: boolean }>({ invoices: false, mpesa: false, export: false })

  useEffect(() => {
    void window.api.getStaffList().then((result) => {
      if (result.success && result.data) {
        setStaffById(new Map(result.data.map((staff) => [staff.id, staff.name])))
      }
    })
  }, [])

  const staffName = (staffId: number | null): string =>
    staffId === null ? '' : titleCaseName(staffById.get(staffId) ?? `Staff #${staffId}`)

  const scope = toReportScope(choice)
  const scopeKey = JSON.stringify(scope)
  const toggle = (key: 'invoices' | 'mpesa' | 'export'): void => setDetailOpen((open) => ({ ...open, [key]: !open[key] }))

  // The shifts of a range know their window and times; the label is made the way the picker makes it, from the same fields.
  const openShift = (shift: ShiftApprovalRowLike, label: string): void => setChoice({ kind: 'shift', shiftId: shift.shiftId, label })

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div data-testid="reports-scroll" className="touch-scrollbar min-h-0 flex-1 space-y-6 overflow-y-auto pr-2">
        <section className="space-y-3">
          <StepHeading step={1} title="Scope" hint="Pick a shift, a period or a range. Every report below is for it." />
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <ScopePicker scope={choice} onChange={setChoice} />
          </div>
        </section>

        <section className="space-y-3">
          <StepHeading step={2} title="Takings" />
          <TakingsSection key={scopeKey} choice={choice} />
        </section>

        <section className="space-y-3">
          <StepHeading step={3} title="Checks" hint="End of Day approval is made on one shift. Fiscal status and reconciliation are for the scope." />
          <EndOfDayBlock choice={choice} onOpenShift={openShift} />
          <FiscalStatusView key={`fiscal-${scopeKey}`} scope={scope} />
          <FiscalReconciliationView key={`recon-${scopeKey}`} scope={scope} />
        </section>

        <section className="space-y-3">
          <StepHeading step={4} title="Detail" hint="Shut until you open them." />
          <DetailToggle label="Invoice List" open={detailOpen.invoices} onToggle={() => toggle('invoices')}>
            <InvoiceListView key={`invoices-${scopeKey}`} staffName={staffName} scope={scope} />
          </DetailToggle>
          <DetailToggle label="M-Pesa Logs" open={detailOpen.mpesa} onToggle={() => toggle('mpesa')}>
            <p className="mb-2 text-base text-slate-500">The latest 50 M-Pesa transactions, not limited to {scopeTitle(choice)}.</p>
            <MpesaLogsPage />
          </DetailToggle>
          <DetailToggle label="Export CSV" open={detailOpen.export} onToggle={() => toggle('export')}>
            <ExportView scope={scope} />
          </DetailToggle>
        </section>

        <section className="space-y-3">
          <StepHeading step={5} title="Shifts" />
          <ShiftHistoryView staffName={staffName} />
        </section>
      </div>
    </div>
  )
}
