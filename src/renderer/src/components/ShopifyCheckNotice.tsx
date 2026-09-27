import { useEffect, useRef } from 'react'
import { useShopifyReconciliationStore } from '../stores/shopifyReconciliationStore.js'
import { countActionableFindings, CASHIER_NOTICE_MESSAGE } from '../lib/shopifyReconciliation.js'
import { useToastStore } from '../stores/toastStore.js'

const SHOPIFY_CHECK_TOAST_ID = 'shopify-check-notice'

/**
 * The cashier-facing half of the Shopify sales-safety check (docs/
 * phase-170 commit 3): one plain line, shown only when a person must
 * act (a held or missing sale) - never for an automatic link, which
 * needed no one's attention. Mounted once in `App.tsx`, alongside
 * `FiscalNotice`; renders nothing itself, `ToastStack` draws it.
 *
 * Tracks which result it last showed a notice for (`shownForCheckedAt`)
 * so dismissing it does not bring it straight back on the very next
 * render - it reappears only once a later check still has something
 * to act on.
 *
 * @returns {null}
 */
export default function ShopifyCheckNotice() {
  // The store's `init()` is called once, globally, from App.tsx.
  const result = useShopifyReconciliationStore((state) => state.result)
  const shownForCheckedAt = useRef<number | null>(null)

  useEffect(() => {
    const actionable = countActionableFindings(result)

    if (actionable === 0 || !result) {
      useToastStore.getState().dismiss(SHOPIFY_CHECK_TOAST_ID)
      return
    }

    if (shownForCheckedAt.current === result.checkedAt) return // already shown (and possibly dismissed) for this exact result

    useToastStore.getState().show({
      id: SHOPIFY_CHECK_TOAST_ID,
      tone: 'warning',
      message: CASHIER_NOTICE_MESSAGE,
      timeoutMs: null,
      pinned: true,
      onDismiss: () => {
        shownForCheckedAt.current = result.checkedAt
        useToastStore.getState().dismiss(SHOPIFY_CHECK_TOAST_ID)
      }
    })
  }, [result])

  return null
}
