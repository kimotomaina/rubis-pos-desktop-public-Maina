/**
 * The `shifts:correct` request as the renderer sends it (docs/phase-224); validated by `shiftCorrectionSchema`.
 * The four figures are what they should now be, in full; the M-Pesa ones are `null` for "not recorded".
 */
export interface ShiftCorrectionRequest {
  managerId: number
  managerPin: string
  shiftId: number
  startingCash: number
  endingCash: number
  mpesaOpeningBalance: number | null
  mpesaClosingBalance: number | null
  /** The card settlement read from the PDQ; absent or `null` is "not recorded" (docs/phase-246, R5). */
  cardClosingBalance?: number | null
  reason: string
  /** An admin correcting a closed shift that is not the latest (docs/phase-244). */
  override?: boolean
}
