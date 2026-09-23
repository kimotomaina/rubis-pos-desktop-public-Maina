/**
 * Presentation helpers for the stock-take back-office screen.
 *
 * Display only. Every figure these format has already been computed in
 * the main process against a live Shopify read — nothing here derives a
 * quantity, and nothing here is a source of one.
 */

import type { StockTakeStatus } from '../../../main/services/database.js'

/** Plain-language label for a session's state. */
export const STOCK_TAKE_STATUS_LABELS: Record<StockTakeStatus, string> = {
  open: 'Open',
  counting: 'Counting',
  awaiting_approval: 'Awaiting approval',
  committed: 'Pushed to Shopify',
  abandoned: 'Discarded'
}

/** Tailwind classes for a session's status pill. */
export const STOCK_TAKE_STATUS_CLASSES: Record<StockTakeStatus, string> = {
  open: 'bg-slate-100 text-slate-700',
  counting: 'bg-sky-100 text-sky-800',
  awaiting_approval: 'bg-amber-100 text-amber-800',
  committed: 'bg-emerald-100 text-emerald-800',
  abandoned: 'bg-slate-100 text-slate-500'
}

/**
 * Renders a variance with an explicit sign, so "3" is never read as a
 * shortfall when it is a surplus.
 *
 * @param {number} variance
 * @returns {string}
 */
export function formatVariance(variance: number): string {
  if (variance === 0) return '0'
  return variance > 0 ? `+${variance}` : String(variance)
}

/**
 * Tailwind colour for a variance figure — surplus, shortfall, or
 * agreement.
 *
 * @param {number} variance
 * @returns {string}
 */
export function varianceClass(variance: number): string {
  if (variance === 0) return 'text-slate-500'
  return variance > 0 ? 'text-emerald-700' : 'text-rose-700'
}

/**
 * Sentence describing what a commit will do, for the confirmation step.
 *
 * @param {object} totals
 * @returns {string}
 */
export function describeCommit(totals: {
  pushableLines: number
  totalUnitsMoving: number
}): string {
  const lines = `${totals.pushableLines} item${totals.pushableLines === 1 ? '' : 's'}`
  const units = `${totals.totalUnitsMoving} unit${totals.totalUnitsMoving === 1 ? '' : 's'}`
  return `This will change ${lines} in Shopify, moving ${units} of stock.`
}
