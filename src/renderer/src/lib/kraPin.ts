/**
 * KRA PIN format helpers for the checkout's optional B2B customer PIN
 * field — kept framework-free so they're unit-testable without
 * mounting `PosCheckoutPanel`.
 */

/** Maximum length of a standard KRA PIN (e.g. `P051234567Z`). */
export const KRA_PIN_MAX_LENGTH = 11

/**
 * Checks a KRA PIN's shape — one letter (`P` or `A`), nine digits, one
 * trailing letter. This is a format sanity check only, not proof the
 * PIN is registered with KRA; checkout is never blocked on it (KRA's
 * own format has edge cases this basic check can't cover), so callers
 * should surface a warning rather than disable submission.
 *
 * @param {string} pin
 * @returns {boolean}
 */
export function isValidKraPinFormat(pin: string): boolean {
  return /^[PA]\d{9}[A-Z]$/.test(pin.trim().toUpperCase())
}
