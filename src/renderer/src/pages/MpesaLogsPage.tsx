import { useEffect, useState } from 'react'
import type { MpesaTransactionRow, MpesaTransactionStatus } from '../../../main/services/database.js'
import { formatCurrency } from '../lib/currency'

/** Tailwind classes for a status pill, keyed by transaction status. */
const STATUS_BADGE_CLASSES: Record<MpesaTransactionStatus, string> = {
  pending: 'bg-amber-100 text-amber-800',
  success: 'bg-emerald-100 text-emerald-800',
  failed: 'bg-rose-100 text-rose-800'
}

const STATUS_LABEL: Record<MpesaTransactionStatus, string> = {
  pending: 'Pending',
  success: 'Success',
  failed: 'Failed'
}

/**
 * M-Pesa transaction log — lists STK Push attempts recorded during
 * checkout, with a manual "Check Status" action per pending row.
 *
 * No auto-polling: Daraja's Sandbox has no callback receiver
 * reachable from this till yet (see `daraja-mpesa-provider.ts`'s file
 * doc), so a cashier checks a transaction's outcome on demand — when a
 * customer claims they paid — via `window.api.queryMpesaStatus`
 * rather than the screen silently hammering the query endpoint.
 *
 * @returns {JSX.Element}
 */
export default function MpesaLogsPage() {
  const [transactions, setTransactions] = useState<MpesaTransactionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [checkingId, setCheckingId] = useState<number | null>(null)
  const [checkError, setCheckError] = useState<string | null>(null)

  const fetchTransactions = async () => {
    try {
      setLoading(true)
      setError(null)
      const result = await window.api.getMpesaTransactions(50)
      if (result.success && result.data) {
        setTransactions(result.data)
      } else {
        setError(result.error ?? 'Failed to load M-Pesa transactions')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load M-Pesa transactions')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void fetchTransactions()
  }, [])

  const handleCheckStatus = (transaction: MpesaTransactionRow) => {
    setCheckError(null)
    setCheckingId(transaction.id)
    void (async () => {
      try {
        const result = await window.api.queryMpesaStatus(transaction.checkout_request_id)
        if (!result.success || !result.data) {
          setCheckError(result.error ?? `Failed to check status for transaction #${transaction.id}`)
          return
        }
        if (result.data.status === 'pending') {
          setCheckError(result.data.resultDesc ?? 'Still pending — the customer has not responded yet')
          return
        }
        await fetchTransactions()
      } catch (err) {
        setCheckError(
          err instanceof Error ? err.message : `Failed to check status for transaction #${transaction.id}`
        )
      } finally {
        setCheckingId(null)
      }
    })()
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-rose-600 border-t-transparent" />
      </div>
    )
  }

  return (
    <div className="w-full space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-2xl font-bold text-slate-800">M-Pesa Transactions</h3>
        <button
          type="button"
          onClick={() => void fetchTransactions()}
          className="h-11 rounded-md border border-slate-300 px-4 text-base font-medium text-slate-700 hover:bg-slate-50"
        >
          Refresh
        </button>
      </div>

      {error && (
        <p className="rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">{error}</p>
      )}
      {checkError && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-base font-medium text-amber-800">
          {checkError}
        </p>
      )}

      {transactions.length === 0 ? (
        <p className="py-8 text-center text-base text-slate-500">No M-Pesa transactions yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-left text-base">
            <thead className="border-b border-slate-200 bg-slate-50 text-sm text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Order</th>
                <th className="px-4 py-3 font-medium">Phone</th>
                <th className="px-4 py-3 font-medium">Amount</th>
                <th className="px-4 py-3 font-medium">Time</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Receipt No.</th>
                <th className="px-4 py-3 font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {transactions.map((transaction) => (
                <tr key={transaction.id}>
                  <td className="px-4 py-3 text-slate-800">
                    {transaction.order_local_id ? `#${transaction.order_local_id}` : '—'}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{transaction.phone_number}</td>
                  <td className="px-4 py-3 text-slate-800">{formatCurrency(transaction.amount)}</td>
                  <td className="px-4 py-3 text-sm text-slate-500">
                    {new Date(transaction.created_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium ${STATUS_BADGE_CLASSES[transaction.status]}`}
                    >
                      {STATUS_LABEL[transaction.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {transaction.mpesa_receipt_number ?? '—'}
                  </td>
                  <td className="px-4 py-3">
                    {transaction.status === 'pending' && (
                      <button
                        type="button"
                        disabled={checkingId === transaction.id}
                        onClick={() => handleCheckStatus(transaction)}
                        className="h-9 rounded-md border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {checkingId === transaction.id ? 'Checking…' : 'Check Status'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
