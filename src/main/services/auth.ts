/**
 * Staff authentication service.
 *
 * PIN hashing uses Node's native `crypto.pbkdf2Sync` rather than a
 * third-party library like `bcrypt` — zero extra native-module
 * surface (this project already carries `better-sqlite3`'s native
 * build pain) and more than adequate for a local 4–6 digit staff PIN.
 */

import { randomBytes, pbkdf2Sync, timingSafeEqual } from 'node:crypto'
import type { RubisDatabase, StaffSummary } from './database.js'
import type { ServiceResult } from './shopify-types.js'

/** PBKDF2 iteration count — deliberately high for a fast, low-entropy PIN. */
const PBKDF2_ITERATIONS = 100_000

/** Derived key length in bytes. */
const PBKDF2_KEY_LENGTH = 64

/** Digest algorithm used for the PBKDF2 derivation. */
const PBKDF2_DIGEST = 'sha512'

/**
 * Hashes a staff PIN into a storable `"<saltHex>:<hashHex>"` string.
 * A fresh random salt is generated on every call.
 *
 * @param {string} pin
 * @returns {string}
 */
export function hashPin(pin: string): string {
  const salt = randomBytes(16)
  const derived = pbkdf2Sync(pin, salt, PBKDF2_ITERATIONS, PBKDF2_KEY_LENGTH, PBKDF2_DIGEST)
  return `${salt.toString('hex')}:${derived.toString('hex')}`
}

/**
 * Verifies a PIN against a stored `"<saltHex>:<hashHex>"` hash.
 * Never throws — a malformed or foreign hash simply fails to verify.
 *
 * @param {string} pin
 * @param {string} storedHash
 * @returns {boolean}
 */
export function verifyPin(pin: string, storedHash: string): boolean {
  const [saltHex, hashHex] = storedHash.split(':')
  if (!saltHex || !hashHex) return false

  try {
    const salt = Buffer.from(saltHex, 'hex')
    const expected = Buffer.from(hashHex, 'hex')
    const actual = pbkdf2Sync(pin, salt, PBKDF2_ITERATIONS, PBKDF2_KEY_LENGTH, PBKDF2_DIGEST)
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

/**
 * Verifies a staff member's PIN.
 *
 * Rejects an unknown or inactive staff id and a wrong PIN with the
 * same generic error message, so a failed login never reveals whether
 * the staff id itself was valid. Login is authentication only — it
 * does not open or close the store-wide till shift (see
 * `RubisDatabase.openShift`/`closeShift`), which is a separate,
 * explicit action from the Admin screen.
 *
 * @param {RubisDatabase} db
 * @param {number} staffId
 * @param {string} pin
 * @returns {ServiceResult<StaffSummary>}
 */
export function authenticateStaff(
  db: RubisDatabase,
  staffId: number,
  pin: string
): ServiceResult<StaffSummary> {
  const staff = db.getStaffById(staffId)

  if (!staff || staff.is_active !== 1 || !verifyPin(pin, staff.pin_hash)) {
    return { success: false, error: 'Incorrect PIN' }
  }

  return {
    success: true,
    data: { id: staff.id, name: staff.name, role: staff.role }
  }
}
