/**
 * Device TCP password resolution and the migration off the plaintext
 * `integrations` row.
 *
 * The audit (`docs/phase-89.md` section 3) found three separate
 * exposures: the password was stored in plaintext, returned to the
 * renderer over IPC, and pre-filled into a form field. This file covers
 * the storage half; the IPC half is covered by the handler stripping
 * `password` from `integrations:get-config`.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  resolveEtimsDevicePassword,
  redactIntegrationConfig,
  type EtimsCredentialsDb
} from '../src/main/services/etimsCredentials.js'
import {
  SECRET_SERVICE_NAME,
  ETIMS_DEVICE_PASSWORD_ACCOUNT,
  type KeytarLike
} from '../src/main/services/secretStore.js'

/** In-memory vault recording every write, mirroring `secretStore.test.ts`'s fake. */
function makeFakeKeytar(seed: Record<string, string> = {}): KeytarLike & {
  store: Map<string, string>
  setPassword: ReturnType<typeof vi.fn>
} {
  const store = new Map(Object.entries(seed))
  const setPassword = vi.fn(async (service: string, account: string, password: string) => {
    store.set(`${service} ${account}`, password)
  })
  return {
    store,
    setPassword,
    async getPassword(service, account) {
      return store.get(`${service} ${account}`) ?? null
    },
    async deletePassword(service, account) {
      return store.delete(`${service} ${account}`)
    }
  }
}

/** In-memory `integrations` row. */
function makeFakeDb(config: Record<string, unknown> = {}): EtimsCredentialsDb & {
  current: () => Record<string, unknown>
  setIntegrationConfig: ReturnType<typeof vi.fn>
} {
  let row = { ...config }
  const setIntegrationConfig = vi.fn((_provider: 'etims', next: Record<string, unknown>) => {
    row = { ...next }
  })
  return {
    current: () => row,
    setIntegrationConfig,
    getIntegrationConfig<T extends Record<string, unknown> = Record<string, unknown>>(): T {
      return { ...row } as T
    }
  }
}

const VAULT_KEY = `${SECRET_SERVICE_NAME} ${ETIMS_DEVICE_PASSWORD_ACCOUNT}`

describe('resolveEtimsDevicePassword', () => {
  it('reads the vault first when a password is stored there', async () => {
    const keytar = makeFakeKeytar({ [VAULT_KEY]: 'vault-secret' })
    const db = makeFakeDb({ deviceIp: '192.168.1.50' })

    const result = await resolveEtimsDevicePassword({ keytar, db })

    expect(result).toEqual({ password: 'vault-secret', source: 'vault' })
  })

  it('reports "none" — never a default — when nothing is configured anywhere', async () => {
    const keytar = makeFakeKeytar()
    const db = makeFakeDb({})

    const result = await resolveEtimsDevicePassword({ keytar, db })

    expect(result).toEqual({ password: null, source: 'none' })
  })

  it('migrates a legacy plaintext password into the vault', async () => {
    const keytar = makeFakeKeytar()
    const db = makeFakeDb({ deviceIp: '192.168.1.50', password: 'legacy-plaintext' })

    const result = await resolveEtimsDevicePassword({ keytar, db })

    expect(result).toEqual({ password: 'legacy-plaintext', source: 'migrated-from-plaintext' })
    expect(keytar.store.get(VAULT_KEY)).toBe('legacy-plaintext')
  })

  it('deletes the plaintext password from the row once migrated, keeping the other fields', async () => {
    const keytar = makeFakeKeytar()
    const db = makeFakeDb({
      baseUrl: 'http://localhost:4444/',
      deviceIp: '192.168.1.50',
      devicePort: '8000',
      password: 'legacy-plaintext'
    })

    await resolveEtimsDevicePassword({ keytar, db })

    expect(db.current()).toEqual({
      baseUrl: 'http://localhost:4444/',
      deviceIp: '192.168.1.50',
      devicePort: '8000'
    })
    expect('password' in db.current()).toBe(false)
  })

  it('strips a stale plaintext password even when the vault already has one', async () => {
    // Belt and braces: the vault wins for the value, but a leftover
    // plaintext copy must not survive on the row.
    const keytar = makeFakeKeytar({ [VAULT_KEY]: 'vault-secret' })
    const db = makeFakeDb({ deviceIp: '192.168.1.50', password: 'stale-plaintext' })

    const result = await resolveEtimsDevicePassword({ keytar, db })

    expect(result.password).toBe('vault-secret')
    expect('password' in db.current()).toBe(false)
  })

  it('treats a blank plaintext password as not configured, and does not vault it', async () => {
    const keytar = makeFakeKeytar()
    const db = makeFakeDb({ password: '   ' })

    const result = await resolveEtimsDevicePassword({ keytar, db })

    expect(result).toEqual({ password: null, source: 'none' })
    expect(keytar.setPassword).not.toHaveBeenCalled()
  })

  it('does not rewrite a row that has no password key', async () => {
    const keytar = makeFakeKeytar({ [VAULT_KEY]: 'vault-secret' })
    const db = makeFakeDb({ deviceIp: '192.168.1.50' })

    await resolveEtimsDevicePassword({ keytar, db })

    expect(db.setIntegrationConfig).not.toHaveBeenCalled()
  })
})

describe('redactIntegrationConfig', () => {
  it('removes the password before a config crosses to the renderer', () => {
    const redacted = redactIntegrationConfig({
      baseUrl: 'http://localhost:4444/',
      deviceIp: '192.168.1.50',
      password: 'should-never-leave-main'
    })

    expect(redacted).toEqual({ baseUrl: 'http://localhost:4444/', deviceIp: '192.168.1.50' })
    expect('password' in redacted).toBe(false)
    expect(JSON.stringify(redacted)).not.toContain('should-never-leave-main')
  })

  it('leaves a config with no password untouched', () => {
    const config = { baseUrl: 'http://localhost:4444/', devicePort: '8000' }
    expect(redactIntegrationConfig(config)).toEqual(config)
  })

  it('does not mutate its input', () => {
    const config = { deviceIp: '192.168.1.50', password: 'secret' }
    redactIntegrationConfig(config)
    expect(config.password).toBe('secret')
  })

  it('redacts an M-Pesa-shaped config too, not just eTIMS', () => {
    // The handler is provider-agnostic, so the guard must be as well.
    const redacted = redactIntegrationConfig({ consumerKey: 'key', password: 'secret' })
    expect(redacted).toEqual({ consumerKey: 'key' })
  })
})
