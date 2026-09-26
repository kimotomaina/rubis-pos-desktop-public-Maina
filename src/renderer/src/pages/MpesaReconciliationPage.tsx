import { useEffect, useState } from 'react'
import type { MpesaPaymentRow } from '../../../main/services/database.js'
import { formatCurrency } from '../lib/currency.js'
import ManagerPinModal from '../components/ManagerPinModal'

/**
 * The reconciliation queue for manually entered M-Pesa payments.
 *
 * This screen is the control that justifies allowing an unverified
 * payment at all. A sale completed on a code nobody checked is only
 * acceptable because it lands here, visibly, until a manager has matched
 * it against the M-Pesa statement — a record marked "pending
 * reconciliation" that no screen ever shows would be a silent pass, not
 * a safeguard.
 *
 * Reconciling does **not** change the payment's `verification_status`.
 * The sale completed on an unverified code and that stays true for ever;
 * signing it off records that somebody later looked, not that the till
 * had proof at the time.
 *
 * @returns {JSX.Element}
 */
export default function MpesaReconciliationPage() {
  const [rows, setRows] = useState<MpesaPaymentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [reconcilingId, setReconcilingId] = useState<number | null>(null)
  const [note, setNote] = useState('')

  const load = async (): Promise<void> => {
    try {
      setLoading(true)
      setError(null)
      const result = await window.api.listUnreconciledMpesaPayments()
      if (result.success && result.data) {
        setRows(result.data)
      } else {
        setError(result.error ?? 'Failed to load unreconciled payments')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load unreconciled payments')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const handleAuthorized = (managerId: number, managerPin: string): void => {
    const paymentId = reconcilingId
    setReconcilingId(null)
    if (paymentId === null) return

    void (async () => {
      setError(null)
      setNotice(null)
      try {
        const result = await window.api.reconcileMpesaPayment(
          paymentId,
          managerId,
          managerPin,
          note.trim() || undefined
        )
        if (result.success) {
          setNotice(`Payment #${paymentId} marked as checked against the statement.`)
          setNote('')
          await load()
        } else {
          setError(result.error ?? 'Failed to reconcile that payment')
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to reconcile that payment')
      }
    })()
  }

  if (loading) {
    return <p className="p-4 text-lg text-slate-500">Loading unreconciled payments…</p>
  }

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h3 className="text-xl font-semibold text-slate-900">Manual (cashier-recorded) M-Pesa payments</h3>
        <p className="mt-1 max-w-3xl text-base text-slate-500">
          Sales completed on a code the cashier read off the customer&rsquo;s phone. Nobody
          verified these systematically — check each one against the M-Pesa statement and mark it
          here once you have.
        </p>
      </section>

      {error && (
        <p className="rounded-lg bg-rose-50 px-4 py-3 text-lg font-medium text-rose-700">{error}</p>
      )}
      {notice && (
        <p className="rounded-lg bg-emerald-50 px-4 py-3 text-lg font-medium text-emerald-800">
          {notice}
        </p>
      )}

      {rows.length === 0 ? (
        <p className="rounded-xl border border-slate-200 bg-white p-4 text-lg text-slate-500">
          Nothing waiting. Every manually entered payment has been checked.
        </p>
      ) : (
        <section className="overflow-x-auto rounded-xl border border-amber-300 bg-amber-50/40 p-4">
          <table className="w-full text-left text-base">
            <thead className="text-slate-500">
              <tr>
                <th className="py-2">Code</th>
                <th className="py-2 text-right">Amount</th>
                <th className="py-2">Sale</th>
                <th className="py-2">Taken</th>
                <th className="py-2">Cashier / approver</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-amber-200/60">
                  <td className="py-2 pr-2 font-medium tracking-wide text-slate-800">
                    {row.reference}
                  </td>
                  <td className="py-2 text-right text-slate-800">{formatCurrency(row.amount)}</td>
                  <td className="py-2 text-slate-500">#{row.order_local_id}</td>
                  <td className="py-2 text-slate-500">
                    {new Date(row.created_at).toLocaleString()}
                  </td>
                  <td className="py-2 text-slate-500">
                    {row.entered_by_staff_id} / {row.approved_by_staff_id ?? '—'}
                  </td>
                  <td className="py-2 text-right">
                    <button
                      type="button"
                      onClick={() => setReconcilingId(row.id)}
                      className="h-12 rounded-lg bg-slate-800 px-4 text-base font-semibold text-white hover:bg-slate-900"
                    >
                      Mark checked
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <label className="mt-4 block text-base font-medium text-slate-600">
            Note for the next payment you mark (optional)
          </label>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. found on the 23 Sep statement"
            maxLength={500}
            className="mt-1 h-12 w-full rounded-lg border border-slate-300 px-3 text-base focus:border-rose-400 focus:outline-none"
          />
        </section>
      )}

      {reconcilingId !== null && (
        <ManagerPinModal
          title="Confirm this payment against the M-Pesa statement"
          onAuthorized={handleAuthorized}
          onCancel={() => setReconcilingId(null)}
        />
      )}
    </div>
  )
}
