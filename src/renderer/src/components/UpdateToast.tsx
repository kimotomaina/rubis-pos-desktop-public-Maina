import { useEffect, useState } from 'react'
import type { UpdateStatus } from '../../../main/services/updater.js'

type ToastStatus = Extract<UpdateStatus, { kind: 'downloading' | 'downloaded' }>

/**
 * Subtle bottom-corner toast for auto-update progress. Silent for
 * `checking`/`not-available`/`error` — only surfaces once a download is
 * actually in progress or ready to install, so it never distracts a
 * cashier mid-sale.
 *
 * @returns {JSX.Element | null}
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

  if (!status) return null

  const handleInstall = async () => {
    setInstalling(true)
    await window.api.installUpdate()
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 w-72 rounded-xl bg-slate-900 p-4 text-sm text-white shadow-xl">
      {status.kind === 'downloading' ? (
        <>
          <p className="font-medium">Downloading update…</p>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-700">
            <div
              className="h-full rounded-full bg-emerald-500 transition-all"
              style={{ width: `${Math.round(status.percent)}%` }}
            />
          </div>
        </>
      ) : (
        <>
          <p className="font-medium">Update ready — v{status.version}</p>
          <button
            type="button"
            disabled={installing}
            onClick={() => void handleInstall()}
            className="mt-2 w-full rounded-lg bg-emerald-600 py-2 text-sm font-semibold text-white transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {installing ? 'Restarting…' : 'Restart & Install'}
          </button>
        </>
      )}
    </div>
  )
}
