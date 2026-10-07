import { useCallback, useEffect, useState } from 'react'
import type { OrderRow, ShiftRow } from '../../../main/services/database.js'
import type { ZReport } from '../../../main/services/reports.js'
import Pager from '../components/Pager.js'
import ZReportModal from '../components/ZReportModal.js'
import { formatCurrency } from '../lib/currency.js'
import { closeShiftBlockedMessage } from '../lib/heldSale.js'
import { CARD_BALANCE_INVALID, MPESA_BALANCE_INVALID, parseOptionalBalance } from '../lib/optionalBalance.js'
import { useShiftWindowStatus } from '../lib/useShiftWindowStatus.js'
import { useHeldSalesStore } from '../stores/heldSalesStore.js'
import { useKeyboardStore } from '../stores/keyboardStore.js'
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
 * Opens the docked keyboard for one of the close form's figures, as the Admin screen's Close Shift does.
 *
 * @param {string} value
 * @param {(next: string) => void} onChange
 * @param {string} label
 */
function openFigure(value: string, onChange: (next: string) => void, label: string): void {
  useKeyboardStore.getState().open({ value, onChange, label, mode: 'decimal' })
}

/**
 * A cashier's "My shifts and sales" (docs/phase-254, C5). Their shifts, newest first, with the till's open shift on top
 * carrying Close shift and the Z report; then the sales recorded under them, as the invoice list shows them. View only:
 * no export, correction, move or approval. Who "my" is comes from the main process's session, never from this screen.
 *
 * @returns {JSX.Element}
 */
export default function MyShiftsPage() {
  const [shiftPage, setShiftPage] = useState(1)
  const [shifts, setShifts] = useState<{ rows: ShiftRow[]; total: number } | null>(null)
  const [salePage, setSalePage] = useState(1)
  const [sales, setSales] = useState<{ rows: SaleRow[]; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [zReport, setZReport] = useState<ZReport | null>(null)
  const [closing, setClosing] = useState(false)
  // The open shift's Z is locked until it is closed: Print Z asks for the close instead (docs/phase-254).
  const [askToClose, setAskToClose] = useState(false)
  const [endingCash, setEndingCash] = useState('')
  const [mpesaClosing, setMpesaClosing] = useState('')
  const [cardClosing, setCardClosing] = useState('')
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

  const startClosing = (): void => {
    const blocked = closeShiftBlockedMessage(useHeldSalesStore.getState().sales)
    if (blocked) {
      setError(blocked)
      return
    }
    setError(null)
    setAskToClose(false)
    setClosing(true)
  }

  const cancelClosing = (): void => {
    setClosing(false)
    setEndingCash('')
    setMpesaClosing('')
    setCardClosing('')
  }

  const confirmClose = async (shiftId: number): Promise<void> => {
    const blocked = closeShiftBlockedMessage(useHeldSalesStore.getState().sales)
    if (blocked) {
      setError(blocked)
      return
    }
    const cash = parseFloat(endingCash)
    if (!Number.isFinite(cash) || cash < 0) {
      setError('Enter a valid ending cash amount')
      return
    }
    const mpesa = parseOptionalBalance(mpesaClosing)
    if (mpesa === 'invalid') {
      setError(MPESA_BALANCE_INVALID)
      return
    }
    const card = parseOptionalBalance(cardClosing)
    if (card === 'invalid') {
      setError(CARD_BALANCE_INVALID)
      return
    }
    setError(null)
    const result = await window.api.closeShift(shiftId, cash, mpesa, card)
    if (!result.success) {
      setError(result.error ?? 'Failed to close shift')
      return
    }
    cancelClosing()
    await showZ(shiftId)
    void useShiftStore.getState().load()
    void reloadWindowStatus()
    await loadShifts()
  }

  const openStatus = windowStatus?.openShift ?? null

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
      {error && (
        <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">
          {error}
        </p>
      )}

      <section className="rounded-xl border border-slate-200 bg-white p-4" data-testid="my-shifts">
        <h3 className="mb-3 text-2xl font-bold text-slate-800">My shifts</h3>
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
                      {isOpen && !closing && (
                        <button
                          type="button"
                          onClick={startClosing}
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
                  {isOpen && askToClose && !closing && (
                    <div role="alert" className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-base font-medium text-amber-900" data-testid="z-locked">
                      <p>Shift #{shift.id} is still open. Close the shift first: its Z report is locked until then.</p>
                      {closeBlocked && openStatus?.closeMessage && <p className="text-sm font-normal">{openStatus.closeMessage}</p>}
                    </div>
                  )}
                  {closeBlocked && openStatus?.closeMessage && !askToClose && (
                    <p className="mt-2 text-sm text-slate-500">{openStatus.closeMessage}</p>
                  )}
                  {isOpen && closing && (
                    <div className="mt-3 flex flex-wrap items-end gap-2" data-testid="close-shift-form">
                      {[
                        { label: 'Ending Cash (counted)', value: endingCash, set: setEndingCash, placeholder: '' },
                        { label: 'M-Pesa balance (optional)', value: mpesaClosing, set: setMpesaClosing, placeholder: 'Not recorded' },
                        { label: 'Card settlement (optional)', value: cardClosing, set: setCardClosing, placeholder: 'Not recorded' }
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
                            className="h-12 w-40 rounded-lg border border-slate-300 px-3 text-xl focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
                          />
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => void confirmClose(shift.id)}
                        className="h-12 rounded-lg bg-rose-600 px-4 text-base font-semibold text-white hover:bg-rose-700"
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        onClick={cancelClosing}
                        className="h-12 rounded-lg border border-slate-300 px-4 text-base text-slate-600 hover:bg-slate-50"
                      >
                        Cancel
                      </button>
                    </div>
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

      {zReport && <ZReportModal report={zReport} canCorrect={false} onClose={() => setZReport(null)} />}
    </div>
  )
}
