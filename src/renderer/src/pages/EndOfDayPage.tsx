import { useEffect, useState } from 'react'
import type { EndOfDayReport, ManualMpesaEntrySummary } from '../../../main/services/reports.js'
import type { DiscardedHeldSale } from '../../../main/services/database.js'
import { formatCurrency } from '../lib/currency.js'
import { titleCaseName } from '../lib/text.js'
import { paginate } from '../lib/paginate.js'
import { useAuthStore } from '../stores/authStore.js'
import { useKeyboardStore } from '../stores/keyboardStore.js'
import ManagerPinModal from '../components/ManagerPinModal.js'

/**
 * Manual entries and carry-over rows per page — keeps a long list within
 * the design box (Phase E). Lower than a plain read-only list would need
 * (phase-152 used 8) because a pending row can now grow a second line for
 * its reason field (docs/phase-153).
 */
const ENTRIES_PER_PAGE = 6

/** Discarded held sales per page (docs/phase-217): short rows, kept to three so the list stays inside the design box. */
const DISCARDED_PER_PAGE = 3

/** A manager's in-progress tick/reason choice for one still-pending entry. */
interface Selection {
  ticked: boolean
  reason: string
}

/**
 * Adds `deltaDays` calendar days to a `YYYY-MM-DD` string, in UTC so the
 * browser's own timezone can never shift the result by a day — this is
 * pure label arithmetic for the day-picker, not the Africa/Nairobi
 * boundary math `reports.ts`'s `getLocalDayRange` does server-side.
 *
 * @param {string} localDay
 * @param {number} deltaDays
 * @returns {string}
 */
function shiftLocalDay(localDay: string, deltaDays: number): string {
  const [year, month, day] = localDay.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + deltaDays)).toISOString().slice(0, 10)
}

/**
 * One row shared by the "today" and "carry-over" tables. A pending entry
 * gets a tick box (ticked by default) and, once unticked, a reason field
 * beneath it; an approved entry gets a plain check mark instead — nothing
 * left to decide about it here.
 */
function EntryRow({
  entry,
  showDay,
  selection,
  onToggle,
  onOpenReason
}: {
  entry: ManualMpesaEntrySummary
  showDay: boolean
  /** Present only for a still-pending entry — an approved one has nothing to tick. */
  selection?: Selection
  onToggle?: (paymentId: number) => void
  onOpenReason?: (paymentId: number) => void
}) {
  const columns = showDay ? 8 : 7
  const pending = !entry.approved

  return (
    <>
      <tr className="border-t border-slate-200/60">
        <td className="py-2 pr-2">
          {pending ? (
            <input
              type="checkbox"
              checked={selection?.ticked ?? true}
              onChange={() => onToggle?.(entry.paymentId)}
              aria-label={`Include ${entry.reference} in this review`}
              className="h-5 w-5"
            />
          ) : (
            <span aria-hidden="true" className="text-lg text-emerald-600">
              ✓
            </span>
          )}
        </td>
        {showDay && <td className="py-2 pr-2 text-slate-500">{entry.localDay}</td>}
        <td className="py-2 pr-2 text-slate-500">{new Date(entry.createdAt).toLocaleTimeString()}</td>
        <td className="py-2 pr-2 text-slate-500">#{entry.orderLocalId}</td>
        <td className="py-2 pr-2 text-slate-800">{titleCaseName(entry.staffName)}</td>
        <td className="py-2 pr-2 font-medium tracking-wide text-slate-800">{entry.reference}</td>
        <td className="py-2 pr-2 text-right text-slate-800">{formatCurrency(entry.amount)}</td>
        <td className="py-2 text-right">
          {entry.approved ? (
            <span className="rounded-full bg-emerald-50 px-2 py-1 text-sm font-medium text-emerald-700">
              Approved{entry.reconciledByStaffName ? ` — ${entry.reconciledByStaffName}` : ''}
            </span>
          ) : (
            <span className="rounded-full bg-amber-50 px-2 py-1 text-sm font-medium text-amber-700">
              Pending
            </span>
          )}
        </td>
      </tr>
      {entry.approved && entry.sameApproverAsRecorder && (
        <tr>
          <td colSpan={columns} className="pb-2 pl-9 text-sm italic text-amber-700">
            Recorded and approved by the same person.
          </td>
        </tr>
      )}
      {entry.lastExclusion && (
        <tr>
          <td colSpan={columns} className="pb-2 pl-9 text-sm italic text-slate-500">
            Left out on {entry.lastExclusion.localDay} by {titleCaseName(entry.lastExclusion.staffName)}
            {entry.lastExclusion.reason ? `: ${entry.lastExclusion.reason}` : ''}
          </td>
        </tr>
      )}
      {pending && selection && !selection.ticked && (
        <tr>
          <td colSpan={columns} className="pb-3 pl-9">
            <input
              readOnly
              value={selection.reason}
              onClick={() => onOpenReason?.(entry.paymentId)}
              placeholder="Reason for leaving this out (optional)"
              className="h-10 w-full max-w-md rounded-lg border border-slate-300 px-3 text-sm focus:border-rose-400 focus:outline-none"
            />
          </td>
        </tr>
      )}
    </>
  )
}

/**
 * End-of-day report (docs/phase-150.md deferred approval to this;
 * docs/phase-151/152 built the day approval; docs/phase-153 lets a
 * manager leave individual entries out with a reason instead of an
 * all-or-nothing approval): per-cashier totals for one Africa/Nairobi
 * calendar day, that day's manual M-Pesa entries, and any manual entry
 * from an earlier day still awaiting a manager's review.
 *
 * Replaces the per-payment Reconciliation tab for the POC — that page
 * (`MpesaReconciliationPage.tsx`) and its tests are untouched, just no
 * longer linked from an Admin tab (docs/phase-151/152 decision 6).
 *
 * @returns {JSX.Element}
 */
export default function EndOfDayPage() {
  const staffList = useAuthStore((state) => state.staffList)
  const fetchStaffList = useAuthStore((state) => state.fetchStaffList)

  const [report, setReport] = useState<EndOfDayReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [approving, setApproving] = useState(false)
  const [collectingPin, setCollectingPin] = useState(false)
  const [note, setNote] = useState('')
  const [entriesPage, setEntriesPage] = useState(1)
  const [carryOverPage, setCarryOverPage] = useState(1)
  /** Held sales discarded on the day shown (docs/phase-217). */
  const [discardedHeld, setDiscardedHeld] = useState<DiscardedHeldSale[]>([])
  const [discardedPage, setDiscardedPage] = useState(1)
  const [discardedHeldFailed, setDiscardedHeldFailed] = useState(false)
  /**
   * One tick/reason choice per currently-pending entry, keyed by payment
   * id — deliberately state that outlives which page is showing, so
   * paging back and forth never loses a manager's in-progress choices
   * (docs/phase-153's own "ticks and reasons survive paging" test).
   */
  const [selections, setSelections] = useState<Map<number, Selection>>(new Map())

  useEffect(() => {
    if (staffList.length === 0) void fetchStaffList()
  }, [staffList.length, fetchStaffList])

  const load = async (localDay?: string): Promise<void> => {
    try {
      setLoading(true)
      setError(null)
      const result = await window.api.getEndOfDayReport(localDay)
      if (result.success && result.data) {
        setReport(result.data)
        setEntriesPage(1)
        setCarryOverPage(1)
        setDiscardedPage(1)
        // A discarded held sale may be an M-Pesa payment with no sale behind it, so the
        // manager approving the day sees them here (docs/phase-217).
        try {
          const discarded = await window.api.getDiscardedHeldSales(result.data.localDay)
          setDiscardedHeld(discarded.success && discarded.data ? discarded.data : [])
          setDiscardedHeldFailed(!discarded.success)
        } catch {
          setDiscardedHeld([])
          setDiscardedHeldFailed(true)
        }
        // Every pending entry starts ticked (decision 1) — a fresh
        // report always resets choices, since the pending set itself
        // may have changed (a new sale, a just-recorded review).
        setSelections(new Map(result.data.pendingIds.map((id) => [id, { ticked: true, reason: '' }])))
      } else {
        setError(result.error ?? 'Failed to load the end-of-day report')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the end-of-day report')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // Loads once on mount, with no argument — the main process picks
    // today's Africa/Nairobi calendar day. Day-picker navigation below
    // re-calls `load` explicitly with a chosen day instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggleEntry = (paymentId: number): void => {
    setSelections((prev) => {
      const next = new Map(prev)
      const current = next.get(paymentId)
      if (current) next.set(paymentId, { ...current, ticked: !current.ticked })
      return next
    })
  }

  const openReasonKeyboard = (paymentId: number): void => {
    useKeyboardStore.getState().open({
      value: selections.get(paymentId)?.reason ?? '',
      onChange: (next) =>
        setSelections((prev) => {
          const updated = new Map(prev)
          const current = updated.get(paymentId)
          if (current) updated.set(paymentId, { ...current, reason: next })
          return updated
        }),
      label: 'Reason for leaving this entry out (optional)',
      maxLength: 200,
      mode: 'text',
      docked: true
    })
  }

  const openNoteKeyboard = (): void => {
    useKeyboardStore.getState().open({
      value: note,
      onChange: setNote,
      label: 'Note for this review (optional)',
      maxLength: 500,
      mode: 'text',
      docked: true
    })
  }

  const staffName = (staffId: number): string =>
    titleCaseName(staffList.find((staff) => staff.id === staffId)?.name ?? `Staff #${staffId}`)

  const handleApproved = (managerId: number, managerPin: string): void => {
    setCollectingPin(false)
    if (!report) return

    const allPending = [...report.manualEntries, ...report.carryOver].filter((entry) => !entry.approved)
    const approvedIds = allPending
      .filter((entry) => selections.get(entry.paymentId)?.ticked ?? true)
      .map((entry) => entry.paymentId)
    const excluded = allPending
      .filter((entry) => !(selections.get(entry.paymentId)?.ticked ?? true))
      .map((entry) => ({
        paymentId: entry.paymentId,
        reason: selections.get(entry.paymentId)?.reason.trim() || undefined
      }))

    void (async () => {
      setApproving(true)
      setError(null)
      setNotice(null)
      try {
        const result = await window.api.approveDayReport({
          localDay: report.localDay,
          approvedIds,
          excluded,
          managerId,
          managerPin,
          note: note.trim() || undefined
        })
        if (result.success && result.data) {
          const { approvedCount, excludedCount, alreadyApproved, approval } = result.data
          setNotice(
            alreadyApproved
              ? approval
                ? `Already approved on ${new Date(approval.approved_at).toLocaleString()} by ${staffName(approval.approved_by_staff_id)}.`
                : 'Already checked against the statement one-by-one — nothing left to record.'
              : `${approvedCount} approved, ${excludedCount} left out.`
          )
          setNote('')
          await load(report.localDay)
        } else {
          setError(result.error ?? 'Failed to record this review')
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to record this review')
      } finally {
        setApproving(false)
      }
    })()
  }

  if (loading || !report) {
    return <p className="p-4 text-lg text-slate-500">Loading end-of-day report…</p>
  }

  const entriesPageResult = paginate(report.manualEntries, entriesPage, ENTRIES_PER_PAGE)
  const carryOverPageResult = paginate(report.carryOver, carryOverPage, ENTRIES_PER_PAGE)
  const discardedPageResult = paginate(discardedHeld, discardedPage, DISCARDED_PER_PAGE)

  const allPending = [...report.manualEntries, ...report.carryOver].filter((entry) => !entry.approved)
  const tickedEntries = allPending.filter((entry) => selections.get(entry.paymentId)?.ticked ?? true)
  const approvingCount = tickedEntries.length
  const approvingTotal = tickedEntries.reduce((sum, entry) => sum + entry.amount, 0)
  const leftOutCount = allPending.length - approvingCount

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-xl font-semibold text-slate-900">End of Day — {report.localDay}</h3>
            <p className="mt-1 max-w-2xl text-base text-slate-500">
              Approve entries that match the M-Pesa statement; leave out the rest with a reason.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void load(shiftLocalDay(report.localDay, -1))}
              className="h-12 rounded-lg border border-slate-300 px-4 text-base font-medium text-slate-600 hover:bg-slate-50"
            >
              ← Previous day
            </button>
            <button
              type="button"
              onClick={() => void load(shiftLocalDay(report.localDay, 1))}
              className="h-12 rounded-lg border border-slate-300 px-4 text-base font-medium text-slate-600 hover:bg-slate-50"
            >
              Next day →
            </button>
          </div>
        </div>
      </section>

      {(discardedHeldFailed || discardedHeld.length > 0) && (
        <section className="overflow-x-auto rounded-xl border border-amber-300 bg-amber-50/40 p-3" data-testid="discarded-held-sales">
          <h4 className="mb-1 text-lg font-semibold text-amber-900">Held sales discarded — {report.localDay}</h4>
          {discardedHeldFailed ? (
            <p className="text-base font-medium text-rose-700">Could not load the discarded held sales.</p>
          ) : (
            <>
              <table className="w-full text-left text-base">
                <thead className="text-slate-500">
                  <tr>
                    <th className="py-1 pr-2">Time</th>
                    <th className="py-1 pr-2">Held sale</th>
                    <th className="py-1 pr-2 text-right">Total</th>
                    <th className="py-1 pr-2 text-right">Lines</th>
                    <th className="py-1 pr-2">Held by</th>
                    <th className="py-1 pr-2">Approved by</th>
                    <th className="py-1">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {discardedPageResult.items.map((sale) => (
                    <tr key={sale.id} className="border-t border-slate-200/60">
                      <td className="py-1 pr-2 text-slate-500">{new Date(sale.discardedAt).toLocaleTimeString()}</td>
                      <td className="py-1 pr-2 font-medium text-slate-800">{sale.label}</td>
                      <td className="py-1 pr-2 text-right text-slate-800">{formatCurrency(sale.total)}</td>
                      <td className="py-1 pr-2 text-right text-slate-800">{sale.lineCount}</td>
                      <td className="py-1 pr-2 text-slate-800">{titleCaseName(sale.heldByName ?? 'Unknown')}</td>
                      <td className="py-1 pr-2 text-slate-800">{titleCaseName(sale.managerName ?? 'Unknown')}</td>
                      <td className="max-w-xs truncate py-1 text-slate-700">{sale.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {discardedPageResult.pageCount > 1 && (
                <div className="mt-2 flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => setDiscardedPage(discardedPageResult.page - 1)}
                    disabled={!discardedPageResult.hasPrev}
                    className="h-9 rounded-lg border border-slate-300 px-3 text-base font-medium text-slate-600 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Previous
                  </button>
                  <span className="text-base text-slate-500">
                    Page {discardedPageResult.page} of {discardedPageResult.pageCount}
                  </span>
                  <button
                    type="button"
                    onClick={() => setDiscardedPage(discardedPageResult.page + 1)}
                    disabled={!discardedPageResult.hasNext}
                    className="h-9 rounded-lg border border-slate-300 px-3 text-base font-medium text-slate-600 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {error && (
        <p className="rounded-lg bg-rose-50 px-4 py-3 text-lg font-medium text-rose-700">{error}</p>
      )}
      {notice && (
        <p className="rounded-lg bg-emerald-50 px-4 py-3 text-lg font-medium text-emerald-800">
          {notice}
        </p>
      )}

      <section className="overflow-x-auto rounded-xl border border-slate-200 bg-white p-4">
        <h4 className="mb-3 text-lg font-semibold text-slate-800">Per cashier</h4>
        {report.cashiers.length === 0 ? (
          <p className="text-base text-slate-500">No sales recorded this day.</p>
        ) : (
          <table className="w-full text-left text-base">
            <thead className="text-slate-500">
              <tr>
                <th className="py-2 pr-2">Cashier</th>
                <th className="py-2 pr-2 text-right">Sales</th>
                <th className="py-2 pr-2 text-right">Cash</th>
                <th className="py-2 pr-2 text-right">Card</th>
                <th className="py-2 pr-2 text-right">M-Pesa (manual)</th>
                <th className="py-2 text-right">M-Pesa (Daraja)</th>
              </tr>
            </thead>
            <tbody>
              {report.cashiers.map((cashier) => (
                <tr key={cashier.staffId} className="border-t border-slate-200/60">
                  <td className="py-2 pr-2 text-slate-800">{titleCaseName(cashier.staffName)}</td>
                  <td className="py-2 pr-2 text-right text-slate-800">{cashier.orderCount}</td>
                  <td className="py-2 pr-2 text-right text-slate-800">
                    {formatCurrency(cashier.totalsByMethod.cash)}
                  </td>
                  <td className="py-2 pr-2 text-right text-slate-800">
                    {formatCurrency(cashier.totalsByMethod.card)}
                  </td>
                  <td className="py-2 pr-2 text-right text-slate-800">
                    {formatCurrency(cashier.mpesaByMode.manual)}
                  </td>
                  <td className="py-2 text-right text-slate-800">
                    {formatCurrency(cashier.mpesaByMode.daraja)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-300 font-semibold text-slate-900">
                <td className="py-2 pr-2">Total</td>
                <td className="py-2 pr-2 text-right">
                  {report.cashiers.reduce((sum, c) => sum + c.orderCount, 0)}
                </td>
                <td className="py-2 pr-2 text-right">{formatCurrency(report.totalsByMethod.cash)}</td>
                <td className="py-2 pr-2 text-right">{formatCurrency(report.totalsByMethod.card)}</td>
                <td className="py-2 pr-2 text-right" colSpan={2}>
                  {formatCurrency(report.totalsByMethod.mpesa)}
                </td>
              </tr>
            </tfoot>
          </table>
        )}
      </section>

      <section className="overflow-x-auto rounded-xl border border-slate-200 bg-white p-4">
        <h4 className="mb-3 text-lg font-semibold text-slate-800">Manual M-Pesa entries — {report.localDay}</h4>
        {report.manualEntries.length === 0 ? (
          <p className="text-base text-slate-500">No manual M-Pesa entries this day.</p>
        ) : (
          <>
            <table className="w-full text-left text-base">
              <thead className="text-slate-500">
                <tr>
                  <th className="py-2 pr-2">Include</th>
                  <th className="py-2 pr-2">Time</th>
                  <th className="py-2 pr-2">Sale</th>
                  <th className="py-2 pr-2">Cashier</th>
                  <th className="py-2 pr-2">Code</th>
                  <th className="py-2 pr-2 text-right">Amount</th>
                  <th className="py-2 text-right">Status</th>
                </tr>
              </thead>
              <tbody>
                {entriesPageResult.items.map((entry) => (
                  <EntryRow
                    key={entry.paymentId}
                    entry={entry}
                    showDay={false}
                    selection={selections.get(entry.paymentId)}
                    onToggle={toggleEntry}
                    onOpenReason={openReasonKeyboard}
                  />
                ))}
              </tbody>
            </table>
            {entriesPageResult.pageCount > 1 && (
              <div className="mt-3 flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => setEntriesPage(entriesPageResult.page - 1)}
                  disabled={!entriesPageResult.hasPrev}
                  className="h-10 rounded-lg border border-slate-300 px-3 text-base font-medium text-slate-600 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Previous
                </button>
                <span className="text-base text-slate-500">
                  Page {entriesPageResult.page} of {entriesPageResult.pageCount}
                </span>
                <button
                  type="button"
                  onClick={() => setEntriesPage(entriesPageResult.page + 1)}
                  disabled={!entriesPageResult.hasNext}
                  className="h-10 rounded-lg border border-slate-300 px-3 text-base font-medium text-slate-600 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </section>

      {report.carryOver.length > 0 && (
        <section className="overflow-x-auto rounded-xl border border-amber-300 bg-amber-50/40 p-4">
          <h4 className="mb-1 text-lg font-semibold text-amber-900">Carry-over — not yet approved</h4>
          <table className="w-full text-left text-base">
            <thead className="text-slate-500">
              <tr>
                <th className="py-2 pr-2">Include</th>
                <th className="py-2 pr-2">Day</th>
                <th className="py-2 pr-2">Time</th>
                <th className="py-2 pr-2">Sale</th>
                <th className="py-2 pr-2">Cashier</th>
                <th className="py-2 pr-2">Code</th>
                <th className="py-2 pr-2 text-right">Amount</th>
                <th className="py-2 text-right">Status</th>
              </tr>
            </thead>
            <tbody>
              {carryOverPageResult.items.map((entry) => (
                <EntryRow
                  key={entry.paymentId}
                  entry={entry}
                  showDay
                  selection={selections.get(entry.paymentId)}
                  onToggle={toggleEntry}
                  onOpenReason={openReasonKeyboard}
                />
              ))}
            </tbody>
          </table>
          {carryOverPageResult.pageCount > 1 && (
            <div className="mt-3 flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => setCarryOverPage(carryOverPageResult.page - 1)}
                disabled={!carryOverPageResult.hasPrev}
                className="h-10 rounded-lg border border-slate-300 px-3 text-base font-medium text-slate-600 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Previous
              </button>
              <span className="text-base text-slate-500">
                Page {carryOverPageResult.page} of {carryOverPageResult.pageCount}
              </span>
              <button
                type="button"
                onClick={() => setCarryOverPage(carryOverPageResult.page + 1)}
                disabled={!carryOverPageResult.hasNext}
                className="h-10 rounded-lg border border-slate-300 px-3 text-base font-medium text-slate-600 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next
              </button>
            </div>
          )}
        </section>
      )}

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-lg font-medium text-slate-700">
            Approving {approvingCount} of {allPending.length}{' '}
            {allPending.length === 1 ? 'entry' : 'entries'}. {leftOutCount} left out.
          </span>
          <span className="text-xl font-semibold text-slate-900">{formatCurrency(approvingTotal)}</span>
        </div>

        <label className="mb-1 block text-base font-medium text-slate-600">
          Note for this review (optional)
        </label>
        <input
          readOnly
          value={note}
          onClick={openNoteKeyboard}
          placeholder="e.g. checked against the statement"
          className="mb-3 h-12 w-full rounded-lg border border-slate-300 px-3 text-base focus:border-rose-400 focus:outline-none"
        />

        <button
          type="button"
          disabled={report.pendingIds.length === 0 || approving}
          onClick={() => setCollectingPin(true)}
          className="h-14 w-full rounded-xl bg-rose-600 text-lg font-semibold text-white transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {approving
            ? 'Working…'
            : report.pendingIds.length === 0
              ? 'Nothing pending'
              : approvingCount === 0
                ? 'Record review'
                : 'Approve'}
        </button>
      </section>

      {collectingPin && (
        <ManagerPinModal
          title={
            approvingCount > 0
              ? `Approve ${approvingCount} ${approvingCount === 1 ? 'entry' : 'entries'}${
                  leftOutCount > 0 ? `, leave ${leftOutCount} out` : ''
                } for ${report.localDay}`
              : `Record a review leaving out ${leftOutCount} ${leftOutCount === 1 ? 'entry' : 'entries'} for ${report.localDay}`
          }
          onAuthorized={handleApproved}
          onCancel={() => setCollectingPin(false)}
        />
      )}
    </div>
  )
}
