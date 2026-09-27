/**
 * Caps how many toasts `ToastStack` actually renders (docs/phase-166
 * Commit E4) — pure and dependency-free, tested directly, same
 * convention as `paginate.ts`.
 *
 * Replaces the old "unlimited toasts, scroll if they overflow" design
 * (`ToastStack`'s `max-h-[70vh] overflow-y-auto`): Phase E's no-scroll
 * rule means the stack must instead simply stop showing more than fit.
 * A pinned toast (FiscalNotice, and since docs/phase-170 also
 * ShopifyCheckNotice) is never one of the ones dropped.
 */

/** At most this many toasts are ever shown at once. */
export const MAX_VISIBLE_TOASTS = 3

/**
 * Picks which of `toasts` should actually render: every pinned toast,
 * plus the most recently arrived routine ones, up to `max` in total.
 * When there isn't room for every routine toast, the OLDEST routine
 * ones are dropped first — a pinned toast is never dropped, even if
 * pinned toasts alone were somehow to exceed `max`. The relative order
 * of whatever remains is unchanged, so a toast's on-screen position
 * never jumps because a sibling above or below it got dropped.
 *
 * @param {T[]} toasts
 * @param {number} [max = MAX_VISIBLE_TOASTS]
 * @returns {T[]}
 */
export function visibleToasts<T extends { pinned?: boolean }>(
  toasts: T[],
  max: number = MAX_VISIBLE_TOASTS
): T[] {
  const pinned = toasts.filter((t) => t.pinned)
  const routine = toasts.filter((t) => !t.pinned)
  const routineSlots = Math.max(0, max - pinned.length)
  const visibleRoutine = new Set(routine.slice(-routineSlots))
  const visiblePinned = new Set(pinned)
  return toasts.filter((t) => visiblePinned.has(t) || visibleRoutine.has(t))
}
