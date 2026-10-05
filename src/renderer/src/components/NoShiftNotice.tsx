interface NoShiftNoticeProps {
  /** Why the button is off (a payment is in progress), or `null` when it is on. */
  blockedReason: string | null
  onOpenShift: () => void
}

/**
 * The cart's "No shift open" bar (docs/phase-227): a fixed-height strip above the held sales. Selling is never
 * refused: a sale made with no shift joins the shift of its window by itself (docs/phase-231), when the window has
 * one or when it opens, which is what this bar says and offers.
 *
 * @param {NoShiftNoticeProps} props
 * @returns {JSX.Element}
 */
export default function NoShiftNotice({ blockedReason, onOpenShift }: NoShiftNoticeProps) {
  return (
    <div
      role="status"
      data-testid="no-shift-notice"
      className="mx-4 mt-2 flex shrink-0 items-center justify-between gap-3 rounded-lg bg-amber-50 px-3 py-1.5"
    >
      <span className="min-w-0 truncate text-base font-medium text-amber-900">
        No shift open. Sales made now join the shift of this window.
      </span>
      <button
        type="button"
        onClick={onOpenShift}
        disabled={blockedReason !== null}
        title={blockedReason ?? undefined}
        className="h-10 shrink-0 rounded-lg bg-rose-600 px-4 text-base font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Open shift
      </button>
    </div>
  )
}
