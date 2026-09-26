import { useEffect, useRef, useState } from 'react'
import { createRestartCountdown, RESTART_COUNTDOWN_MS } from '../lib/restartCountdown'

interface RestartCountdownModalProps {
  /** Called once, either when the countdown reaches zero or "Restart Now" is clicked. */
  onRestart: () => void
  /** Called when the cashier cancels — the countdown stops, but any already-saved config is left as-is (it applies on whatever the next actual restart is). */
  onCancel: () => void
}

/**
 * Full-screen prompt shown after saving a configuration change that
 * only takes effect on relaunch — the M-Pesa/eTIMS mock toggles (which
 * select a provider constructed once at startup) and, since phase-148
 * step 1, the M-Pesa Admin save itself (Daraja credentials/shortcode/
 * environment/confirmation method are all read once at boot too, with
 * no live re-apply). Restarts automatically after
 * {@link RESTART_COUNTDOWN_MS}, or immediately on "Restart Now";
 * "Cancel" stops the countdown without discarding the already-persisted
 * change.
 *
 * @param {RestartCountdownModalProps} props
 * @returns {JSX.Element}
 */
export default function RestartCountdownModal({ onRestart, onCancel }: RestartCountdownModalProps) {
  const [msRemaining, setMsRemaining] = useState(RESTART_COUNTDOWN_MS)
  const countdownRef = useRef<ReturnType<typeof createRestartCountdown> | null>(null)

  useEffect(() => {
    const countdown = createRestartCountdown({
      callbacks: { onTick: setMsRemaining, onComplete: onRestart }
    })
    countdownRef.current = countdown
    countdown.start()
    return () => countdown.stop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleCancel = () => {
    countdownRef.current?.stop()
    onCancel()
  }

  const seconds = Math.ceil(msRemaining / 1000)
  const progressPercent = Math.max(0, Math.min(100, (msRemaining / RESTART_COUNTDOWN_MS) * 100))

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="restart-countdown-title"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
    >
      <div className="w-full max-w-md rounded-2xl bg-white p-6 text-center shadow-xl">
        <h3 id="restart-countdown-title" className="mb-2 text-2xl font-bold text-slate-900">
          Restart Required
        </h3>
        <p className="mb-4 text-base text-slate-600">
          Configuration changes require an app restart to take effect. Restarting in{' '}
          <span className="font-semibold tabular-nums text-slate-900">{seconds}s</span>…
        </p>
        <div className="mb-6 h-2 w-full overflow-hidden rounded-full bg-slate-100">
          <div
            className="h-full bg-rose-600 transition-[width]"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={handleCancel}
            className="flex-1 rounded-xl border border-slate-300 py-3 text-lg font-semibold text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onRestart}
            className="flex-1 rounded-xl bg-rose-600 py-3 text-lg font-semibold text-white hover:bg-rose-700"
          >
            Restart Now
          </button>
        </div>
      </div>
    </div>
  )
}
