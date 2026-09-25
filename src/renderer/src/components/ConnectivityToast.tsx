import { useEffect, useRef } from 'react'
import {
  initialToastDebounceState,
  nextToastDebounceState,
  type ToastDebounceState
} from '../lib/connectivityToasts.js'
import { CONNECTIVITY_TOAST_TIMEOUT_MS } from '../lib/toastTimeouts.js'
import { useToastStore } from '../stores/toastStore.js'
import type { ConnectivityStatusPayload } from '../types/connectivity.js'

/** Display label per integration, matching {@link ConnectivityModal}'s labels. */
const INTEGRATION_LABELS = {
  mpesa: 'M-Pesa',
  fiscal: 'Fiscal device',
  printer: 'Receipt printer'
} as const

type MonitoredIntegration = keyof typeof INTEGRATION_LABELS

let nextToastId = 0

/**
 * Listens for `connectivity:status` broadcasts and pushes a toast into
 * the shared stack (`toastStore`, phase-84) only when M-Pesa, the fiscal
 * device, or the printer actually changes connectivity state —
 * debounced via {@link nextToastDebounceState} so a flaky connection
 * doesn't spam a toast on every 30-second poll. Renders nothing itself;
 * `ToastStack` is the only thing that draws a toast on screen.
 *
 * @returns {null}
 */
export default function ConnectivityToast() {
  const debounceStateRef = useRef<Record<MonitoredIntegration, ToastDebounceState>>({
    mpesa: initialToastDebounceState(),
    fiscal: initialToastDebounceState(),
    printer: initialToastDebounceState()
  })

  useEffect(() => {
    return window.api.onConnectivityStatus((status: ConnectivityStatusPayload) => {
      for (const integration of Object.keys(INTEGRATION_LABELS) as MonitoredIntegration[]) {
        const prev = debounceStateRef.current[integration]
        const { state, toast } = nextToastDebounceState(prev, status[integration].connected)
        debounceStateRef.current[integration] = state

        if (toast) {
          const id = `connectivity-${nextToastId++}`
          useToastStore.getState().show({
            id,
            tone: toast === 'connected' ? 'success' : 'error',
            message: `${INTEGRATION_LABELS[integration]} ${toast}`,
            timeoutMs: CONNECTIVITY_TOAST_TIMEOUT_MS,
            onDismiss: () => useToastStore.getState().dismiss(id)
          })
        }
      }
    })
  }, [])

  return null
}
