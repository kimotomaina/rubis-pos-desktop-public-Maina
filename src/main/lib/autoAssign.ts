/**
 * Which shift each sale with no shift belongs to (docs/phase-232). Pure: it reads sales and shifts and says what
 * to do; {@link RubisDatabase.autoAssignUnattachedSales} does it, in one transaction, with the guards.
 *
 * For every sale, in this order:
 * 1. a sale made inside an existing shift's times belongs to that shift;
 * 2. otherwise it belongs to the shift of its window. A window holding more than one shift gives the nearest one
 *    in time, and on a tie the lower id;
 * 3. a window with no shift that has ended gets a new shift, made for its sales;
 * 4. a window with no shift that is still the current one leaves its sales waiting: they join the shift the moment
 *    it opens.
 */

import { findOverlappingShift } from './pastShift.js'
import { shiftWindowOf, sameWindow, type ShiftType, type ShiftWindowInstance } from './shiftWindows.js'

/** The part of a sale the plan reads. */
export interface PlanSale {
  local_id: number
  created_at: string
}

/** The part of a shift the plan reads. */
export interface PlanShift {
  id: number
  clock_in: string
  /** `NULL` while the shift is open. */
  clock_out: string | null
}

/** Sales that join an existing shift, all for one reason. */
export interface JoinPlan {
  shiftId: number
  orderIds: number[]
  reason: string
}

/** A shift to create for the sales of one ended window. */
export interface CreatePlan {
  windowType: ShiftType
  windowDate: string
  startIso: string
  endIso: string
  orderIds: number[]
}

/** What to do with every sale that has no shift. */
export interface AutoAssignPlan {
  joins: JoinPlan[]
  creates: CreatePlan[]
  /** Sales left alone because the current window has no shift yet; they join it the moment it opens. */
  waiting: number[]
  /** Sales whose time cannot be read: never assigned, never counted as waiting. */
  unreadable: number[]
}

export const JOIN_INSIDE_REASON = 'Sales with no shift joined this shift automatically: they were made inside its times'
export const JOIN_WINDOW_REASON = 'Sales with no shift joined this shift automatically: they were made in its window'

/**
 * @param {number} shiftCount
 * @returns {string}
 */
export function joinNearestReason(shiftCount: number): string {
  return `Sales with no shift joined this shift automatically: the nearest of ${shiftCount} shifts in their window`
}

const MINUTE_MS = 60_000

/**
 * Milliseconds from a time to a shift's span; 0 inside it. An open shift runs on for ever.
 *
 * @param {number} timeMs
 * @param {PlanShift} shift
 * @returns {number}
 */
function distanceToShift(timeMs: number, shift: PlanShift): number {
  const start = Date.parse(shift.clock_in)
  const end = shift.clock_out === null ? Number.POSITIVE_INFINITY : Date.parse(shift.clock_out)
  if (timeMs < start) return start - timeMs
  if (timeMs > end) return timeMs - end
  return 0
}

/**
 * The shift nearest in time; the lower id on a tie.
 *
 * @param {number} timeMs
 * @param {PlanShift[]} shifts — at least one
 * @returns {PlanShift}
 */
function nearestShift(timeMs: number, shifts: PlanShift[]): PlanShift {
  return shifts.reduce((best, shift) => {
    const bestDistance = distanceToShift(timeMs, best)
    const distance = distanceToShift(timeMs, shift)
    return distance < bestDistance || (distance === bestDistance && shift.id < best.id) ? shift : best
  })
}

/**
 * The period for a shift made for sales: the whole minutes from the first sale to the last, held back to 1 ms from
 * a shift that ends before the first sale or starts after the last (as in docs/phase-229), so it touches none.
 *
 * @param {number} firstMs
 * @param {number} lastMs
 * @param {PlanShift[]} shifts
 * @returns {{ startMs: number; endMs: number }}
 */
function periodFor(firstMs: number, lastMs: number, shifts: PlanShift[]): { startMs: number; endMs: number } {
  let startMs = Math.floor(firstMs / MINUTE_MS) * MINUTE_MS
  let endMs = Math.floor(lastMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS - 1
  for (const shift of shifts) {
    const shiftStart = Date.parse(shift.clock_in)
    const shiftEnd = shift.clock_out === null ? Number.NaN : Date.parse(shift.clock_out)
    if (!Number.isNaN(shiftEnd) && shiftEnd < firstMs) startMs = Math.max(startMs, shiftEnd + 1)
    if (shiftStart > lastMs) endMs = Math.min(endMs, shiftStart - 1)
  }
  return { startMs, endMs }
}

/**
 * @param {PlanSale[]} sales — sales with no shift that are not voided, oldest first
 * @param {PlanShift[]} shifts — every shift
 * @param {number} nowMs
 * @param {Map<number, number>} [absorbedInto] — shifts merged into another (docs/phase-242), absorbed id to survivor id.
 *   An absorbed shift still occupies its time but is never given a sale: one made inside its times, or nearest to it,
 *   goes to the shift that holds the window now.
 * @returns {AutoAssignPlan}
 */
export function planAutoAssignment(
  sales: PlanSale[],
  shifts: PlanShift[],
  nowMs: number,
  absorbedInto: Map<number, number> = new Map()
): AutoAssignPlan {
  const currentWindow = shiftWindowOf(new Date(nowMs).toISOString())
  const shiftWindows = shifts.flatMap((shift) => {
    try {
      return [{ shift, window: shiftWindowOf(shift.clock_in) }]
    } catch {
      return []
    }
  })
  const readable = shifts.filter((shift) => !Number.isNaN(Date.parse(shift.clock_in)))
  const joins = new Map<string, JoinPlan>()
  const newWindows = new Map<string, { window: ShiftWindowInstance; sales: Array<{ id: number; ms: number }> }>()
  const waiting: number[] = []
  const unreadable: number[] = []

  const join = (shiftId: number, reason: string, orderId: number): void => {
    const key = `${shiftId}|${reason}`
    const existing = joins.get(key)
    if (existing) existing.orderIds.push(orderId)
    else joins.set(key, { shiftId, orderIds: [orderId], reason })
  }

  for (const sale of sales) {
    const saleMs = Date.parse(sale.created_at)
    let window: ShiftWindowInstance
    try {
      window = shiftWindowOf(sale.created_at)
    } catch {
      unreadable.push(sale.local_id)
      continue
    }
    const inside = findOverlappingShift(readable, saleMs, saleMs)
    if (inside) {
      join(absorbedInto.get(inside.id) ?? inside.id, JOIN_INSIDE_REASON, sale.local_id)
      continue
    }
    const inWindow = shiftWindows
      .filter((entry) => sameWindow(entry.window, window) && !absorbedInto.has(entry.shift.id))
      .map((entry) => entry.shift)
    if (inWindow.length > 0) {
      const target = nearestShift(saleMs, inWindow)
      join(target.id, inWindow.length > 1 ? joinNearestReason(inWindow.length) : JOIN_WINDOW_REASON, sale.local_id)
    } else if (!sameWindow(window, currentWindow)) {
      const key = `${window.type}|${window.startDate}`
      const group = newWindows.get(key)
      if (group) group.sales.push({ id: sale.local_id, ms: saleMs })
      else newWindows.set(key, { window, sales: [{ id: sale.local_id, ms: saleMs }] })
    } else {
      waiting.push(sale.local_id)
    }
  }

  const creates: CreatePlan[] = Array.from(newWindows.values()).map(({ window, sales: group }) => {
    const times = group.map((sale) => sale.ms)
    const { startMs, endMs } = periodFor(Math.min(...times), Math.max(...times), readable)
    return {
      windowType: window.type,
      windowDate: window.startDate,
      startIso: new Date(startMs).toISOString(),
      endIso: new Date(endMs).toISOString(),
      orderIds: group.map((sale) => sale.id)
    }
  })
  return { joins: Array.from(joins.values()), creates, waiting, unreadable }
}
