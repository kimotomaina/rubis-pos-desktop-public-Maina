/**
 * Resolves the fiscal device's TCP password, and migrates it off the
 * plaintext `integrations` row it used to live in.
 *
 * Kept separate from `etimsSetup.ts` (which decides whether the setup
 * gate lifts) because this answers a different question — where the
 * secret comes from — and needs the vault and the database, which that
 * module deliberately does not.
 */

import { getSecret, setSecret, SECRET_SERVICE_NAME, ETIMS_DEVICE_PASSWORD_ACCOUNT } from './secretStore.js'
import type { KeytarLike } from './secretStore.js'

/** Shape of the stored `etims` integration row this module reads and rewrites. */
export interface EtimsIntegrationConfig extends Record<string, unknown> {
  baseUrl?: string
  deviceIp?: string
  devicePort?: string
  defaultVatClass?: string
  /** Legacy plaintext password. Migrated into the vault and deleted on first sight. */
  password?: string
}

/** Narrow surface of `RubisDatabase` this module depends on. */
export interface EtimsCredentialsDb {
  getIntegrationConfig<T extends Record<string, unknown> = Record<string, unknown>>(
    provider: 'etims'
  ): T
  setIntegrationConfig(provider: 'etims', config: Record<string, unknown>): void
}

/** Where {@link resolveEtimsDevicePassword} found the password. */
export type EtimsPasswordSource = 'vault' | 'migrated-from-plaintext' | 'none'

/** Result of {@link resolveEtimsDevicePassword}. */
export interface EtimsPasswordResolution {
  /** `null` when no password has been configured on this till yet. */
  password: string | null
  source: EtimsPasswordSource
}

/**
 * Resolves the device TCP password at startup. Priority:
 *
 *   1. The credential vault, always checked first.
 *   2. A legacy plaintext `password` on the `etims` integrations row —
 *      written into the vault and **removed from the row** so the next
 *      launch reads only from the vault. An install that predates this
 *      change heals itself on first launch without the operator having
 *      to retype anything.
 *   3. `null` — not configured. Deliberately no `.env` fallback and no
 *      hardcoded default: a wrong password looks identical to a broken
 *      device on the wire, so "not configured" must stay
 *      distinguishable from "configured wrongly".
 *
 * @param {object} options
 * @param {KeytarLike} options.keytar
 * @param {EtimsCredentialsDb} options.db
 * @returns {Promise<EtimsPasswordResolution>}
 */
export async function resolveEtimsDevicePassword(options: {
  keytar: KeytarLike
  db: EtimsCredentialsDb
}): Promise<EtimsPasswordResolution> {
  const stored = await getSecret(options.keytar, SECRET_SERVICE_NAME, ETIMS_DEVICE_PASSWORD_ACCOUNT)
  if (stored) {
    await stripPlaintextPassword(options.db)
    return { password: stored, source: 'vault' }
  }

  const config = options.db.getIntegrationConfig<EtimsIntegrationConfig>('etims')
  const legacy = config.password?.trim()
  if (legacy) {
    await setSecret(options.keytar, SECRET_SERVICE_NAME, ETIMS_DEVICE_PASSWORD_ACCOUNT, legacy)
    await stripPlaintextPassword(options.db)
    return { password: legacy, source: 'migrated-from-plaintext' }
  }

  return { password: null, source: 'none' }
}

/**
 * Rewrites the `etims` row without its `password` key, if it has one.
 * A no-op when the row is already clean, so this is safe to call on
 * every launch.
 *
 * @param {EtimsCredentialsDb} db
 * @returns {Promise<void>}
 */
async function stripPlaintextPassword(db: EtimsCredentialsDb): Promise<void> {
  const config = db.getIntegrationConfig<EtimsIntegrationConfig>('etims')
  if (!('password' in config)) return
  db.setIntegrationConfig('etims', redactIntegrationConfig(config))
}

/**
 * Returns `config` without its `password` key — the guard on every
 * integration config that crosses to the renderer.
 *
 * A vault-backed install never has one to strip, but a row written by an
 * older build can still carry a plaintext password until
 * {@link resolveEtimsDevicePassword}'s migration runs, and no secret
 * should reach a screen regardless. Screens report
 * "Configured"/"Not configured" from a boolean status channel instead,
 * the way the Shopify token and Daraja secrets already do.
 *
 * @param {Record<string, unknown>} config
 * @returns {Record<string, unknown>} a copy with `password` removed
 */
export function redactIntegrationConfig(
  config: Record<string, unknown>
): Record<string, unknown> {
  const { password: _withheld, ...rest } = config
  return rest
}
