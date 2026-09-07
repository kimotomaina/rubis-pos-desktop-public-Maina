/**
 * One-time migration of legacy `.env`-only settings into the
 * database-backed `app_configurations` table, so an Admin-editable
 * runtime config (currently the M-Pesa/eTIMS mock-vs-real toggles)
 * has a starting value that survives even on an install with no
 * `.env` file present. Idempotent — guarded by a `settings` table
 * flag so it runs at most once per install, regardless of how many
 * times `migrateEnvConfigToDatabase` is called.
 */

import type { RubisDatabase } from './database.js'

/** `settings` table key marking this migration as already run. */
const MIGRATION_COMPLETE_SETTING_KEY = 'config_migration_v1_complete'

/** Env vars this migration seeds into `app_configurations`. */
export interface EnvConfigMigrationInput {
  VITE_USE_MOCK_MPESA?: string
  VITE_USE_MOCK_ETIMS?: string
}

/**
 * Seeds `app_configurations` rows for the mock/real toggles from
 * `env` — but only for a key with no existing DB value (an admin may
 * already have set one via `config:set` before this ever ran) — then
 * marks the migration complete so it never re-seeds over a later
 * Admin-screen change.
 *
 * The two toggles seed differently when their env var is absent. M-Pesa
 * defaults to mock, so a fresh till never charges a real customer by
 * accident. eTIMS defaults to real: a mocked fiscalization mints a
 * synthetic invoice number that would print on a receipt as though the
 * sale had been filed with KRA (Rule 2), and a seeded `true` here would
 * also bypass the mandatory eTIMS setup gate — see `etimsSetup.ts`.
 *
 * @param {RubisDatabase} db
 * @param {EnvConfigMigrationInput} env
 */
export function migrateEnvConfigToDatabase(db: RubisDatabase, env: EnvConfigMigrationInput): void {
  if (db.getSetting(MIGRATION_COMPLETE_SETTING_KEY) === '1') return

  const seed = (
    key: string,
    envValue: string | undefined,
    category: 'mpesa' | 'etims',
    mockWhenUnset: boolean
  ): void => {
    if (db.getConfig(key) !== null) return
    const mock = envValue === undefined ? mockWhenUnset : envValue !== 'false'
    db.setConfig(key, mock ? 'true' : 'false', {
      requiresRestart: true,
      category
    })
  }

  seed('mock_mpesa_enabled', env.VITE_USE_MOCK_MPESA, 'mpesa', true)
  seed('mock_etims_enabled', env.VITE_USE_MOCK_ETIMS, 'etims', false)

  db.setSetting(MIGRATION_COMPLETE_SETTING_KEY, '1')
}
