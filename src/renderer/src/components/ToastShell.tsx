import { useEffect, useRef } from 'react'
import type { ToastEntry, ToastTone } from '../stores/toastStore.js'

/** Background/text treatment per tone. */
const TONE_STYLES: Record<ToastTone, string> = {
  info: 'bg-slate-900 text-white',
  success: 'bg-emerald-600 text-white',
  warning: 'bg-amber-50 text-amber-900 border border-amber-200',
  error: 'bg-rose-600 text-white'
}

/**
 * Presentational chrome for one toast entry (phase-84): tone-colored
 * background, the message, any producer-supplied `actions` below it,
 * and an unconditional close (×) button — there's no prop to hide it,
 * so every toast rendered through this shell is dismissible. Owns the
 * auto-dismiss countdown itself; a `null` `timeoutMs` never starts one.
 *
 * The × click and the timeout call the SAME `toast.onDismiss` — this
 * component has no opinion on what dismissal means, that's entirely up
 * to the producer that built the entry.
 */
export default function ToastShell({ toast }: { toast: ToastEntry }) {
  const dismissRef = useRef(toast.onDismiss)
  dismissRef.current = toast.onDismiss

  useEffect(() => {
    if (toast.timeoutMs === null) return
    const id = setTimeout(() => dismissRef.current(), toast.timeoutMs)
    return () => clearTimeout(id)
    // `updatedAt` (not just `timeoutMs`) is a dependency deliberately —
    // it changes on every show() call for this id, so new activity
    // (e.g. a fresh download-progress tick) restarts the countdown even
    // when the timeout's numeric value hasn't changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast.timeoutMs, toast.updatedAt])

  return (
    <div
      role="status"
      className={`w-80 rounded-xl p-4 text-base shadow-xl ${TONE_STYLES[toast.tone]}`}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="font-medium leading-snug">{toast.message}</p>
        <button
          type="button"
          onClick={toast.onDismiss}
          className="shrink-0 text-lg leading-none opacity-70 transition hover:opacity-100"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
      {toast.actions && <div className="mt-3">{toast.actions}</div>}
    </div>
  )
}
