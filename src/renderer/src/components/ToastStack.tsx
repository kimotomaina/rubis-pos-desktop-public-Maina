import { useToastStore } from '../stores/toastStore.js'
import { visibleToasts } from '../lib/toastVisibility.js'
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
 * already used before this unification). `visibleToasts` (docs/
 * phase-166 Commit E4) caps the column at 3 rather than letting it grow
 * and scroll internally — Phase E's no-scroll rule — while always
 * keeping the pinned FiscalNotice on screen.
 */
export default function ToastStack() {
  const toasts = useToastStore((state) => state.toasts)
  const visible = visibleToasts(toasts)

  if (visible.length === 0) return null

  return (
    <div className="fixed left-1/2 top-4 z-50 flex w-80 -translate-x-1/2 flex-col gap-2">
      {visible.map((toast) => (
        <ToastShell key={toast.id} toast={toast} />
      ))}
    </div>
  )
}
