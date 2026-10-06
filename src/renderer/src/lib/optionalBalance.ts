/** Shown when an optional M-Pesa balance field holds something that is not a balance (docs/phase-222). */
export const MPESA_BALANCE_INVALID = 'Enter a valid M-Pesa balance, or leave it blank'

/** Shown when the optional card settlement field holds something that is not an amount (docs/phase-246, R5). */
export const CARD_BALANCE_INVALID = 'Enter a valid card settlement amount, or leave it blank'

/**
 * Reads an optional balance field (docs/phase-222): blank is `null` ("not recorded"), a number is itself,
 * anything else is `'invalid'`. A blank is never turned into 0, which would read as "the balance was nothing".
 * Shared by the Open and Close Shift forms and the past-shift form (docs/phase-223).
 */
export function parseOptionalBalance(input: string): number | null | 'invalid' {
  if (input.trim() === '') return null
  const value = Number(input)
  return Number.isFinite(value) && value >= 0 ? value : 'invalid'
}

/**
 * Reads a required cash field: a finite number of 0 or more, or `null`.
 */
export function parseRequiredAmount(input: string): number | null {
  if (input.trim() === '') return null
  const value = Number(input)
  return Number.isFinite(value) && value >= 0 ? value : null
}
