/**
 * Mandatory eTIMS configuration gate — decides whether this till may
 * proceed past the setup gate to the main POS UI.
 *
 * Real eTIMS mode has no usable defaults for its four connection
 * fields (unlike mock mode), so an install left unconfigured used to
 * reach checkout and crash against an unreachable fiscal device with
 * an HTTP 500. This module is the pure decision logic behind the
 * `setup:check-etims-completion` IPC handler, kept separate from
 * `main/index.ts` so it can be unit tested without a database.
 */

/** The four eTIMS connection fields a Real-eTIMS till must have configured. */
export interface EtimsRequiredConfig {
  baseUrl?: string
  deviceIp?: string
  devicePort?: string
  password?: string
}

/** Result of {@link checkEtimsCompletion}. */
export interface EtimsCompletionStatus {
  isComplete: boolean
  missingFields: string[]
}

/** Fields required for Real eTIMS, in the order surfaced to the setup gate's form. */
export const REQUIRED_ETIMS_FIELDS = ['baseUrl', 'deviceIp', 'devicePort', 'password'] as const

/**
 * Reports whether a till may proceed past the eTIMS setup gate.
 *
 * @param {boolean} mockEtimsEnabled — mock mode has no connection
 *   fields to configure, so it is always complete.
 * @param {EtimsRequiredConfig} config — the till's stored `etims`
 *   integration config.
 * @returns {EtimsCompletionStatus}
 */
export function checkEtimsCompletion(
  mockEtimsEnabled: boolean,
  config: EtimsRequiredConfig
): EtimsCompletionStatus {
  if (mockEtimsEnabled) {
    return { isComplete: true, missingFields: [] }
  }
  const missingFields = REQUIRED_ETIMS_FIELDS.filter((field) => !config[field]?.trim())
  return { isComplete: missingFields.length === 0, missingFields }
}
