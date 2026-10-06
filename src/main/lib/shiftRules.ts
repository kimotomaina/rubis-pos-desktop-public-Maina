/**
 * The rules of one shift per window (docs/phase-232): who may open or close a shift when, and the words the till
 * says when it refuses. Pure, so the same rule runs in the screens' read-only status and, again, inside the
 * transaction that writes: the status is a courtesy, the transaction is the guard.
 */

import { shiftEndClock, shiftName, windowClosableFrom, type ShiftWindowInstance } from './shiftWindows.js'

export const AUTO_SHIFT_REASON = 'Created automatically for sales with no shift'
/**
 * @param {number} shiftId — a closed shift a sale would be taken out of
 * @returns {string}
 */
export function closedShiftKeepsSalesMessage(shiftId: number): string {
  return `Shift #${shiftId} is closed. A sale cannot be taken out of a closed shift.`
}

/**
 * Why a closed shift cannot be changed by a person (docs/phase-243): only the latest closed shift can be corrected or
 * be given sales. An older one is frozen.
 *
 * @param {number} shiftId — the closed shift someone tried to change
 * @param {number | null} latestClosedId — the latest closed shift, or `null` when this one was merged into another
 * @returns {string}
 */
export function frozenShiftMessage(shiftId: number, latestClosedId: number | null): string {
  return latestClosedId === null || latestClosedId === shiftId
    ? `Shift #${shiftId} was merged into another shift and can no longer be changed.`
    : `Shift #${shiftId} is closed and is not the latest closed shift (#${latestClosedId}). Only the latest closed shift can be corrected or be given sales.`
}

/** Why the till merged two shifts of one window by itself (docs/phase-242). */
export const AUTO_MERGE_REASON = 'Merged automatically: a window has one shift'
export const OPENED_WITH_EARLIER_SALES_REASON = 'Earlier sales in this window joined when the shift opened'
export const STALE_EARLIER_SALES_MESSAGE = 'Sales were made while this form was open. Count the drawer again.'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * @param {string} date — `YYYY-MM-DD`
 * @returns {string} for example `5 Oct 2026`
 */
export function windowDateText(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  return `${day} ${MONTHS[month - 1]} ${year}`
}

/**
 * @param {number} amount
 * @returns {string} for example `Ksh 1,200.00`
 */
export function kshText(amount: number): string {
  return `Ksh ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/**
 * @param {ShiftWindowInstance} window
 * @returns {string} for example `Night shift, 5 Oct 2026`
 */
export function windowName(window: ShiftWindowInstance): string {
  return `${shiftName(window.type)}, ${windowDateText(window.startDate)}`
}

/**
 * @param {ShiftWindowInstance} window
 * @param {number} shiftId — the shift that already holds the window
 * @returns {string}
 */
export function windowHasShiftMessage(window: ShiftWindowInstance, shiftId: number): string {
  return `${windowName(window)} already has shift #${shiftId}. A window has one shift.`
}

/**
 * @param {number} drawer — the cash counted now
 * @param {number} earlierCash — the cash sales already made in the window
 * @returns {string}
 */
export function drawerBelowEarlierMessage(drawer: number, earlierCash: number): string {
  return `The drawer (${kshText(drawer)}) holds less than the cash sales already made in this window (${kshText(earlierCash)}). Count the drawer again.`
}

/**
 * @param {number} balance — the M-Pesa balance read now
 * @param {number} earlierMpesa — the M-Pesa sales already made in the window
 * @returns {string}
 */
export function mpesaBelowEarlierMessage(balance: number, earlierMpesa: number): string {
  return `The M-Pesa balance (${kshText(balance)}) is less than the M-Pesa sales already made in this window (${kshText(earlierMpesa)}). Read the balance again, or leave it blank.`
}

/**
 * @param {number} drawer
 * @param {number} earlierCash
 * @returns {string} what the opening record says when an admin chose to start at 0
 */
export function startedAtZeroReason(drawer: number, earlierCash: number): string {
  return `Started at 0 by an admin: the drawer (${kshText(drawer)}) held ${kshText(earlierCash - drawer)} less than the earlier cash sales (${kshText(earlierCash)})`
}

/** Whether a shift may be closed yet, and if not, what to say. */
export interface CloseTiming {
  allowed: boolean
  message: string | null
  /** The first instant the shift may be closed, as an ISO time. */
  closableFromIso: string
}

/**
 * Whether a shift may be closed at `nowMs` (docs/phase-232): from the start of its window's last minute, for
 * everyone. A shift left open past its window may be closed at any time after.
 *
 * @param {string} clockInIso
 * @param {ShiftWindowInstance} window — the window of `clockInIso`
 * @param {number} nowMs
 * @returns {CloseTiming}
 */
export function closeTiming(clockInIso: string, window: ShiftWindowInstance, nowMs: number): CloseTiming {
  const from = windowClosableFrom(clockInIso)
  const allowed = nowMs >= from
  return {
    allowed,
    closableFromIso: new Date(from).toISOString(),
    message: allowed ? null : `${shiftName(window.type)} can be closed from ${shiftEndClock(window.type)}. Selling can carry on.`
  }
}
