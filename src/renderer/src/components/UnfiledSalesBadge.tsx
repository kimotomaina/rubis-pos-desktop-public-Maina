import { describeUnfiledCount } from '../lib/unfiledCount.js'

/** Props for {@link UnfiledSalesBadge}. */
export interface UnfiledSalesBadgeProps {
  /** `null` before the first read completes — renders nothing rather than a flash of "0". */
  count: number | null
  onClick: () => void
}

const TONE_STYLES = {
  quiet: 'bg-slate-100 text-slate-500',
  alert: 'bg-amber-100 text-amber-800'
} as const

/**
 * The always-visible "are sales filing" signal (phase-95, closing the
 * go-live plan's own verification step): every completed-but-unfiled
 * sale, tappable to open the Needs Attention list. Reads calm and quiet
 * at zero, noticeable once there's something to look at — this is the
 * real signal Finding 4 asked for, since the header's "✓ Fiscal Server"
 * badge only ever proves the server answered an HTTP probe, not that
 * sales are filing.
 *
 * @param {UnfiledSalesBadgeProps} props
 * @returns {JSX.Element | null}
 */
export default function UnfiledSalesBadge({ count, onClick }: UnfiledSalesBadgeProps) {
  if (count === null) return null
  const { label, tone } = describeUnfiledCount(count)

  return (
    <button
      type="button"
      onClick={onClick}
      title="Sales not yet filed with the fiscal device. Tap to review."
      className={`flex shrink-0 items-center gap-1 rounded-full px-3 py-1 text-sm font-medium transition hover:opacity-80 ${TONE_STYLES[tone]}`}
    >
      {label}
    </button>
  )
}
