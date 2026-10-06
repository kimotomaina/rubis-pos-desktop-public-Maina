import { useEffect, useState } from 'react'
import type { ManualMpesaEntrySummary, ShiftEndOfDayReport } from '../../../main/services/reports.js'
import type { DiscardedHeldSale } from '../../../main/services/database.js'
import { formatCurrency } from '../lib/currency.js'
import { titleCaseName } from '../lib/text.js'
import { useKeyboardStore } from '../stores/keyboardStore.js'
import ManagerPinModal from './ManagerPinModal.js'

/** An admin's in-progress tick/reason choice for one still-pending entry. */
interface Selection {
  ticked: boolean
  reason: string
}

/**
 * One row shared by the shift's own entries and its carry-over. A pending entry gets a tick box (ticked by default)
 * and, once unticked, a reason field beneath it; an approved entry gets a plain check mark instead: nothing left to
 * decide about it here.
 */
function EntryRow({
  entry,
  showDay,
  selection,
  onToggle,
  onOpenReason,
  readOnly = false
}: {
  entry: ManualMpesaEntrySummary
  showDay: boolean
  /** Nothing to tick when the shift cannot be approved: it is open, merged, or already approved (docs/phase-246). */
  readOnly?: boolean
  /** Present only for a still-pending entry: an approved one has nothing to tick. */
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
          {pending && readOnly ? null : pending ? (
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
            <span className="rounded-full bg-amber-50 px-2 py-1 text-sm font-medium text-amber-700">Pending</span>
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
      {pending && !readOnly && selection && !selection.ticked && (
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

interface ShiftEndOfDayProps {
  shiftId: number
}

/**
 * The end of day of one shift (docs/phase-246, the amendment; it replaces the day's page of docs/phase-150 to 153, whose
 * ticking and reasons it keeps): the shift's cashier totals, its manual M-Pesa entries, and the carry-over of earlier
 * shifts still awaiting approval. Each pending entry is ticked to approve, or unticked, with a reason, to leave out. An
 * admin's PIN confirms, and the main process checks it and every id again. Approving is offered only for a closed shift
 * that was not approved before; otherwise the screen says why. The page it sits on scrolls: this has no scroll of its own.
 *
 * @param {ShiftEndOfDayProps} props
 * @returns {JSX.Element}
 */
export default function ShiftEndOfDay({ shiftId }: ShiftEndOfDayProps) {
  const [report, setReport] = useState<ShiftEndOfDayReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [approving, setApproving] = useState(false)
  const [collectingPin, setCollectingPin] = useState(false)
  const [note, setNote] = useState('')
  /** Held sales discarded on the day the shift began (docs/phase-217). */
  const [discardedHeld, setDiscardedHeld] = useState<DiscardedHeldSale[]>([])
  const [discardedHeldFailed, setDiscardedHeldFailed] = useState(false)
  /** One tick/reason choice per currently-pending entry, keyed by payment id. */
  const [selections, setSelections] = useState<Map<number, Selection>>(new Map())

  const load = async (): Promise<void> => {
    try {
      setLoading(true)
      setError(null)
      const result = await window.api.getShiftEndOfDayReport(shiftId)
      if (result.success && result.data) {
        setReport(result.data)
        // A discarded held sale may be an M-Pesa payment with no sale behind it, so the admin approving sees them here.
        try {
          const discarded = await window.api.getDiscardedHeldSales(result.data.localDay)
          setDiscardedHeld(discarded.success && discarded.data ? discarded.data : [])
          setDiscardedHeldFailed(!discarded.success)
        } catch {
          setDiscardedHeld([])
          setDiscardedHeldFailed(true)
        }
        // Every pending entry starts ticked: a fresh report always resets the choices, since the pending set may have changed.
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
    setNotice(null)
    setNote('')
    void load()
    // Loads again when another shift is chosen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shiftId])

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
        const result = await window.api.approveShiftReport({
          shiftId,
          approvedIds,
          excluded,
          managerId,
          managerPin,
          note: note.trim() || undefined
        })
        if (result.success && result.data) {
          setNotice(`${result.data.approvedCount} approved, ${result.data.excludedCount} left out.`)
          setNote('')
          await load()
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

  if (loading && !report) {
    return <p className="text-base text-slate-400">Loading the shift end of day…</p>
  }
  if (!report) {
    return error ? <p className="rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">{error}</p> : null
  }

  const allPending = [...report.manualEntries, ...report.carryOver].filter((entry) => !entry.approved)
  const tickedEntries = allPending.filter((entry) => selections.get(entry.paymentId)?.ticked ?? true)
  const approvingCount = tickedEntries.length
  const approvingTotal = tickedEntries.reduce((sum, entry) => sum + entry.amount, 0)
  const leftOutCount = allPending.length - approvingCount
  const readOnly = !report.canApprove

  return (
    <div data-testid="shift-end-of-day" className="space-y-4">
      <div>
        <h4 className="text-xl font-semibold text-slate-900">End of Day for shift #{report.shiftId}</h4>
        {report.approval ? (
          <p data-testid="shift-approval-state" className="mt-1 text-base font-medium text-emerald-700">
            Approved by {titleCaseName(report.approval.approvedByName)} on {new Date(report.approval.approvedAt).toLocaleString()}:{' '}
            {report.approval.entryCount} approved, {report.approval.excludedCount} left out, {formatCurrency(report.approval.totalAmount)}.
          </p>
        ) : (
          <p className="mt-1 text-base text-slate-500">
            {report.canApprove
              ? 'Approve the entries that match the M-Pesa statement; leave out the rest with a reason.'
              : (report.cannotApproveBecause ?? '')}
          </p>
        )}
      </div>

      {error && <p className="rounded-lg bg-rose-50 px-4 py-3 text-lg font-medium text-rose-700">{error}</p>}
      {notice && <p className="rounded-lg bg-emerald-50 px-4 py-3 text-lg font-medium text-emerald-800">{notice}</p>}

      {(discardedHeldFailed || discardedHeld.length > 0) && (
        <section className="overflow-x-auto rounded-xl border border-amber-300 bg-amber-50/40 p-3" data-testid="discarded-held-sales">
          <h4 className="mb-1 text-lg font-semibold text-amber-900">Held sales discarded — {report.localDay}</h4>
          {discardedHeldFailed ? (
            <p className="text-base font-medium text-rose-700">Could not load the discarded held sales.</p>
          ) : (
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
                {discardedHeld.map((sale) => (
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
          )}
        </section>
      )}

      <section className="overflow-x-auto rounded-xl border border-slate-200 bg-white p-4">
        <h4 className="mb-3 text-lg font-semibold text-slate-800">Per cashier</h4>
        {report.cashiers.length === 0 ? (
          <p className="text-base text-slate-500">No sales recorded in this shift.</p>
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
                  <td className="py-2 pr-2 text-right text-slate-800">{formatCurrency(cashier.totalsByMethod.cash)}</td>
                  <td className="py-2 pr-2 text-right text-slate-800">{formatCurrency(cashier.totalsByMethod.card)}</td>
                  <td className="py-2 pr-2 text-right text-slate-800">{formatCurrency(cashier.mpesaByMode.manual)}</td>
                  <td className="py-2 text-right text-slate-800">{formatCurrency(cashier.mpesaByMode.daraja)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-300 font-semibold text-slate-900">
                <td className="py-2 pr-2">Total</td>
                <td className="py-2 pr-2 text-right">{report.cashiers.reduce((sum, c) => sum + c.orderCount, 0)}</td>
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
        <h4 className="mb-3 text-lg font-semibold text-slate-800">Manual M-Pesa entries — this shift</h4>
        {report.manualEntries.length === 0 ? (
          <p className="text-base text-slate-500">No manual M-Pesa entries in this shift.</p>
        ) : (
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
              {report.manualEntries.map((entry) => (
                <EntryRow
                  key={entry.paymentId}
                  entry={entry}
                  showDay={false}
                  readOnly={readOnly}
                  selection={selections.get(entry.paymentId)}
                  onToggle={toggleEntry}
                  onOpenReason={openReasonKeyboard}
                />
              ))}
            </tbody>
          </table>
        )}
      </section>

      {report.carryOver.length > 0 && (
        <section className="overflow-x-auto rounded-xl border border-amber-300 bg-amber-50/40 p-4">
          <h4 className="mb-1 text-lg font-semibold text-amber-900">Carry-over from earlier shifts — not yet approved</h4>
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
              {report.carryOver.map((entry) => (
                <EntryRow
                  key={entry.paymentId}
                  entry={entry}
                  showDay
                  readOnly={readOnly}
                  selection={selections.get(entry.paymentId)}
                  onToggle={toggleEntry}
                  onOpenReason={openReasonKeyboard}
                />
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section data-testid="end-of-day-bar" className="rounded-xl border border-slate-200 bg-white p-3">
        {report.canApprove ? (
          <>
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="text-lg font-medium text-slate-700">
                Approving {approvingCount} of {allPending.length} {allPending.length === 1 ? 'entry' : 'entries'}. {leftOutCount} left out.
              </span>
              <span className="text-xl font-semibold text-slate-900">{formatCurrency(approvingTotal)}</span>
            </div>
            <div className="flex items-center gap-3">
              <input
                readOnly
                value={note}
                onClick={openNoteKeyboard}
                aria-label="Note for this review (optional)"
                placeholder="e.g. checked against the statement"
                className="h-12 min-w-0 flex-1 rounded-lg border border-slate-300 px-3 text-base focus:border-rose-400 focus:outline-none"
              />
              <button
                type="button"
                disabled={approving}
                onClick={() => setCollectingPin(true)}
                className="h-12 w-48 shrink-0 rounded-xl bg-rose-600 text-lg font-semibold text-white transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {approving ? 'Working…' : approvingCount === 0 ? 'Record review' : 'Approve'}
              </button>
            </div>
          </>
        ) : (
          <p data-testid="end-of-day-limited" className="text-lg font-medium text-slate-700">
            {report.approval ? 'This shift is approved.' : (report.cannotApproveBecause ?? '')}
            {allPending.length > 0 && !report.approval
              ? ` ${allPending.length} ${allPending.length === 1 ? 'entry' : 'entries'} waiting, ${formatCurrency(report.pendingManualTotal)}.`
              : ''}
          </p>
        )}
      </section>

      {collectingPin && (
        <ManagerPinModal
          title={
            approvingCount > 0
              ? `Approve ${approvingCount} ${approvingCount === 1 ? 'entry' : 'entries'}${
                  leftOutCount > 0 ? `, leave ${leftOutCount} out` : ''
                } for shift #${report.shiftId}`
              : `Record a review leaving out ${leftOutCount} ${leftOutCount === 1 ? 'entry' : 'entries'} for shift #${report.shiftId}`
          }
          onAuthorized={handleApproved}
          onCancel={() => setCollectingPin(false)}
        />
      )}
    </div>
  )
}
