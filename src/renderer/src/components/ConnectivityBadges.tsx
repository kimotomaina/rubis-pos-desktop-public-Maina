/** Result of one reachability probe, mirroring `ConnectivityCheckPayload` in the preload layer. */
export interface ConnectivityCheckPayload {
  connected: boolean
  lastCheckedAt: string
  latencyMs?: number
  error?: string
}

/** Mirrors `ConnectivityStatusPayload` in the preload layer. */
export interface ConnectivityStatusPayload {
  mpesa: ConnectivityCheckPayload
  fiscal: ConnectivityCheckPayload
  printer: ConnectivityCheckPayload
}

/** Which integration a badge/modal refers to. */
export type ConnectivityIntegration = 'mpesa' | 'fiscal' | 'printer' | 'barcode'

/** Barcode scanner state — there is no way to detect a keyboard-wedge scanner passively, only via a manual test. */
export type BarcodeStatus = 'unknown' | 'connected'

/** Props for {@link ConnectivityBadges}. */
export interface ConnectivityBadgesProps {
  status: ConnectivityStatusPayload | null
  barcodeStatus: BarcodeStatus
  onSelect: (integration: ConnectivityIntegration) => void
}

/** Visual classes for a badge's connected/disconnected/unknown state. */
const BADGE_STYLES = {
  connected: 'bg-emerald-100 text-emerald-700',
  disconnected: 'bg-rose-100 text-rose-700',
  unknown: 'bg-slate-100 text-slate-500'
} as const

/**
 * Compact, clickable status badges for M-Pesa, the fiscal device, the
 * barcode scanner, and the receipt printer — sits next to the
 * existing "Online" badge. Each badge opens the connectivity details
 * modal for that integration when clicked.
 *
 * @param {ConnectivityBadgesProps} props
 * @returns {JSX.Element}
 */
export default function ConnectivityBadges({ status, barcodeStatus, onSelect }: ConnectivityBadgesProps) {
  const mpesaConnected = status?.mpesa.connected ?? false
  const fiscalConnected = status?.fiscal.connected ?? false
  const printerConnected = status?.printer.connected ?? false

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => onSelect('mpesa')}
        title={`M-Pesa: ${mpesaConnected ? 'Connected' : 'Disconnected'}`}
        className={`flex items-center gap-1 rounded-full px-2 py-1 text-sm font-medium ${BADGE_STYLES[mpesaConnected ? 'connected' : 'disconnected']}`}
      >
        {mpesaConnected ? '✓' : '✗'} M-Pesa
      </button>
      <button
        type="button"
        onClick={() => onSelect('fiscal')}
        title={`Fiscal Device: ${fiscalConnected ? 'Connected' : 'Disconnected'}`}
        className={`flex items-center gap-1 rounded-full px-2 py-1 text-sm font-medium ${BADGE_STYLES[fiscalConnected ? 'connected' : 'disconnected']}`}
      >
        {fiscalConnected ? '✓' : '✗'} Fiscal
      </button>
      <button
        type="button"
        onClick={() => onSelect('barcode')}
        title={`Barcode Scanner: ${barcodeStatus === 'connected' ? 'Connected' : 'Unknown'}`}
        className={`flex items-center gap-1 rounded-full px-2 py-1 text-sm font-medium ${BADGE_STYLES[barcodeStatus === 'connected' ? 'connected' : 'unknown']}`}
      >
        {barcodeStatus === 'connected' ? '✓' : '?'} Scanner
      </button>
      <button
        type="button"
        onClick={() => onSelect('printer')}
        title={`Receipt Printer: ${printerConnected ? 'Connected' : 'Disconnected'}`}
        className={`flex items-center gap-1 rounded-full px-2 py-1 text-sm font-medium ${BADGE_STYLES[printerConnected ? 'connected' : 'disconnected']}`}
      >
        {printerConnected ? '✓' : '✗'} Printer
      </button>
    </div>
  )
}
