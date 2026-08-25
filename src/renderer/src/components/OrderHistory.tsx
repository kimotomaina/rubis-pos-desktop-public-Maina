import { useEffect, useState } from 'react'
import type { OrderRow } from '../../../main/services/database.js'
import { formatCurrency } from '../lib/currency'

type OrderStatus = 'synced' | 'pending_sync' | 'failed' | 'voided'

interface OrderHistoryProps {
  onRetry: (localId: number) => void
  onPrint: (localId: number) => void
  /** Opens the Manager PIN gate; calls `onAuthorized` once verified (Phase 10). */
  requestManagerPin: (title: string, onAuthorized: () => void) => void
}

/**
 * Displays a list of recent orders with status badges and retry
 * functionality for failed or pending orders.
 *
 * @param {OrderHistoryProps} props
 * @returns {JSX.Element}
 */
export default function OrderHistory({ onRetry, onPrint, requestManagerPin }: OrderHistoryProps) {
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [voidError, setVoidError] = useState<string | null>(null)
  const [voidingId, setVoidingId] = useState<number | null>(null)

  const fetchOrders = async () => {
    try {
      setLoading(true)
      setError(null)
      const result = await window.api.getLocalOrders(50, 0)
      if (result.success && result.data) {
        setOrders(result.data)
      } else {
        setError(result.error ?? 'Failed to load orders')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load orders')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void fetchOrders()
  }, [])

  const handleVoid = (localId: number) => {
    requestManagerPin(`Void order #${localId}`, () => {
      void (async () => {
        setVoidError(null)
        setVoidingId(localId)
        try {
          const result = await window.api.voidOrder(localId)
          if (!result.success) {
            setVoidError(result.error ?? `Failed to void order #${localId}`)
          }
          await fetchOrders()
        } catch (err) {
          setVoidError(err instanceof Error ? err.message : `Failed to void order #${localId}`)
        } finally {
          setVoidingId(null)
        }
      })()
    })
  }

  const getStatusBadge = (status: OrderStatus) => {
    switch (status) {
      case 'synced':
        return (
          <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-800">
            Synced
          </span>
        )
      case 'pending_sync':
        return (
          <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800">
            Syncing...
          </span>
        )
      case 'failed':
        return (
          <span className="inline-flex items-center rounded-full bg-rose-100 px-2.5 py-0.5 text-xs font-medium text-rose-800">
            Failed
          </span>
        )
      case 'voided':
        return (
          <span className="inline-flex items-center rounded-full bg-slate-200 px-2.5 py-0.5 text-xs font-medium text-slate-600">
            Voided
          </span>
        )
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-rose-600 border-t-transparent" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-lg bg-rose-50 p-4 text-center">
        <p className="text-sm text-rose-700">{error}</p>
        <button
          type="button"
          onClick={() => void fetchOrders()}
          className="mt-2 text-sm font-medium text-rose-600 hover:text-rose-500"
        >
          Try again
        </button>
      </div>
    )
  }

  if (orders.length === 0) {
    return (
      <div className="py-12 text-center text-slate-500">
        <p className="text-lg">No orders yet</p>
        <p className="mt-1 text-sm">
          Orders will appear here after checkout
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {voidError && (
        <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700">
          {voidError}
        </p>
      )}
      {orders.map((order) => (
        <div
          key={order.local_id}
          className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
        >
          <div className="flex items-start justify-between">
            <div>
              <p className="font-medium text-slate-900">
                Order #{order.local_id}
              </p>
              <p className="text-sm text-slate-500">
                {new Date(order.created_at).toLocaleString()}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {getStatusBadge(order.status)}
              <button
                type="button"
                onClick={() => onPrint(order.local_id)}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Print Receipt
              </button>
              {(order.status === 'failed' ||
                order.status === 'pending_sync') && (
                <button
                  type="button"
                  onClick={() => onRetry(order.local_id)}
                  className="rounded-md bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-700"
                >
                  Retry Sync
                </button>
              )}
              {order.status === 'pending_sync' && (
                <button
                  type="button"
                  disabled={voidingId === order.local_id}
                  onClick={() => handleVoid(order.local_id)}
                  className="rounded-md border border-rose-300 px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {voidingId === order.local_id ? 'Voiding…' : 'Void'}
                </button>
              )}
            </div>
          </div>
          <div className="mt-2 flex items-center justify-between border-t border-slate-100 pt-2">
            <p className="text-sm text-slate-600">
              Total: {formatCurrency(order.total)}
            </p>
            {order.shopify_order_id && (
              <p className="text-xs text-slate-400">
                Shopify: {order.shopify_order_id.split('/').pop()}
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
