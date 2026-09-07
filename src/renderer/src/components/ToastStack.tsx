import { useToastStore } from '../stores/toastStore.js'
import ToastShell from './ToastShell.js'

/**
 * The single place any toast actually renders (phase-84) — mounted once
 * at the app root, top-center, a vertical column. Every producer
 * (`ConnectivityToast`, `UpdateToast`, `FiscalNotice`, `SaleCompleteToast`,
 * `App.tsx`'s scan/search feedback) only ever pushes entries into
 * `toastStore`; none of them render a `fixed` div of their own anymore.
 *
 * New entries are appended at the end, so an existing toast never jumps
 * position when another one arrives (same order `ConnectivityToast`
 * already used before this unification). `max-h-[70vh]` with a
 * scrolling column, rather than an unbounded stack, keeps the column
 * from growing over the work area even in the (unlikely) worst case of
 * several toasts at once.
 */
export default function ToastStack() {
  const toasts = useToastStore((state) => state.toasts)

  if (toasts.length === 0) return null

  return (
    <div className="fixed left-1/2 top-4 z-50 flex max-h-[70vh] w-80 -translate-x-1/2 flex-col gap-2 overflow-y-auto">
      {toasts.map((toast) => (
        <ToastShell key={toast.id} toast={toast} />
      ))}
    </div>
  )
}
