import { useEffect, useState } from 'react'
import type { UpdateStatus } from '../../../main/services/updater.js'
import { UPDATE_TOAST_TIMEOUT_MS } from '../lib/toastTimeouts.js'
import { useToastStore } from '../stores/toastStore.js'

type ToastStatus = Extract<UpdateStatus, { kind: 'downloading' | 'downloaded' }>

const UPDATE_TOAST_ID = 'update'

/**
 * Pushes auto-update progress into the shared toast stack (phase-84).
 * Silent for `checking`/`not-available`/`error` — only surfaces once a
 * download is actually in progress or ready to install, so it never
 * distracts a cashier mid-sale. Renders nothing itself; `ToastStack` is
 * the only thing that draws it on screen.
 *
 * The toast now carries a timeout (`UPDATE_TOAST_TIMEOUT_MS` — see that
 * constant's doc for why a long one is safe here), where it previously
 * had none. Every `download-progress` tick re-shows the toast, which
 * resets its countdown (`toastStore`'s `updatedAt` stamp) — so it can't
 * disappear mid-download. Dismissing it, by the close button or the
 * timeout, only hides the toast; it has no effect on whether the update
 * installs.
 *
 * @returns {null}
 */
export default function UpdateToast() {
  const [status, setStatus] = useState<ToastStatus | null>(null)
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    return window.api.onUpdateStatus((next) => {
      if (next.kind === 'downloading' || next.kind === 'downloaded') {
        setStatus(next)
      }
    })
  }, [])

  const handleInstall = async (): Promise<void> => {
    setInstalling(true)
    await window.api.installUpdate()
  }

  useEffect(() => {
    if (!status) return

    useToastStore.getState().show({
      id: UPDATE_TOAST_ID,
      tone: 'info',
      message:
        status.kind === 'downloading' ? 'Downloading update…' : `Update ready - v${status.version}`,
      timeoutMs: UPDATE_TOAST_TIMEOUT_MS,
      onDismiss: () => useToastStore.getState().dismiss(UPDATE_TOAST_ID),
      actions:
        status.kind === 'downloading' ? (
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-700">
            <div
              className="h-full rounded-full bg-emerald-500 transition-all"
              style={{ width: `${Math.round(status.percent)}%` }}
            />
          </div>
        ) : (
          <button
            type="button"
            disabled={installing}
            onClick={() => void handleInstall()}
            className="w-full rounded-lg bg-emerald-600 py-2 text-base font-semibold text-white transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {installing ? 'Restarting…' : 'Restart & Install'}
          </button>
        )
    })
    // Re-registers the toast (resetting its countdown) on every status
    // or installing-state change, not just on the first sighting.
  }, [status, installing])

  return null
}
