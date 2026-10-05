/**
 * The expected and difference figures of a shift, from the four figures a person types and the shift's sales
 * (docs/phase-224). The same arithmetic `closeShift` and `createRetrospectiveShift` do inline, kept here for the
 * corrections so a correction is worked out exactly as the shift it corrects was.
 */

/** The four figures typed in by hand; the M-Pesa ones are optional (`null` is "not recorded", never 0). */
export interface ShiftEnteredFigures {
  startingCash: number
  endingCash: number
  mpesaOpeningBalance: number | null
  mpesaClosingBalance: number | null
}

/** What follows from them. M-Pesa expected is kept only with a counted balance beside it, as on a closed shift. */
export interface ShiftWorkedFigures {
  expectedCash: number
  discrepancy: number
  mpesaExpected: number | null
  mpesaDifference: number | null
}

/**
 * @param {ShiftEnteredFigures} entered
 * @param {number} cashSales — the shift's non-voided cash sales
 * @param {number} mpesaSales — the shift's non-voided M-Pesa sales
 * @returns {ShiftWorkedFigures}
 */
export function workShiftFigures(
  entered: ShiftEnteredFigures,
  cashSales: number,
  mpesaSales: number
): ShiftWorkedFigures {
  const expectedCash = entered.startingCash + cashSales
  const bothMpesa = entered.mpesaOpeningBalance !== null && entered.mpesaClosingBalance !== null
  const mpesaExpected = bothMpesa ? (entered.mpesaOpeningBalance as number) + mpesaSales : null
  return {
    expectedCash,
    discrepancy: entered.endingCash - expectedCash,
    mpesaExpected,
    mpesaDifference: mpesaExpected !== null ? (entered.mpesaClosingBalance as number) - mpesaExpected : null
  }
}

/** Whether two sets of entered figures are the same; a correction that changes nothing is refused. */
export function sameEnteredFigures(a: ShiftEnteredFigures, b: ShiftEnteredFigures): boolean {
  return (
    a.startingCash === b.startingCash &&
    a.endingCash === b.endingCash &&
    a.mpesaOpeningBalance === b.mpesaOpeningBalance &&
    a.mpesaClosingBalance === b.mpesaClosingBalance
  )
}
