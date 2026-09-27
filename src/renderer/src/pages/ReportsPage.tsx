import { useEffect, useState } from 'react'
import type { ShiftRow } from '../../../main/services/database.js'
import type {
  ZReport,
  SalesSummary,
  FiscalStatusDayCount,
  FiscalReconciliationReport,
  ReportRangePreset
} from '../../../main/services/reports.js'
import { formatCurrency } from '../lib/currency.js'
import { formatVatRateLabel } from '../lib/vatLabel.js'
import { paginate } from '../lib/paginate.js'
import ZReportModal from '../components/ZReportModal.js'

/** Orders/shifts per page — matches the server-side `REPORTS_PAGE_SIZE` in `index.ts`. */
const REPORTS_PAGE_SIZE = 10

/** Fiscal-status rows per page — this table is paginated client-side (a month is at most 31 rows). */
const FISCAL_ROWS_PER_PAGE = 10

/** Fiscal-reconciliation rows per page — the whole range is fetched at once (docs/phase-163) and paginated client-side, like {@link FISCAL_ROWS_PER_PAGE}. */
const RECONCILIATION_ROWS_PER_PAGE = 10

/** The six fixed Nairobi date-range presets (docs/phase-158) — buttons only, never free text. */
const PRESETS: Array<{ key: ReportRangePreset; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'thisWeek', label: 'This week' },
  { key: 'lastWeek', label: 'Last week' },
  { key: 'thisMonth', label: 'This month' },
  { key: 'lastMonth', label: 'Last month' }
]

type ReportsSubView = 'shifts' | 'salesSummary' | 'fiscalByDay' | 'fiscalReconciliation' | 'invoices' | 'export'

/** A row of preset buttons, shared by every sub-view that offers one. */
function PresetButtons({
  preset,
  onSelect
}: {
  preset: ReportRangePreset
  onSelect: (preset: ReportRangePreset) => void
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {PRESETS.map(({ key, label }) => (
        <button
          key={key}
          type="button"
          onClick={() => onSelect(key)}
          className={`h-11 rounded-lg px-4 text-base font-semibold transition ${
            preset === key ? 'bg-rose-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

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
    <div className="mt-3 flex items-center justify-between gap-3">
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
 * Shift history: paginated, tap a row to open its Z-report (with the
 * existing, unchanged Reprint action inside `ZReportModal`).
 */
function ShiftHistoryView({ staffName }: { staffName: (id: number) => string }) {
  const [page, setPage] = useState(1)
  const [data, setData] = useState<{ shifts: ShiftRow[]; total: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [openReport, setOpenReport] = useState<ZReport | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void window.api.getShiftsList(page).then((result) => {
      if (cancelled) return
      if (result.success && result.data) {
        setData({ shifts: result.data.shifts, total: result.data.total })
      } else {
        setError(result.error ?? 'Failed to load shift history')
      }
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [page])

  const openShift = async (shiftId: number): Promise<void> => {
    setOpenError(null)
    const result = await window.api.getZReport(shiftId)
    if (result.success && result.data) {
      setOpenReport(result.data)
    } else {
      setOpenError(result.error ?? 'Failed to open this shift’s Z-report')
    }
  }

  const pageCount = Math.max(1, Math.ceil((data?.total ?? 0) / REPORTS_PAGE_SIZE))

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h3 className="mb-3 text-2xl font-bold text-slate-800">Shift History</h3>
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
          <div className="overflow-x-auto">
            <table className="w-full text-left text-base">
              <thead className="text-slate-500">
                <tr>
                  <th className="py-2">Shift</th>
                  <th className="py-2">Opened</th>
                  <th className="py-2">Closed</th>
                  <th className="py-2">Cashier</th>
                  <th className="py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.shifts.map((shift) => (
                  <tr
                    key={shift.id}
                    onClick={() => void openShift(shift.id)}
                    className="cursor-pointer border-t border-slate-100 hover:bg-slate-50"
                  >
                    <td className="py-2 pr-2 text-slate-800">#{shift.id}</td>
                    <td className="py-2 pr-2 text-slate-500">{new Date(shift.clock_in).toLocaleString()}</td>
                    <td className="py-2 pr-2 text-slate-500">
                      {shift.clock_out ? new Date(shift.clock_out).toLocaleString() : 'In progress'}
                    </td>
                    <td className="py-2 pr-2 text-slate-800">{staffName(shift.staff_id)}</td>
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
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={page} pageCount={pageCount} onChange={setPage} />
        </>
      )}
      {openReport && <ZReportModal report={openReport} onClose={() => setOpenReport(null)} />}
    </section>
  )
}

/** Sales summary for one of the fixed presets. */
function SalesSummaryView() {
  const [preset, setPreset] = useState<ReportRangePreset>('today')
  const [summary, setSummary] = useState<SalesSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void window.api.getSalesSummary(preset).then((result) => {
      if (cancelled) return
      if (result.success && result.data) {
        setSummary(result.data)
      } else {
        setError(result.error ?? 'Failed to load sales summary')
      }
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [preset])

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h3 className="mb-3 text-2xl font-bold text-slate-800">Sales Summary</h3>
      <PresetButtons preset={preset} onSelect={setPreset} />
      {error && (
        <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">{error}</p>
      )}
      {loading || !summary ? (
        <p className="mt-3 text-base text-slate-400">Loading…</p>
      ) : (
        <div className="mt-3">
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
                from {summary.vatFromDeviceGroupsCoverage.ordersWithFigure} of{' '}
                {summary.vatFromDeviceGroupsCoverage.ordersFiscalized} sales; group D not included
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
      )}
    </section>
  )
}

/** Fiscal status counts, one row per Nairobi day, paginated client-side. */
function FiscalStatusView() {
  const [preset, setPreset] = useState<ReportRangePreset>('today')
  const [rows, setRows] = useState<FiscalStatusDayCount[]>([])
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setPage(1)
    void window.api.getFiscalStatusByDay(preset).then((result) => {
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
  }, [preset])

  const pageResult = paginate(rows, page, FISCAL_ROWS_PER_PAGE)

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h3 className="mb-3 text-2xl font-bold text-slate-800">Fiscal Status by Day</h3>
      <PresetButtons preset={preset} onSelect={setPreset} />
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
function FiscalReconciliationView() {
  const [preset, setPreset] = useState<ReportRangePreset>('today')
  const [report, setReport] = useState<FiscalReconciliationReport | null>(null)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setPage(1)
    void window.api.getFiscalReconciliation(preset).then((result) => {
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
  }, [preset])

  const rows = report?.rows ?? []
  const pageResult = paginate(rows, page, RECONCILIATION_ROWS_PER_PAGE)

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h3 className="mb-3 text-2xl font-bold text-slate-800">Fiscal Reconciliation</h3>
      <PresetButtons preset={preset} onSelect={setPreset} />
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
function InvoiceListView({ staffName }: { staffName: (id: number | null) => string }) {
  const [preset, setPreset] = useState<ReportRangePreset>('today')
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
    void window.api.getInvoiceList(preset, page).then((result) => {
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
  }, [preset, page])

  const pageCount = Math.max(1, Math.ceil((data?.total ?? 0) / REPORTS_PAGE_SIZE))

  /** Resets to page 1 in the same tick as the preset change, so switching presets never fetches a stale page number first. */
  const selectPreset = (next: ReportRangePreset): void => {
    setPreset(next)
    setPage(1)
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h3 className="mb-3 text-2xl font-bold text-slate-800">Invoice List</h3>
      <PresetButtons preset={preset} onSelect={selectPreset} />
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

/** CSV export: pick a preset, then export orders or line items. */
function ExportView() {
  const [preset, setPreset] = useState<ReportRangePreset>('today')
  const [exporting, setExporting] = useState<'orders' | 'lines' | null>(null)
  const [status, setStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)

  const runExport = async (kind: 'orders' | 'lines'): Promise<void> => {
    setExporting(kind)
    setStatus(null)
    try {
      const result = await window.api.exportReportsCsv(preset, kind)
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
      <PresetButtons preset={preset} onSelect={setPreset} />
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

/**
 * Admin "Reports" tab (docs/phase-158): shift history with reprint, a
 * date-range sales summary, fiscal status by day, fiscal reconciliation
 * against the device's own validated totals (docs/phase-163), an invoice
 * list pairing CU and trader invoice numbers, and CSV export — built
 * only from data the till already stores (docs/phase-157's audit). Every
 * input is a preset button; nothing here opens the on-screen keyboard.
 *
 * @returns {JSX.Element}
 */
export default function ReportsPage() {
  const [subView, setSubView] = useState<ReportsSubView>('shifts')
  const [staffById, setStaffById] = useState<Map<number, string>>(new Map())

  useEffect(() => {
    void window.api.getStaffList().then((result) => {
      if (result.success && result.data) {
        setStaffById(new Map(result.data.map((staff) => [staff.id, staff.name])))
      }
    })
  }, [])

  const staffName = (staffId: number | null): string =>
    staffId === null ? '' : (staffById.get(staffId) ?? `Staff #${staffId}`)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 rounded-lg bg-slate-50 p-1">
        {(
          [
            ['shifts', 'Shift History'],
            ['salesSummary', 'Sales Summary'],
            ['fiscalByDay', 'Fiscal Status'],
            ['fiscalReconciliation', 'Fiscal Reconciliation'],
            ['invoices', 'Invoice List'],
            ['export', 'Export']
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setSubView(key)}
            className={`h-11 flex-1 rounded-md px-4 text-base font-semibold transition ${
              subView === key ? 'bg-white text-rose-700 shadow-sm' : 'text-slate-500'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {subView === 'shifts' && <ShiftHistoryView staffName={staffName} />}
      {subView === 'salesSummary' && <SalesSummaryView />}
      {subView === 'fiscalByDay' && <FiscalStatusView />}
      {subView === 'fiscalReconciliation' && <FiscalReconciliationView />}
      {subView === 'invoices' && <InvoiceListView staffName={staffName} />}
      {subView === 'export' && <ExportView />}
    </div>
  )
}
