import { useState } from 'react'
import { useBarcodeScanner } from '../hooks/useBarcodeScanner.js'
import type {
  ConnectivityIntegration,
  ConnectivityStatusPayload,
  BarcodeStatus
} from '../types/connectivity.js'

/** Display label per integration. */
const INTEGRATION_LABELS: Record<ConnectivityIntegration, string> = {
  mpesa: 'M-Pesa',
  fiscal: 'Fiscal Server',
  printer: 'Receipt Printer',
  barcode: 'Barcode Scanner'
}

/**
 * A short clarifying note shown under an integration's status, when one
 * is needed. The fiscal check only reaches the server on this till, not
 * the control unit itself (phase-95, Finding 4) — this is the one place
 * that distinction needs spelling out, since a green status here can
 * otherwise be misread as "sales are filing."
 */
const INTEGRATION_NOTES: Partial<Record<ConnectivityIntegration, string>> = {
  fiscal:
    'This only checks whether the fiscal server on this till responds. It does not confirm sales are being filed. See the unfiled sales count for that, or press Test Connection in Admin for the full device check.'
}

/** Props for {@link ConnectivityModal}. */
export interface ConnectivityModalProps {
  integration: ConnectivityIntegration
  status: ConnectivityStatusPayload | null
  barcodeStatus: BarcodeStatus
  onBarcodeDetected: () => void
  onClose: () => void
}

/**
 * Details modal for one connectivity badge: last checked time,
 * latency, error message, and a way to re-test. M-Pesa/fiscal/printer
 * re-test by triggering an immediate reachability check on every
 * monitored integration (the main process has no per-integration
 * test channel); the barcode scanner instead arms a short listening
 * window for a real scan, since there is no passive way to detect a
 * keyboard-wedge scanner.
 *
 * @param {ConnectivityModalProps} props
 * @returns {JSX.Element}
 */
export default function ConnectivityModal({
  integration,
  status,
  barcodeStatus,
  onBarcodeDetected,
  onClose
}: ConnectivityModalProps) {
  const [testing, setTesting] = useState(false)
  const [listeningForScan, setListeningForScan] = useState(false)
  const [scanTimedOut, setScanTimedOut] = useState(false)

  useBarcodeScanner(
    () => {
      setListeningForScan(false)
      setScanTimedOut(false)
      onBarcodeDetected()
    },
    { enabled: listeningForScan }
  )

  const handleTestConnection = async (): Promise<void> => {
    setTesting(true)
    try {
      await window.api.testAllConnectivity()
    } finally {
      setTesting(false)
    }
  }

  const handleTestScanner = (): void => {
    setScanTimedOut(false)
    setListeningForScan(true)
    setTimeout(() => {
      setListeningForScan((stillListening) => {
        if (stillListening) setScanTimedOut(true)
        return false
      })
    }, 10_000)
  }

  const check = integration === 'barcode' ? null : status?.[integration]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-slate-800">
            {INTEGRATION_LABELS[integration]}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {integration === 'barcode' ? (
          <div className="space-y-3 text-base text-slate-600">
            <p>
              Status:{' '}
              <span className="font-medium text-slate-800">
                {barcodeStatus === 'connected' ? 'Connected' : 'Unknown'}
              </span>
            </p>
            <p className="text-sm text-slate-500">
              Keyboard-wedge scanners can't be detected until they're used. Click "Test
              Scanner" then scan a barcode (or type a code quickly and press Enter).
            </p>
            {listeningForScan && (
              <p className="text-sm font-medium text-amber-600">Listening for a scan…</p>
            )}
            {scanTimedOut && (
              <p className="text-sm font-medium text-rose-600">No scan detected — try again.</p>
            )}
            <button
              type="button"
              disabled={listeningForScan}
              onClick={handleTestScanner}
              className="w-full rounded-lg bg-rose-600 py-2 text-base font-semibold text-white transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {listeningForScan ? 'Listening…' : 'Test Scanner'}
            </button>
          </div>
        ) : (
          <div className="space-y-3 text-base text-slate-600">
            <p>
              Status:{' '}
              <span className="font-medium text-slate-800">
                {check?.connected ? 'Connected' : 'Disconnected'}
              </span>
            </p>
            <p>
              Last checked:{' '}
              <span className="font-medium text-slate-800">
                {check?.lastCheckedAt ? new Date(check.lastCheckedAt).toLocaleTimeString() : 'Never'}
              </span>
            </p>
            {check?.latencyMs !== undefined && (
              <p>
                Response time:{' '}
                <span className="font-medium text-slate-800">{check.latencyMs}ms</span>
              </p>
            )}
            {check?.error && (
              <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700">
                {check.error}
              </p>
            )}
            {INTEGRATION_NOTES[integration] && (
              <p className="text-sm text-slate-500">{INTEGRATION_NOTES[integration]}</p>
            )}
            <button
              type="button"
              disabled={testing}
              onClick={() => void handleTestConnection()}
              className="w-full rounded-lg bg-rose-600 py-2 text-base font-semibold text-white transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {testing ? 'Testing…' : 'Test Connection'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
