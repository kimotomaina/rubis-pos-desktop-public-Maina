import { useCallback, useEffect, useState } from 'react'
import type { OrderRow, ShiftRow } from '../../../main/services/database.js'
import type { ZReport } from '../../../main/services/reports.js'
import Pager from '../components/Pager.js'
import ZReportModal from '../components/ZReportModal.js'
import CloseShiftDialog from '../components/CloseShiftDialog.js'
import OpenShiftDialog from '../components/OpenShiftDialog.js'
import { formatCurrency } from '../lib/currency.js'
import { useShiftWindowStatus } from '../lib/useShiftWindowStatus.js'
import { useAuthStore } from '../stores/authStore.js'
import { useShiftStore } from '../stores/shiftStore.js'

/** Rows per page, as the main process pages them (`REPORTS_PAGE_SIZE`). */
const PAGE_SIZE = 10

/** One sale as the invoice list shows it. */
interface SaleRow {
  order: OrderRow
  traderInvoiceNumber: string
  paymentText: string
}

/**
 * A cashier's "My shifts and sales" (docs/phase-254, C5). Their shifts, newest first, with the till's open shift on top
 * carrying Close shift and Print Z; then the sales recorded under them, as the invoice list shows them. View only:
 * no export, correction, move or approval. Who "my" is comes from the main process's session, never from this screen.
 *
 * Opening and closing use the same dialogs as every other screen (docs/phase-256): with no shift open, Open shift; on
 * the open shift, Close shift (figures, review, close), then its Z.
 *
 * @returns {JSX.Element}
 */
export default function MyShiftsPage() {
  const signedIn = useAuthStore((state) => state.currentStaff)
  const [shiftPage, setShiftPage] = useState(1)
  const [shifts, setShifts] = useState<{ rows: ShiftRow[]; total: number } | null>(null)
  const [salePage, setSalePage] = useState(1)
  const [sales, setSales] = useState<{ rows: SaleRow[]; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [zReport, setZReport] = useState<ZReport | null>(null)
  const [closingShiftId, setClosingShiftId] = useState<number | null>(null)
  const [openingShift, setOpeningShift] = useState(false)
  // The open shift's Z is locked until it is closed: Print Z asks for the close instead (docs/phase-254).
  const [askToClose, setAskToClose] = useState(false)
  const { status: windowStatus, reload: reloadWindowStatus } = useShiftWindowStatus()

  const loadShifts = useCallback(async (): Promise<void> => {
    const result = await window.api.getMyShifts(shiftPage)
    if (result.success && result.data) setShifts({ rows: result.data.shifts, total: result.data.total })
    else setError(result.error ?? 'Failed to load your shifts')
  }, [shiftPage])

  useEffect(() => {
    void loadShifts()
  }, [loadShifts])

  useEffect(() => {
    void window.api.getMySales(salePage).then((result) => {
      if (result.success && result.data) setSales({ rows: result.data.invoices, total: result.data.total })
      else setError(result.error ?? 'Failed to load your sales')
    })
  }, [salePage])

  const showZ = async (shiftId: number): Promise<void> => {
    setError(null)
    const result = await window.api.getZReport(shiftId)
    if (result.success && result.data) setZReport(result.data)
    else setError(result.error ?? 'Failed to load the Z report')
  }

  const afterShiftChange = async (): Promise<void> => {
    void useShiftStore.getState().load()
    void reloadWindowStatus()
    await loadShifts()
  }

  const openStatus = windowStatus?.openShift ?? null
  // Which shift is open comes from the main process; with none open, a shift can be opened here.
  const noShiftOpen = windowStatus !== null && openStatus === null

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
      {error && (
        <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">
          {error}
        </p>
      )}

      <section className="rounded-xl border border-slate-200 bg-white p-4" data-testid="my-shifts">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-2xl font-bold text-slate-800">My shifts</h3>
          {noShiftOpen && signedIn && (
            <button
              type="button"
              onClick={() => setOpeningShift(true)}
              className="h-12 rounded-lg bg-rose-600 px-4 text-base font-semibold text-white hover:bg-rose-700"
            >
              Open shift
            </button>
          )}
        </div>
        {!shifts ? (
          <p className="text-base text-slate-400">Loading…</p>
        ) : shifts.rows.length === 0 ? (
          <p className="text-base text-slate-500">No shifts yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {shifts.rows.map((shift) => {
              const isOpen = shift.status === 'open'
              const closeBlocked = isOpen && openStatus?.id === shift.id && !openStatus.closeAllowed
              return (
                <li key={shift.id} className="py-3" data-testid={`my-shift-${shift.id}`}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="text-base text-slate-700">
                      <span className="font-semibold">Shift #{shift.id}</span>
                      <span className="ml-2 text-slate-500">
                        {new Date(shift.clock_in).toLocaleString()}
                        {' to '}
                        {shift.clock_out ? new Date(shift.clock_out).toLocaleString() : 'open now'}
                      </span>
                    </div>
                    <div className="flex gap-2">
                      {isOpen && (
                        <button
                          type="button"
                          onClick={() => {
                            setError(null)
                            setAskToClose(false)
                            setClosingShiftId(shift.id)
                          }}
                          disabled={closeBlocked}
                          className="h-12 rounded-lg bg-rose-600 px-4 text-base font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Close shift
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => (isOpen ? setAskToClose(true) : void showZ(shift.id))}
                        className="h-12 rounded-lg border border-slate-300 px-4 text-base font-medium text-slate-700 hover:bg-slate-50"
                      >
                        {isOpen ? 'Print Z' : 'Z report'}
                      </button>
                    </div>
                  </div>
                  {isOpen && askToClose && (
                    <div role="alert" className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-base font-medium text-amber-900" data-testid="z-locked">
                      <p>Shift #{shift.id} is still open. Close the shift first: its Z report is locked until then.</p>
                      {closeBlocked && openStatus?.closeMessage && <p className="text-sm font-normal">{openStatus.closeMessage}</p>}
                    </div>
                  )}
                  {closeBlocked && openStatus?.closeMessage && !askToClose && (
                    <p className="mt-2 text-sm text-slate-500">{openStatus.closeMessage}</p>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        <div className="mt-3">
          <Pager page={shiftPage} pageCount={Math.max(1, Math.ceil((shifts?.total ?? 0) / PAGE_SIZE))} onChange={setShiftPage} />
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4" data-testid="my-sales">
        <h3 className="mb-3 text-2xl font-bold text-slate-800">My sales</h3>
        {!sales ? (
          <p className="text-base text-slate-400">Loading…</p>
        ) : sales.rows.length === 0 ? (
          <p className="text-base text-slate-500">No sales yet.</p>
        ) : (
          <table className="w-full text-left text-base">
            <thead className="text-slate-500">
              <tr>
                <th className="py-2">Time</th>
                <th className="py-2">Trader invoice #</th>
                <th className="py-2">CU invoice # / status</th>
                <th className="py-2 text-right">Total</th>
                <th className="py-2 pl-4">Payment</th>
              </tr>
            </thead>
            <tbody>
              {sales.rows.map(({ order, traderInvoiceNumber, paymentText }) => (
                <tr key={order.local_id} className="border-t border-slate-100">
                  <td className="py-2 pr-2 text-slate-500">{new Date(order.created_at).toLocaleString()}</td>
                  <td className="py-2 pr-2 font-mono text-sm text-slate-800">{traderInvoiceNumber}</td>
                  <td className="py-2 pr-2 text-slate-800">{order.fiscal_invoice_number ?? order.fiscal_status ?? 'not filed'}</td>
                  <td className="py-2 text-right text-slate-800">{formatCurrency(order.total)}</td>
                  <td className="py-2 pl-4 text-slate-500">{paymentText}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="mt-3">
          <Pager page={salePage} pageCount={Math.max(1, Math.ceil((sales?.total ?? 0) / PAGE_SIZE))} onChange={setSalePage} />
        </div>
      </section>

      {closingShiftId !== null && (
        <CloseShiftDialog
          shiftId={closingShiftId}
          onCancel={() => setClosingShiftId(null)}
          onClosed={(report) => {
            setClosingShiftId(null)
            if (report) setZReport(report)
            void afterShiftChange()
          }}
        />
      )}
      {openingShift && signedIn && (
        <OpenShiftDialog
          staff={signedIn}
          onClose={() => setOpeningShift(false)}
          onOpened={() => {
            setOpeningShift(false)
            void afterShiftChange()
          }}
        />
      )}
      {zReport && <ZReportModal report={zReport} canCorrect={false} onClose={() => setZReport(null)} />}
    </div>
  )
}
