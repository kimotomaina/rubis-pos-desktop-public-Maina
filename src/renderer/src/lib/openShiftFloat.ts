/**
 * What the Open Shift form shows before it is confirmed (docs/phase-231, S6): when sales were already made in this
 * window with no shift, they join the new shift, and the float stored is the drawer count less their cash, so they
 * are not counted twice. The main process works the same sum again when the shift is opened and refuses if the
 * sales it finds are not the ones shown here; this is only the display of it.
 */

import type { EarlierSalesShown } from '../../../main/services/database.js'

/** The figures the form shows. */
export interface FloatPreview {
  /** The cash counted in the drawer, or `null` while it is blank or not a number. */
  drawer: number | null
  /** The starting cash that will be recorded; `null` while there is no drawer count. */
  float: number | null
  /** The drawer holds less than the earlier cash sales: confirming needs an admin's choice to start at 0. */
  belowZero: boolean
  /** How much the drawer is short of the earlier cash sales when `belowZero`. */
  shortfall: number
  /** The M-Pesa opening balance that will be recorded; `null` while blank, or when it would be below 0. */
  mpesaOpening: number | null
  /** The M-Pesa balance typed is less than the earlier M-Pesa sales. */
  mpesaBelowZero: boolean
}

/**
 * @param {number} amount
 * @returns {number} rounded to cents
 */
function roundMoney(amount: number): number {
  return Math.round(amount * 100) / 100
}

/**
 * @param {string} drawerText — what was typed for the cash counted now
 * @param {string} mpesaText — what was typed for the M-Pesa balance now (blank is "not recorded")
 * @param {EarlierSalesShown} earlier
 * @returns {FloatPreview}
 */
export function previewOpenFloat(drawerText: string, mpesaText: string, earlier: EarlierSalesShown): FloatPreview {
  const drawer = drawerText.trim() === '' ? Number.NaN : Number(drawerText)
  const hasDrawer = Number.isFinite(drawer) && drawer >= 0
  const raw = hasDrawer ? roundMoney(drawer - earlier.cash) : null
  const mpesa = mpesaText.trim() === '' ? Number.NaN : Number(mpesaText)
  const hasMpesa = Number.isFinite(mpesa) && mpesa >= 0
  const mpesaRaw = hasMpesa ? roundMoney(mpesa - earlier.mpesa) : null
  return {
    drawer: hasDrawer ? drawer : null,
    float: raw === null ? null : Math.max(raw, 0),
    belowZero: raw !== null && earlier.count > 0 && raw < 0,
    shortfall: raw !== null && raw < 0 ? -raw : 0,
    mpesaOpening: mpesaRaw !== null && mpesaRaw >= 0 ? mpesaRaw : null,
    mpesaBelowZero: mpesaRaw !== null && earlier.count > 0 && mpesaRaw < 0
  }
}
