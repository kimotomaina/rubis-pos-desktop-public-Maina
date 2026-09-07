import { useEffect, useRef } from 'react'
import { useCartStore } from '../stores/cartStore.js'
import { getSaleCompleteMessage } from '../lib/saleCompleteToast.js'
import { SALE_COMPLETE_TOAST_TIMEOUT_MS } from '../lib/toastTimeouts.js'
import { useToastStore } from '../stores/toastStore.js'

const SALE_COMPLETE_TOAST_ID = 'sale-complete'

/**
 * Confirms a completed sale (phase-84, Task 2) — the case that
 * previously showed nothing at all. Fires once per `localId` (a new
 * checkout, not every change to the same receipt — a same-visit
 * wrong-PIN fix via `FiscalNotice` does not retrigger this; the
 * banner's own disappearance is that confirmation), keyed off
 * `cartStore.lastReceipt` for the same reason `FiscalNotice` is.
 *
 * Suppressed when `getSaleCompleteMessage` returns `null` — i.e.
 * whenever `FiscalNotice` already has something to say about this sale
 * (`waiting`/`needs_fixing`) — so the till never shows a "tax receipt
 * issued" toast next to a banner reporting the opposite. A rapid second
 * sale replaces this toast rather than stacking a second one, via the
 * shared store's upsert-by-id.
 *
 * Renders nothing itself; `ToastStack` is the only thing that draws it
 * on screen.
 *
 * @returns {null}
 */
export default function SaleCompleteToast() {
  const lastReceipt = useCartStore((state) => state.lastReceipt)
  const shownForLocalId = useRef<number | null>(null)

  useEffect(() => {
    if (!lastReceipt || lastReceipt.localId === shownForLocalId.current) return
    shownForLocalId.current = lastReceipt.localId

    const message = getSaleCompleteMessage(lastReceipt)
    if (!message) return

    useToastStore.getState().show({
      id: SALE_COMPLETE_TOAST_ID,
      tone: 'success',
      message,
      timeoutMs: SALE_COMPLETE_TOAST_TIMEOUT_MS,
      onDismiss: () => useToastStore.getState().dismiss(SALE_COMPLETE_TOAST_ID)
    })
  }, [lastReceipt])

  return null
}
