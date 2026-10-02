/**
 * Checks the device's per-VAT-group figures against the till's own VAT total
 * (docs/phase-198-1), so a slip never prints two VAT figures that disagree
 * without saying so. VIL vendor checklist item 13: reconciling the system
 * amount against the validated amount.
 *
 * The group amounts are read as NET (ex-VAT), the reading the receipt's VAT
 * table already uses. The device's own contract does not say net or gross
 * (docs/phase-194 section 2b), so this reading stands until the live test.
 */

import type { FiscalVatGroupAmounts } from '../services/integrations/etims.js'
import { VAT_CLASS_RATES } from './vatClass.js'

/** Largest gap, in KSh, between the groups' VAT and the till's VAT that still counts as agreeing. */
export const VAT_RECONCILE_TOLERANCE = 0.05

/** The outcome of {@link reconcileVatGroups}. */
export interface VatReconcileResult {
  /** True when the two VAT figures agree within {@link VAT_RECONCILE_TOLERANCE}, or cannot be compared. */
  consistent: boolean
  /** The groups' VAT minus the till's VAT, rounded to two places. */
  diff: number
  /** The VAT the stored groups add up to, read as net. */
  groupVat: number
  /** The VAT the till worked out for the sale. */
  tillVat: number
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Compares the VAT the stored groups imply with the till's VAT total.
 *
 * Each class's VAT is its net amount times the statutory rate, rounded to two
 * places, the same as the printed table. Class D has no fixed rate, so a sale
 * holding any class D amount cannot be compared: it is reported consistent
 * with no difference, rather than guessed at.
 *
 * @param {FiscalVatGroupAmounts} groups the device's figures, as stored
 * @param {{ vatIncluded: number }} tillTotals the till's totals for the sale
 * @returns {VatReconcileResult}
 */
export function reconcileVatGroups(
  groups: FiscalVatGroupAmounts,
  tillTotals: { vatIncluded: number }
): VatReconcileResult {
  const tillVat = round2(tillTotals.vatIncluded)
  let groupVat = 0
  for (const letter of ['A', 'B', 'C', 'D', 'E'] as const) {
    const parsed = Number(groups[letter])
    const amount = Number.isFinite(parsed) ? parsed : 0
    const rate = VAT_CLASS_RATES[letter]
    if (rate === null) {
      if (amount !== 0) return { consistent: true, diff: 0, groupVat: tillVat, tillVat }
      continue
    }
    groupVat += round2(amount * rate)
  }
  groupVat = round2(groupVat)
  const diff = round2(groupVat - tillVat)
  return { consistent: Math.round(Math.abs(diff) * 100) <= Math.round(VAT_RECONCILE_TOLERANCE * 100), diff, groupVat, tillVat }
}
