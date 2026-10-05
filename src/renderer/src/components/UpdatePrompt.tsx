import { useEffect, useRef, useState } from 'react'
import { useCartStore } from '../stores/cartStore.js'
import { isPaymentInProgress, usePaymentActivityStore } from '../stores/paymentActivityStore.js'
import { useUpdateStatusStore } from '../stores/updateStatusStore.js'
import { updateNowRefusal } from '../lib/updateNow.js'
import { UPDATE_DOWNLOAD_FAILED_TEXT, UPDATE_INSTALL_FAILED_TEXT, plainUpdateText } from '../lib/updateMessages.js'

type Step = 'offer' | 'downloading' | 'installing'

/**
 * Asks, once per app start and only on the sale screen, whether to install an available update
 * (docs/phase-219). It is mounted after login, location and fiscal setup, so no earlier screen
 * is interrupted. The check itself is made by the main process, once per run; a failed check
 * shows nothing.
 *
 * "Later" closes the dialog and stores nothing: the next app start asks again, and the App &
 * Updates panel still shows the update. "Update now" is refused while the cart has items, a
 * payment is in progress or a sale is being completed; otherwise it downloads (progress shown),
 * then installs through the same `updater:install` the panel and the toast use.
 *
 * @returns {JSX.Element | null}
 */
export default function UpdatePrompt() {
  const [version, setVersion] = useState<string | null>(null)
  const [installedVersion, setInstalledVersion] = useState<string | null>(null)
  const [step, setStep] = useState<Step>('offer')
  const [percent, setPercent] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const downloaded = useRef(false)
  const asked = useRef(false)
  const setStatus = useUpdateStatusStore((state) => state.setStatus)
  const setPromptOpen = useUpdateStatusStore((state) => state.setPromptOpen)

  useEffect(() => {
    return window.api.onUpdateStatus((next) => {
      setStatus(next)
      if (next.kind === 'downloading') setPercent(next.percent)
    })
  }, [setStatus])

  useEffect(() => {
    if (asked.current) return
    asked.current = true
    void (async () => {
      try {
        const result = await window.api.startupUpdateCheck()
        if (!result.success || !result.data) return
        setStatus({ kind: 'available', version: result.data })
        setInstalledVersion(await window.api.getAppVersion())
        setVersion(result.data)
      } catch {
        return
      }
    })()
  }, [setStatus])

  useEffect(() => {
    setPromptOpen(version !== null)
    return () => setPromptOpen(false)
  }, [version, setPromptOpen])

  if (version === null) return null

  const refusal = (): string | null =>
    updateNowRefusal({
      saleBeingCompleted: useCartStore.getState().checkoutStatus === 'submitting',
      paymentInProgress: isPaymentInProgress(usePaymentActivityStore.getState().active),
      cartItemCount: useCartStore.getState().items.length
    })

  const handleUpdateNow = async (): Promise<void> => {
    const refused = refusal()
    if (refused) {
      setNotice(refused)
      return
    }
    setNotice(null)

    if (!downloaded.current) {
      setPercent(0)
      setStep('downloading')
      const download = await window.api.downloadUpdate()
      if (!download.success) {
        setStep('offer')
        setNotice(
          `${plainUpdateText(download.error, UPDATE_DOWNLOAD_FAILED_TEXT)} ` +
            `The till is still running version ${installedVersion ?? 'as before'}.`
        )
        return
      }
      downloaded.current = true
    }

    const refusedAfterDownload = refusal()
    if (refusedAfterDownload) {
      setStep('offer')
      setNotice(refusedAfterDownload)
      return
    }

    setStep('installing')
    const install = await window.api.installUpdate()
    if (!install.success) {
      setStep('offer')
      setNotice(plainUpdateText(install.error, UPDATE_INSTALL_FAILED_TEXT))
    }
  }

  const busy = step !== 'offer'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-6">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl" role="dialog" aria-label="Update available">
        <h3 className="text-xl font-semibold text-slate-900">Update available: version {version}</h3>
        <p className="mt-2 text-base text-slate-600">
          Installed version {installedVersion ?? ''} &rarr; new version {version}. The till will restart to install
          it.
        </p>
        {step === 'downloading' && (
          <div className="mt-4">
            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
              <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${Math.round(percent)}%` }} />
            </div>
            <p className="mt-1 text-base text-slate-600">Downloading update… {Math.round(percent)}%</p>
          </div>
        )}
        {notice && (
          <p role="alert" className="mt-4 text-base font-medium text-rose-600">
            {notice}
          </p>
        )}
        <div className="mt-5 flex gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => setVersion(null)}
            className="h-12 flex-1 rounded-xl border border-slate-300 text-lg font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Later
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleUpdateNow()}
            className="h-12 flex-1 rounded-xl bg-emerald-600 text-lg font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {step === 'installing' ? 'Restarting…' : step === 'downloading' ? 'Downloading…' : 'Update now'}
          </button>
        </div>
      </div>
    </div>
  )
}
