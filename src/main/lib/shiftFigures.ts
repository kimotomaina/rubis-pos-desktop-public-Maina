/**
 * The expected and difference figures of a shift, from the four figures a person types and the shift's sales
 * (docs/phase-224). The same arithmetic `closeShift` and `createRetrospectiveShift` do inline, kept here for the
 * corrections so a correction is worked out exactly as the shift it corrects was.
 */

/**
 * The figures typed in by hand; the M-Pesa ones and the card one are optional (`null` is "not recorded", never 0).
 * `cardClosingBalance` (docs/phase-246, R5) is what the PDQ settlement showed at close; absent is the same as `null`,
 * so a caller from before the phase is unchanged.
 */
export interface ShiftEnteredFigures {
  startingCash: number
  endingCash: number
  mpesaOpeningBalance: number | null
  mpesaClosingBalance: number | null
  cardClosingBalance?: number | null
}

/** What follows from them. M-Pesa expected is kept only with a counted balance beside it, as on a closed shift. */
export interface ShiftWorkedFigures {
  expectedCash: number
  discrepancy: number
  mpesaExpected: number | null
  mpesaDifference: number | null
  /**
   * The shift's card sales and the counted settlement less them (docs/phase-246, R5). Present only when a card figure
   * was counted: expected is kept only with a counted figure beside it, as M-Pesa's is.
   */
  cardExpected?: number
  cardDifference?: number
}

/**
 * @param {ShiftEnteredFigures} entered
 * @param {number} cashSales — the shift's non-voided cash sales
 * @param {number} mpesaSales — the shift's non-voided M-Pesa sales
 * @param {number} [cardSales] — the shift's non-voided card sales (docs/phase-246, R5)
 * @returns {ShiftWorkedFigures}
 */
export function workShiftFigures(
  entered: ShiftEnteredFigures,
  cashSales: number,
  mpesaSales: number,
  cardSales = 0
): ShiftWorkedFigures {
  const expectedCash = entered.startingCash + cashSales
  const bothMpesa = entered.mpesaOpeningBalance !== null && entered.mpesaClosingBalance !== null
  const mpesaExpected = bothMpesa ? (entered.mpesaOpeningBalance as number) + mpesaSales : null
  const cardCounted = entered.cardClosingBalance ?? null
  return {
    expectedCash,
    discrepancy: entered.endingCash - expectedCash,
    mpesaExpected,
    mpesaDifference: mpesaExpected !== null ? (entered.mpesaClosingBalance as number) - mpesaExpected : null,
    ...(cardCounted !== null ? { cardExpected: cardSales, cardDifference: cardCounted - cardSales } : {})
  }
}

/** Whether two sets of entered figures are the same; a correction that changes nothing is refused. */
export function sameEnteredFigures(a: ShiftEnteredFigures, b: ShiftEnteredFigures): boolean {
  return (
    a.startingCash === b.startingCash &&
    a.endingCash === b.endingCash &&
    a.mpesaOpeningBalance === b.mpesaOpeningBalance &&
    a.mpesaClosingBalance === b.mpesaClosingBalance &&
    (a.cardClosingBalance ?? null) === (b.cardClosingBalance ?? null)
  )
}
