import { useProductStore, type CatalogSyncSummary } from '../stores/productStore.js'
import { useCartStore } from '../stores/cartStore.js'
import { usePaymentActivityStore, isPaymentInProgress } from '../stores/paymentActivityStore.js'
import { useToastStore } from '../stores/toastStore.js'
import { SYNC_RESULT_TOAST_TIMEOUT_MS } from '../lib/toastTimeouts.js'

const SYNC_TOAST_ID = 'catalog-sync'

/**
 * @param {string | null} iso when the products were last read in full
 * @returns {string} "Last synced 14:05", in Nairobi time
 */
export function lastSyncedLabel(iso: string | null): string {
  if (!iso) return 'Not synced yet'
  const time = new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Africa/Nairobi', hour: '2-digit', minute: '2-digit' })
  return `Last synced ${time}`
}

/**
 * The Sync button's message: what was read, what Shopify has that the till does not apply, and anything kept as it was.
 *
 * @param {CatalogSyncSummary} summary
 * @returns {string}
 */
export function syncResultMessage(summary: CatalogSyncSummary): string {
  const parts = [`${summary.productCount} products, ${summary.discountCount} discounts.`]
  if (summary.skipped.length > 0) parts.push(`Skipped: ${summary.skipped.map((s) => s.title).join(', ')}.`)
  parts.push(...summary.messages)
  return parts.join(' ')
}

/**
 * The top bar's Sync button (docs/phase-253-1). Off while the cart has items or a payment is in progress, so a sync
 * never changes a sale under way, and while a sync runs. Shows when the products were last read in full.
 */
export default function SyncButton() {
  const hasItems = useCartStore((state) => state.items.length > 0)
  const paying = usePaymentActivityStore((state) => isPaymentInProgress(state.active))
  const syncing = useProductStore((state) => state.syncing)
  const lastSyncedAt = useProductStore((state) => state.lastSyncedAt)
  const disabled = hasItems || paying || syncing

  const handleClick = async (): Promise<void> => {
    const summary = await useProductStore.getState().sync()
    if (!summary) return
    useToastStore.getState().show({
      id: SYNC_TOAST_ID,
      tone: summary.messages.length > 0 ? 'warning' : 'success',
      message: syncResultMessage(summary),
      timeoutMs: SYNC_RESULT_TOAST_TIMEOUT_MS,
      onDismiss: () => useToastStore.getState().dismiss(SYNC_TOAST_ID)
    })
  }

  return (
    <div className="flex shrink-0 items-center gap-2">
      <button
        type="button"
        onClick={() => void handleClick()}
        disabled={disabled}
        className="h-12 rounded-lg border border-slate-300 px-4 text-base font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {syncing ? 'Syncing…' : 'Sync'}
      </button>
      <span data-testid="last-synced" className="whitespace-nowrap text-sm text-slate-500">
        {lastSyncedLabel(lastSyncedAt)}
      </span>
    </div>
  )
}
