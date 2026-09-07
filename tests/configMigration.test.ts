/**
 * `configMigration` tests.
 *
 * Uses a lightweight fake `RubisDatabase` (just the four methods
 * `migrateEnvConfigToDatabase` touches) rather than the full
 * recording-fake-connection harness in `database.test.ts`, since this
 * module only calls through `RubisDatabase`'s public API.
 */

import { describe, it, expect, vi } from 'vitest'
import { migrateEnvConfigToDatabase } from '../src/main/services/configMigration.js'
import type { RubisDatabase } from '../src/main/services/database.js'

function makeFakeDb(overrides: {
  settings?: Record<string, string>
  configs?: Record<string, string>
}) {
  const settings = new Map(Object.entries(overrides.settings ?? {}))
  const configs = new Map(Object.entries(overrides.configs ?? {}))

  const getSetting = vi.fn((key: string) => settings.get(key))
  const setSetting = vi.fn((key: string, value: string) => {
    settings.set(key, value)
  })
  const getConfig = vi.fn((key: string) => configs.get(key) ?? null)
  const setConfig = vi.fn((key: string, value: string) => {
    configs.set(key, value)
  })

  return {
    db: { getSetting, setSetting, getConfig, setConfig } as unknown as RubisDatabase,
    getSetting,
    setSetting,
    getConfig,
    setConfig,
    settings,
    configs
  }
}

describe('migrateEnvConfigToDatabase', () => {
  it('seeds M-Pesa as mock but eTIMS as REAL when the env vars are unset', () => {
    const { db, setConfig, settings } = makeFakeDb({})

    migrateEnvConfigToDatabase(db, {})

    expect(setConfig).toHaveBeenCalledWith('mock_mpesa_enabled', 'true', {
      requiresRestart: true,
      category: 'mpesa'
    })
    // A seeded `true` here would both mock fiscalization on a fresh
    // install and bypass the mandatory eTIMS setup gate — see
    // `etimsSetup.ts` and Rule 2.
    expect(setConfig).toHaveBeenCalledWith('mock_etims_enabled', 'false', {
      requiresRestart: true,
      category: 'etims'
    })
    expect(settings.get('config_migration_v1_complete')).toBe('1')
  })

  it('seeds a present flag as false only when the env var is the literal string "false"', () => {
    const { db, configs } = makeFakeDb({})

    migrateEnvConfigToDatabase(db, { VITE_USE_MOCK_MPESA: 'false', VITE_USE_MOCK_ETIMS: 'nonsense' })

    expect(configs.get('mock_mpesa_enabled')).toBe('false')
    expect(configs.get('mock_etims_enabled')).toBe('true')
  })

  it('still honours an explicit VITE_USE_MOCK_ETIMS=true in a development .env', () => {
    const { db, configs } = makeFakeDb({})

    migrateEnvConfigToDatabase(db, { VITE_USE_MOCK_ETIMS: 'true' })

    expect(configs.get('mock_etims_enabled')).toBe('true')
  })

  it('does not overwrite a key an admin already configured before migration ran', () => {
    const { db, setConfig } = makeFakeDb({ configs: { mock_mpesa_enabled: 'false' } })

    migrateEnvConfigToDatabase(db, { VITE_USE_MOCK_MPESA: 'true' })

    expect(setConfig).not.toHaveBeenCalledWith(
      'mock_mpesa_enabled',
      expect.anything(),
      expect.anything()
    )
  })

  it('is a no-op once already marked complete', () => {
    const { db, setConfig } = makeFakeDb({ settings: { config_migration_v1_complete: '1' } })

    migrateEnvConfigToDatabase(db, { VITE_USE_MOCK_MPESA: 'false' })

    expect(setConfig).not.toHaveBeenCalled()
  })

  it('running it twice only seeds once', () => {
    const { db, setConfig } = makeFakeDb({})

    migrateEnvConfigToDatabase(db, {})
    setConfig.mockClear()
    migrateEnvConfigToDatabase(db, {})

    expect(setConfig).not.toHaveBeenCalled()
  })
})
