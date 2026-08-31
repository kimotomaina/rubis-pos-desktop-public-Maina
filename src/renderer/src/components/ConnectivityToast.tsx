import { useEffect, useRef, useState } from 'react'
import {
  initialToastDebounceState,
  nextToastDebounceState,
  type ToastDebounceState
} from '../lib/connectivityToasts.js'
import type { ConnectivityStatusPayload } from './ConnectivityBadges.js'

/** Display label per integration, matching {@link ConnectivityModal}'s labels. */
const INTEGRATION_LABELS = {
  mpesa: 'M-Pesa',
  fiscal: 'Fiscal device',
  printer: 'Receipt printer'
} as const

type MonitoredIntegration = keyof typeof INTEGRATION_LABELS

/** One transient toast message on screen. */
interface ToastEntry {
  id: number
  message: string
  kind: 'connected' | 'disconnected'
}

/** How long a toast stays visible before auto-dismissing. */
const TOAST_LIFETIME_MS = 5000

let nextToastId = 0

/**
 * Listens for `connectivity:status` broadcasts and shows a toast only
 * when M-Pesa, the fiscal device, or the printer actually changes
 * connectivity state — debounced via {@link nextToastDebounceState} so
 * a flaky connection doesn't spam a toast on every 30-second poll.
 *
 * @returns {JSX.Element | null}
 */
export default function ConnectivityToast() {
  const [toasts, setToasts] = useState<ToastEntry[]>([])
  const debounceStateRef = useRef<Record<MonitoredIntegration, ToastDebounceState>>({
    mpesa: initialToastDebounceState(),
    fiscal: initialToastDebounceState(),
    printer: initialToastDebounceState()
  })

  useEffect(() => {
    return window.api.onConnectivityStatus((status: ConnectivityStatusPayload) => {
      const fired: ToastEntry[] = []

      for (const integration of Object.keys(INTEGRATION_LABELS) as MonitoredIntegration[]) {
        const prev = debounceStateRef.current[integration]
        const { state, toast } = nextToastDebounceState(prev, status[integration].connected)
        debounceStateRef.current[integration] = state

        if (toast) {
          fired.push({
            id: nextToastId++,
            kind: toast,
            message: `${INTEGRATION_LABELS[integration]} ${toast}`
          })
        }
      }

      if (fired.length === 0) return

      setToasts((current) => [...current, ...fired])
      for (const entry of fired) {
        setTimeout(() => {
          setToasts((current) => current.filter((t) => t.id !== entry.id))
        }, TOAST_LIFETIME_MS)
      }
    })
  }, [])

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-4 left-4 z-50 flex flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`rounded-lg px-4 py-2 text-base font-medium text-white shadow-xl ${
            toast.kind === 'connected' ? 'bg-emerald-600' : 'bg-rose-600'
          }`}
        >
          {toast.message}
        </div>
      ))}
    </div>
  )
}
