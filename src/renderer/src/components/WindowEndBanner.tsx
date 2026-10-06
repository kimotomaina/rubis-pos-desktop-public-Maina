import type { ShiftWindowStatus } from '../../../main/services/shift-window-status.js'

/**
 * Whether the open shift's window has reached its last minute, so the drawer should be counted and the shift
 * closed (docs/phase-232, S3). Decided by the main process (`closeAllowed`), never by the screen's own clock.
 *
 * @param {ShiftWindowStatus | null} status
 * @returns {boolean}
 */
export function shouldShowWindowEndBanner(status: ShiftWindowStatus | null): boolean {
  return status?.openShift?.closeAllowed === true
}

/**
 * The cart's window-end banner (docs/phase-232, S3): a fixed-height strip in the slot the "No shift open" bar uses
 * (the two never show together: this one needs an open shift). Selling carries on, and sales made before the shift
 * is closed stay on it.
 *
 * @param {{ status: ShiftWindowStatus }} props
 * @returns {JSX.Element}
 */
export default function WindowEndBanner({ status }: { status: ShiftWindowStatus }) {
  const open = status.openShift
  if (!open) return null
  return (
    <div
      role="status"
      data-testid="window-end-banner"
      className="mx-4 mt-2 flex shrink-0 items-center rounded-lg bg-amber-50 px-3 py-1.5"
    >
      <span className="min-w-0 truncate text-base font-medium text-amber-900">
        {open.windowName.replace(' shift', '')} window ended at {open.endClock}. Count the drawer and close shift #{open.id}.
      </span>
    </div>
  )
}
