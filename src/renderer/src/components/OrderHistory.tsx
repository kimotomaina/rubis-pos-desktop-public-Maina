import { useEffect, useState } from 'react'
import type { OrderRow } from '../../../main/services/database.js'
import type { OfflineOrderLine } from '../../../main/services/shopify-types.js'
import { formatCurrency } from '../lib/currency.js'
import { parseFiscalTimestamp } from '../lib/fiscalDate.js'
import { getEtrCopyEligibility } from '../lib/etrCopy.js'
import { useToastStore } from '../stores/toastStore.js'
import { paginate } from '../lib/paginate.js'
import Pager from './Pager.js'
import etimsLogoSrc from '../assets/logo-etims.png'

/** Orders per page (docs/phase-166 Commit E4) — replaces this screen's reliance on the outer window scrolling. */
export const ORDER_HISTORY_PAGE_SIZE = 10

/**
 * Renders the eTIMS brand logo, falling back to a plain "eTIMS" text
 * label if the image asset fails to load.
 *
 * @returns {JSX.Element}
 */
function EtimsLogo() {
  const [failed, setFailed] = useState(false)

  if (failed) {
    return <span className="text-xs font-semibold text-slate-500">eTIMS</span>
  }

  return (
    <img
      src={etimsLogoSrc}
      alt="eTIMS"
      className="h-6 w-auto shrink-0 object-contain"
      onError={() => setFailed(true)}
    />
  )
}

type OrderStatus = 'synced' | 'pending_sync' | 'failed' | 'voided'

/** How long the "Print ETR copy" outcome toast stays up (docs/phase-196-2). */
const ETR_COPY_TOAST_TIMEOUT_MS = 8000

const ETR_COPY_TOAST_ID = 'etr-copy'

interface OrderHistoryProps {
  onRetry: (localId: number) => void
  onPrint: (localId: number) => void
  /** Asks for a manager PIN, then calls `onAuthorized` with the manager's id and PIN. */
  requestManagerPin: (
    title: string,
    onAuthorized: (managerId: number, managerPin: string) => void
  ) => void
}

/**
 * Displays a list of recent orders with status badges and retry
 * functionality for failed or pending orders.
 *
 * Paginated at {@link ORDER_HISTORY_PAGE_SIZE} (docs/phase-166 Commit
 * E4) over the up-to-50 orders `fetchOrders` already loads — this
 * screen used to rely entirely on `App.tsx`'s outer window scrolling
 * to show more than fit; Phase E's no-scroll rule replaces that with
 * paging instead.
 *
 * @param {OrderHistoryProps} props
 * @returns {JSX.Element}
 */
export default function OrderHistory({ onRetry, onPrint, requestManagerPin }: OrderHistoryProps) {
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedOrderId, setExpandedOrderId] = useState<number | null>(null)
  const [page, setPage] = useState(1)

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

  /**
   * Shows one outcome toast for "Print ETR copy". A refusal shows the
   * reason the main process gave, verbatim.
   *
   * @param {string} message
   * @param {'success' | 'warning'} tone
   */
  const showEtrCopyToast = (message: string, tone: 'success' | 'warning') => {
    useToastStore.getState().show({
      id: ETR_COPY_TOAST_ID,
      tone,
      message,
      timeoutMs: ETR_COPY_TOAST_TIMEOUT_MS,
      onDismiss: () => useToastStore.getState().dismiss(ETR_COPY_TOAST_ID)
    })
  }

  /**
   * Asks for a manager PIN, then sends one duplicate-print request for the order.
   *
   * @param {number} localId
   */
  const handlePrintEtrCopy = (localId: number) => {
    requestManagerPin('Print the ETR copy at the fiscal device', (managerId, managerPin) => {
      void window.api
        .printFiscalDuplicate(localId, managerId, managerPin)
        .then((result) => {
          if (!result.success) {
            showEtrCopyToast(result.error ?? 'The ETR copy could not be printed.', 'warning')
          } else if (result.data?.issuedNewReceipt) {
            showEtrCopyToast(
              "Sent to the fiscal device, but its last receipt number changed. A new document may have been issued - tell support.",
              'warning'
            )
          } else {
            showEtrCopyToast("Sent to the fiscal device. Check the device's printer.", 'success')
          }
        })
        .catch(() => showEtrCopyToast('The ETR copy could not be printed.', 'warning'))
    })
  }

  const toggleExpanded = (localId: number) => {
    setExpandedOrderId((prev) => (prev === localId ? null : localId))
  }

  /**
   * Parses the persisted `payload_json` blob for its line items, used
   * to render the expanded detail view. Returns an empty list for a
   * row whose payload is missing or malformed rather than throwing.
   *
   * @param {OrderRow} order
   * @returns {OfflineOrderLine[]}
   */
  const getLineItems = (order: OrderRow): OfflineOrderLine[] => {
    try {
      const payload = JSON.parse(order.payload_json) as { lineItems?: OfflineOrderLine[] }
      return payload.lineItems ?? []
    } catch {
      return []
    }
  }

  const getStatusBadge = (status: OrderStatus) => {
    switch (status) {
      case 'synced':
        return (
          <span className="inline-flex items-center rounded-full bg-emerald-100 px-4 py-2 text-base font-medium text-emerald-800">
            Synced
          </span>
        )
      case 'pending_sync':
        return (
          <span className="inline-flex items-center rounded-full bg-amber-100 px-4 py-2 text-base font-medium text-amber-800">
            Syncing...
          </span>
        )
      case 'failed':
        return (
          <span className="inline-flex items-center rounded-full bg-rose-100 px-4 py-2 text-base font-medium text-rose-800">
            Failed
          </span>
        )
      case 'voided':
        return (
          <span className="inline-flex items-center rounded-full bg-slate-200 px-4 py-2 text-base font-medium text-slate-600">
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
        <p className="text-base text-rose-700">{error}</p>
        <button
          type="button"
          onClick={() => void fetchOrders()}
          className="mt-2 text-base font-medium text-rose-600 hover:text-rose-500"
        >
          Try again
        </button>
      </div>
    )
  }

  if (orders.length === 0) {
    return (
      <div className="py-12 text-center text-slate-500">
        <p className="text-xl">No orders yet</p>
        <p className="mt-1 text-base">
          Orders will appear here after checkout
        </p>
      </div>
    )
  }

  const pageResult = paginate(orders, page, ORDER_HISTORY_PAGE_SIZE)

  return (
    <div className="space-y-3">
      {pageResult.items.map((order) => {
        const isExpanded = expandedOrderId === order.local_id
        const etrCopy = getEtrCopyEligibility(orders, order)
        return (
          <div
            key={order.local_id}
            onClick={() => toggleExpanded(order.local_id)}
            className="cursor-pointer rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
          >
            <div className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
              <div>
                <p className="text-lg font-semibold text-slate-900">
                  Order #{order.local_id}
                </p>
                <p className="text-base text-slate-500">
                  {new Date(order.created_at).toLocaleString()}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {getStatusBadge(order.status)}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onPrint(order.local_id)
                  }}
                  className="h-11 rounded-md border border-slate-300 px-4 text-base font-medium text-slate-700 hover:bg-slate-50"
                >
                  Print Receipt
                </button>
                <button
                  type="button"
                  disabled={!etrCopy.enabled}
                  onClick={(e) => {
                    e.stopPropagation()
                    handlePrintEtrCopy(order.local_id)
                  }}
                  className="h-11 rounded-md border border-slate-300 px-4 text-base font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                >
                  Print ETR copy (prints at the fiscal device, not this till)
                </button>
                {(order.status === 'failed' ||
                  order.status === 'pending_sync') && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      onRetry(order.local_id)
                    }}
                    className="h-11 rounded-md bg-rose-600 px-4 text-base font-medium text-white hover:bg-rose-700"
                  >
                    Retry Sync
                  </button>
                )}
                <span className="pl-1 text-sm text-slate-400" aria-hidden="true">
                  {isExpanded ? '▲' : '▼'}
                </span>
              </div>
            </div>
            <div className="mt-2 flex items-center justify-between border-t border-slate-100 pt-2">
              <p className="text-base text-slate-600">
                Total: {formatCurrency(order.total)}
              </p>
              {order.shopify_order_id && (
                <p className="text-sm text-slate-400">
                  Shopify: {order.shopify_order_id.split('/').pop()}
                </p>
              )}
            </div>
            {!etrCopy.enabled && etrCopy.reason && order.fiscal_invoice_number && (
              <p className="mt-2 text-sm text-slate-400">ETR copy: {etrCopy.reason}</p>
            )}
            {order.fiscal_invoice_number && (
              <div
                className="mt-2 flex items-center gap-3 border-t border-slate-100 pt-2"
                onClick={(e) => e.stopPropagation()}
              >
                <EtimsLogo />
                {order.fiscal_qr_code && order.fiscal_qr_code ? (
                  <img
                    src={`data:image/png;base64,${order.fiscal_qr_code}`}
                    alt={`eTIMS QR code for invoice ${order.fiscal_invoice_number}`}
                    className="h-12 w-12 rounded border border-slate-200 object-contain"
                  />
                ) : (
                  <span className="inline-flex items-center rounded-full bg-emerald-100 px-3 py-1 text-sm font-medium text-emerald-800">
                    Fiscalized
                  </span>
                )}
                <details className="text-sm text-slate-600">
                  <summary className="cursor-pointer font-medium text-slate-700">
                    Fiscal Inv: {order.fiscal_invoice_number}
                  </summary>
                  <p className="mt-1 text-slate-500">
                    Fiscalized at{' '}
                    {parseFiscalTimestamp(order.fiscal_fiscalized_at)?.toLocaleString() ??
                      'unknown time'}
                  </p>
                </details>
              </div>
            )}
            {isExpanded && (
              <div className="mt-2 space-y-1 border-t border-slate-100 pt-2">
                {getLineItems(order).length === 0 ? (
                  <p className="text-sm text-slate-400">No item details available</p>
                ) : (
                  getLineItems(order).map((item, index) => (
                    <div
                      key={index}
                      className="flex items-center justify-between text-sm text-slate-600"
                    >
                      <span>
                        {item.quantity} x {item.title}
                        {item.variantTitle ? ` (${item.variantTitle})` : ''}
                      </span>
                      <span>{formatCurrency(item.unitPrice * item.quantity)}</span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )
      })}
      <Pager page={pageResult.page} pageCount={pageResult.pageCount} onChange={setPage} />
    </div>
  )
}
