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
  reason: string
}
