/**
 * Pure helpers for the Admin screen's fiscal device form — kept
 * framework-free (no React import) so they can be unit tested without
 * mounting the component tree.
 *
 * The validation messages here are read by a cashier or branch manager
 * on a touch till, so they name the field and say what a good value
 * looks like. No codes, no field keys, no regex echoed back.
 */

/** URL of the local ZFPLabServer. The trailing slash matters — the `settings()` call concatenates onto it. */
export const DEFAULT_ETIMS_BASE_URL = 'http://localhost:4444/'

/** TCP port of the fiscal device. */
export const DEFAULT_ETIMS_DEVICE_PORT = '8000'

/** VAT class applied when a line item has no product-level tax class configured. */
export const DEFAULT_ETIMS_VAT_CLASS = 'A'

/** Highest valid TCP port number. */
const MAX_PORT = 65535

/**
 * Reports whether `value` is a dotted-quad IPv4 address.
 *
 * Deliberately IPv4-only: the value is typed by hand at a branch and
 * handed to the ZFPLabServer's `settings(ip=…)` string, and no observed
 * Control Unit deployment uses IPv6.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isIpv4Address(value: string): boolean {
  const octets = value.trim().split('.')
  if (octets.length !== 4) return false
  return octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
}

/** One field's validation failure, keyed for the form and phrased for the reader. */
export interface EtimsFieldError {
  field: 'baseUrl' | 'deviceIp' | 'devicePort'
  message: string
}

/** The connection fields {@link validateEtimsConnection} checks. */
export interface EtimsConnectionInput {
  baseUrl: string
  deviceIp: string
  devicePort: string
}

/**
 * Validates the three non-secret connection fields. The password is
 * validated separately — it lives in the credential vault, so a blank
 * box means "leave the saved one alone", not "clear it".
 *
 * @param {EtimsConnectionInput} input
 * @returns {EtimsFieldError[]} empty when every field is acceptable
 */
export function validateEtimsConnection(input: EtimsConnectionInput): EtimsFieldError[] {
  const errors: EtimsFieldError[] = []

  if (!input.baseUrl.trim()) {
    errors.push({
      field: 'baseUrl',
      message: 'Enter the fiscal server address, for example http://localhost:4444/'
    })
  }

  const deviceIp = input.deviceIp.trim()
  if (!deviceIp) {
    errors.push({ field: 'deviceIp', message: 'Enter the fiscal device IP address.' })
  } else if (!isIpv4Address(deviceIp)) {
    errors.push({
      field: 'deviceIp',
      message: 'That does not look like an IP address. It should look like 192.168.1.50.'
    })
  }

  const devicePort = input.devicePort.trim()
  if (!devicePort) {
    errors.push({ field: 'devicePort', message: 'Enter the fiscal device port. It is usually 8000.' })
  } else if (!/^\d+$/.test(devicePort) || Number(devicePort) < 1 || Number(devicePort) > MAX_PORT) {
    errors.push({
      field: 'devicePort',
      message: `The port must be a whole number between 1 and ${MAX_PORT}.`
    })
  }

  return errors
}
