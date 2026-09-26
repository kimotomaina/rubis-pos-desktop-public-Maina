import { useState } from 'react'
import { describeUnfiledCount } from '../lib/unfiledCount.js'
import type {
  ConnectivityIntegration,
  ConnectivityStatusPayload,
  BarcodeStatus
} from '../types/connectivity.js'

/** Props for {@link NavStatusButton}. */
export interface NavStatusButtonProps {
  online: boolean
  /** `null` before the first read completes — the unfiled row is omitted rather than flashing "0". */
  unfiledCount: number | null
  /** Same handler `App.tsx` gave `UnfiledSalesBadge` before — the admin-only navigate-to-Needs-Attention gate lives there, unchanged. */
  onUnfiledClick: () => void
  connectivityStatus: ConnectivityStatusPayload | null
  barcodeStatus: BarcodeStatus
  /** Same handler `App.tsx` gave `ConnectivityBadges` before — opens the existing per-integration `ConnectivityModal`. */
  onSelectIntegration: (integration: ConnectivityIntegration) => void
}

/** A row's status color: `ok` (working), `bad` (needs attention), `warn` (a softer alert — unfiled sales), `unknown` (not yet determined, e.g. an untested scanner). */
type Tone = 'ok' | 'bad' | 'warn' | 'unknown'

const DOT_STYLES: Record<Tone, string> = {
  ok: 'bg-emerald-500',
  bad: 'bg-rose-500',
  warn: 'bg-amber-500',
  unknown: 'bg-slate-400'
}

const TEXT_STYLES: Record<Tone, string> = {
  ok: 'text-emerald-700',
  bad: 'text-rose-700',
  warn: 'text-amber-700',
  unknown: 'text-slate-500'
}

/** One status line inside the dialog — a plain row if `onClick` is omitted (the network line), a button otherwise. */
function StatusRow({
  label,
  tone,
  detail,
  onClick
}: {
  label: string
  tone: Tone
  detail?: string
  onClick?: () => void
}) {
  const content = (
    <>
      <span aria-hidden className={`h-2.5 w-2.5 shrink-0 rounded-full ${DOT_STYLES[tone]}`} />
      <span className="flex-1 text-left text-base font-medium text-slate-800">{label}</span>
      {detail && <span className={`text-sm font-medium ${TEXT_STYLES[tone]}`}>{detail}</span>}
    </>
  )

  if (!onClick) {
    return <div className="flex items-center gap-3 rounded-lg px-3 py-2.5">{content}</div>
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-slate-50"
    >
      {content}
    </button>
  )
}

/**
 * Consolidates the header's status indicators — Online/Offline, unfiled
 * sales, and the four connectivity badges (M-Pesa, Fiscal Server,
 * Scanner, Printer) — into one button that opens a dialog listing all of
 * them, so the header itself carries only a single item instead of six.
 *
 * The button's own dot is the worst status among all six, so a cashier
 * can tell something needs attention without opening the dialog: red if
 * offline or any of M-Pesa/Fiscal/Printer is disconnected, amber if
 * sales are unfiled, green otherwise. M-Pesa in manual/SMS mode has
 * nothing to be connected to at all (`notApplicable`), so it is excluded
 * from "disconnected" the same way an untested barcode scanner is —
 * neutral, not bad. Each row keeps its original
 * behavior exactly — tapping a connectivity row still opens that
 * integration's own `ConnectivityModal` (via `onSelectIntegration`, the
 * same prop `ConnectivityBadges` took), and tapping the unfiled-sales
 * row still runs `onUnfiledClick` (the same admin-gated navigate that
 * `UnfiledSalesBadge` used) — this component only changes where those
 * triggers live, not what they do.
 *
 * @param {NavStatusButtonProps} props
 * @returns {JSX.Element}
 */
export default function NavStatusButton({
  online,
  unfiledCount,
  onUnfiledClick,
  connectivityStatus,
  barcodeStatus,
  onSelectIntegration
}: NavStatusButtonProps) {
  const [open, setOpen] = useState(false)

  const mpesaConnected = connectivityStatus?.mpesa.connected ?? false
  /**
   * M-Pesa in manual/SMS mode has nothing to be connected or
   * disconnected to (`checkMpesaConnectivity` reports this rather than a
   * false "disconnected") — treated like the barcode scanner's "unknown"
   * below: shown neutrally, and never the reason the overall dot turns red.
   */
  const mpesaNotApplicable = connectivityStatus?.mpesa.notApplicable ?? false
  const fiscalConnected = connectivityStatus?.fiscal.connected ?? false
  const printerConnected = connectivityStatus?.printer.connected ?? false
  const scannerConnected = barcodeStatus === 'connected'
  const unfiled = unfiledCount === null ? null : describeUnfiledCount(unfiledCount)

  const hasBadConnectivity =
    !online || (!mpesaConnected && !mpesaNotApplicable) || !fiscalConnected || !printerConnected
  const overallTone: Tone = hasBadConnectivity ? 'bad' : unfiled?.tone === 'alert' ? 'warn' : 'ok'

  const select = (integration: ConnectivityIntegration) => {
    setOpen(false)
    onSelectIntegration(integration)
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={overallTone === 'ok' ? 'All statuses normal' : 'Some statuses need attention'}
        aria-label="Till status"
        className="flex shrink-0 items-center gap-2 rounded-full bg-slate-100 px-3 py-1 font-medium text-slate-700 transition hover:bg-slate-200"
      >
        <span aria-hidden className={`h-2.5 w-2.5 rounded-full ${DOT_STYLES[overallTone]}`} />
        Status
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            role="dialog"
            aria-label="Till status"
            className="w-full max-w-sm rounded-xl bg-white p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 flex items-center justify-between px-2">
              <h3 className="text-lg font-semibold text-slate-800">Till status</h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-slate-400 hover:text-slate-600"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <div className="space-y-1">
              <StatusRow
                label={online ? 'Online' : 'Offline — sales will queue'}
                tone={online ? 'ok' : 'bad'}
              />
              {unfiled && (
                <StatusRow
                  label={unfiled.label}
                  tone={unfiled.tone === 'alert' ? 'warn' : 'ok'}
                  onClick={() => {
                    setOpen(false)
                    onUnfiledClick()
                  }}
                />
              )}
              <StatusRow
                label="M-Pesa"
                tone={mpesaNotApplicable ? 'unknown' : mpesaConnected ? 'ok' : 'bad'}
                detail={
                  mpesaNotApplicable
                    ? (connectivityStatus?.mpesa.error ?? 'Not applicable')
                    : mpesaConnected
                      ? 'Connected'
                      : 'Disconnected'
                }
                onClick={() => select('mpesa')}
              />
              <StatusRow
                label="Fiscal Server"
                tone={fiscalConnected ? 'ok' : 'bad'}
                detail={fiscalConnected ? 'Reachable' : 'Not reachable'}
                onClick={() => select('fiscal')}
              />
              <StatusRow
                label="Barcode Scanner"
                tone={scannerConnected ? 'ok' : 'unknown'}
                detail={scannerConnected ? 'Connected' : 'Unknown'}
                onClick={() => select('barcode')}
              />
              <StatusRow
                label="Receipt Printer"
                tone={printerConnected ? 'ok' : 'bad'}
                detail={printerConnected ? 'Connected' : 'Disconnected'}
                onClick={() => select('printer')}
              />
            </div>
          </div>
        </div>
      )}
    </>
  )
}
