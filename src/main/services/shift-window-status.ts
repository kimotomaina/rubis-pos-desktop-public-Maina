/**
 * What the screens need to know about the shift window (docs/phase-232), read-only: the window of this moment and
 * its shift, the earlier sales an Open Shift would bring in, and when the open shift may be closed. The rules are
 * the ones the writes use; this only reports them, so a screen carries no time rule of its own.
 */

import { planAutoAssignment } from '../lib/autoAssign.js'
import { closeTiming, windowHasShiftMessage } from '../lib/shiftRules.js'
import {
  sameWindow,
  shiftEndClock,
  shiftName,
  shiftWindowLabel,
  shiftWindowOf,
  type ShiftType
} from '../lib/shiftWindows.js'
import type { EarlierSalesShown, RubisDatabase, UnattachedSaleRow } from './database.js'

/** What {@link getShiftWindowStatus} needs from the database. */
export type ShiftWindowStatusDb = Pick<
  RubisDatabase,
  'getOpenShift' | 'listShiftWindows' | 'listUnattachedSales' | 'listAbsorbedShiftIds'
>

/** The status of the shift window. */
export interface ShiftWindowStatus {
  /** The window of this moment. */
  window: { type: ShiftType; startDate: string; label: string; name: string; endClock: string }
  /** The shift that already holds this window, open or closed, or `null`. */
  windowShift: { id: number; open: boolean } | null
  /** What to say when the window already has its shift (docs/phase-232, S1); `null` when it has none. */
  windowShiftMessage: string | null
  /** Sales already made in this window with no shift: they join the shift when it opens. */
  earlier: EarlierSalesShown
  /** The open shift, with when it may be closed; `null` when none is open. */
  openShift: {
    id: number
    windowType: ShiftType
    windowName: string
    endClock: string
    closableFromIso: string
    closeAllowed: boolean
    closeMessage: string | null
  } | null
}

/**
 * @param {ShiftWindowStatusDb} db
 * @param {number} [nowMs]
 * @returns {ShiftWindowStatus}
 */
export function getShiftWindowStatus(db: ShiftWindowStatusDb, nowMs: number = Date.now()): ShiftWindowStatus {
  const window = shiftWindowOf(new Date(nowMs).toISOString())
  const shifts = db.listShiftWindows()
  // The shift that holds the window is one that was not merged into another (docs/phase-242).
  const absorbed = new Set(db.listAbsorbedShiftIds())
  const inWindow = (shift: { clock_in: string }): boolean => {
    try {
      return sameWindow(shiftWindowOf(shift.clock_in), window)
    } catch {
      return false
    }
  }
  const holder = shifts.find((shift) => !absorbed.has(shift.id) && inWindow(shift)) ?? shifts.find(inWindow)
  const sales = db.listUnattachedSales()
  const byId = new Map(sales.map((sale) => [sale.local_id, sale]))
  const waiting = holder
    ? []
    : planAutoAssignment(sales, shifts, nowMs).waiting.map((id) => byId.get(id) as UnattachedSaleRow)
  const totalFor = (method: string): number =>
    Math.round(
      waiting.filter((sale) => sale.payment_method === method).reduce((sum, sale) => sum + sale.total, 0) * 100
    ) / 100

  const open = db.getOpenShift()
  let openShift: ShiftWindowStatus['openShift'] = null
  if (open) {
    const openWindow = shiftWindowOf(open.clock_in)
    const timing = closeTiming(open.clock_in, openWindow, nowMs)
    openShift = {
      id: open.id,
      windowType: openWindow.type,
      windowName: shiftName(openWindow.type),
      endClock: shiftEndClock(openWindow.type),
      closableFromIso: timing.closableFromIso,
      closeAllowed: timing.allowed,
      closeMessage: timing.message
    }
  }
  return {
    window: {
      type: window.type,
      startDate: window.startDate,
      label: shiftWindowLabel(window.type),
      name: shiftName(window.type),
      endClock: shiftEndClock(window.type)
    },
    windowShift: holder ? { id: holder.id, open: open?.id === holder.id } : null,
    windowShiftMessage: holder ? windowHasShiftMessage(window, holder.id) : null,
    earlier: { count: waiting.length, cash: totalFor('cash'), mpesa: totalFor('mpesa') },
    openShift
  }
}
