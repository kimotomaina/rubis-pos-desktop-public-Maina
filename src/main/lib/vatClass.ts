/**
 * Per-item VAT class resolution and the device-group arithmetic that checks
 * it (docs/phase-194). Pure and free of I/O: the one place the class rules
 * live, so checkout, validation, the provider, the receipt and the reports
 * cannot drift apart.
 *
 * The rule is fail-closed. A line with no class, or a blank one, is class A
 * at 16%; a class the till does not know is refused (see
 * `vatClassGate.ts`) and is never filed as A.
 */

import type { FiscalVatGroupAmounts } from '../services/integrations/etims.js'

/** The five device VAT classes: 16% / 8% / 0% / other rate / exempt (docs/phase-65). */
export const VAT_CLASSES = ['A', 'B', 'C', 'D', 'E'] as const

/** One device VAT class letter. */
export type VatClass = (typeof VAT_CLASSES)[number]

/** The class a line carries when it has none of its own. */
export const DEFAULT_VAT_CLASS: VatClass = 'A'

/** HS code shape the device accepts: `XXXX.XX.XX`. */
export const HS_CODE_PATTERN = /^\d{4}\.\d{2}\.\d{2}$/

/** Statutory rate per class; `null` means the class has no fixed rate. */
export const VAT_CLASS_RATES: Record<VatClass, number | null> = { A: 0.16, B: 0.08, C: 0, D: null, E: 0 }

/** Whole cents a sale's group total may differ from the device's by. */
const GROUP_TOLERANCE_CENTS = 1

/** The line fields the group arithmetic reads. */
export interface VatClassLine {
  unitPrice: number
  quantity: number
  vatClass?: string
}

/** Per-class amounts, one entry for every class. */
export type VatGroupTotals = Record<VatClass, number>

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Resolves a raw class to one the till can file.
 *
 * Absent, `null` and blank (whitespace-only) mean class A. Anything else
 * is trimmed and upper-cased, then matched against the five classes.
 *
 * @param {unknown} raw
 * @returns {VatClass | null} the class, or `null` when `raw` names a class the till does not know
 */
export function resolveVatClass(raw: unknown): VatClass | null {
  if (raw === undefined || raw === null) return DEFAULT_VAT_CLASS
  if (typeof raw !== 'string') return null
  const normalised = raw.trim().toUpperCase()
  if (normalised === '') return DEFAULT_VAT_CLASS
  return (VAT_CLASSES as readonly string[]).includes(normalised) ? (normalised as VatClass) : null
}

/**
 * Whether any line resolves to a class other than A.
 *
 * @param {VatClassLine[]} lines
 * @returns {boolean}
 */
export function hasNonAClass(lines: VatClassLine[]): boolean {
  return lines.some((line) => {
    const vatClass = resolveVatClass(line.vatClass)
    return vatClass !== null && vatClass !== DEFAULT_VAT_CLASS
  })
}

/**
 * Sums `unitPrice × quantity` per resolved class. A line whose class is
 * unknown is left out: such a line is refused before it can be filed.
 *
 * @param {VatClassLine[]} lines
 * @returns {VatGroupTotals}
 */
export function expectedGroupTotals(lines: VatClassLine[]): VatGroupTotals {
  const totals: VatGroupTotals = { A: 0, B: 0, C: 0, D: 0, E: 0 }
  for (const line of lines) {
    const vatClass = resolveVatClass(line.vatClass)
    if (vatClass !== null) totals[vatClass] += line.unitPrice * line.quantity
  }
  for (const vatClass of VAT_CLASSES) totals[vatClass] = round2(totals[vatClass])
  return totals
}

/**
 * Compares the device's per-group subtotals with what the sale's lines
 * should have put in each group. Only the non-A groups are compared: group A
 * is covered by the sale-level total check, which sums every group
 * (`buildReconciliationRow`). The device's group amounts are GROSS (VAT
 * included), confirmed by the first live filing (docs/phase-214). A group the
 * device did not return counts as 0.00.
 *
 * @param {VatGroupTotals} expected
 * @param {FiscalVatGroupAmounts} device the raw strings `ReadCurrentReceiptInfo` returned
 * @returns {string | null} every group that disagrees, or `null` when they all agree
 */
export function compareVatGroups(expected: VatGroupTotals, device: FiscalVatGroupAmounts): string | null {
  const disagreements: string[] = []
  for (const letter of VAT_CLASSES) {
    if (letter === DEFAULT_VAT_CLASS) continue
    const raw = device[letter]
    const amount = raw === undefined ? 0 : Number(raw)
    const differenceInCents = Math.abs(Math.round(amount * 100) - Math.round(expected[letter] * 100))
    if (!Number.isFinite(amount) || differenceInCents > GROUP_TOLERANCE_CENTS) {
      disagreements.push(
        `VAT group ${letter}: the device holds ${raw === undefined ? '0.00' : raw} but this sale's ` +
          `class ${letter} items add up to ${expected[letter].toFixed(2)}`
      )
    }
  }
  return disagreements.length > 0 ? disagreements.join('; ') : null
}

/**
 * The net (ex-VAT) amount of a VAT-inclusive gross amount: A is gross x 100/116,
 * B is gross x 100/108, and C, D and E are returned unchanged (docs/phase-198-1).
 * Rounded to two places.
 *
 * @param {VatClass} letter
 * @param {number} gross
 * @returns {number}
 */
export function grossToNet(letter: VatClass, gross: number): number {
  if (letter === 'A') return round2((gross * 100) / 116)
  if (letter === 'B') return round2((gross * 100) / 108)
  return gross
}

/**
 * The VAT inside a VAT-inclusive group amount: A is gross x 16/116, B is gross
 * x 8/108, and C, D and E carry none the till can work out (docs/phase-214).
 * Rounded to two places, the same arithmetic the reports use for a device group.
 *
 * @param {VatClass} letter
 * @param {number} gross
 * @returns {number}
 */
export function grossToVat(letter: VatClass, gross: number): number {
  if (letter === 'A') return round2((gross * 16) / 116)
  if (letter === 'B') return round2((gross * 8) / 108)
  return 0
}
