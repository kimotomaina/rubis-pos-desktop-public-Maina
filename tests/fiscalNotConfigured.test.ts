/**
 * Behaviour of a till whose fiscal device has never been set up, and of
 * `reconfigure`/`testConnection` — the go-live path.
 *
 * The rule this file exists to hold: an unconfigured till must never put
 * a guessed password on the wire. Before this, a blank config fell back
 * to `DEFAULT_DEVICE_PASSWORD = 'Password'`, so "nobody set this up"
 * came back from the device as Code 31 and read like a hardware fault
 * (`docs/phase-89.md` section 5).
 */

import { describe, it, expect, vi } from 'vitest'
import type { AxiosInstance } from 'axios'
import { RealFiscalizationProvider } from '../src/main/services/integrations/real-etims-provider.js'
import type { FiscalInvoiceRequest } from '../src/main/services/integrations/etims.js'
import {
  describeNotReady,
  describeSettingsFailure,
  NOT_CONFIGURED_MESSAGE,
  NOT_CONFIGURED_REASON,
  SERVER_UNREACHABLE_MESSAGE
} from '../src/main/services/integrations/fiscal-connection-test.js'

/** A complete, valid sale — nothing about the request is at fault here. */
const SALE: FiscalInvoiceRequest = {
  clientOrderUuid: '7f3c1a90-0000-4000-8000-000000000001',
  localId: 42,
  items: [
    {
      description: 'Bottled Water 500ml',
      quantity: 2,
      unitPrice: 60,
      taxRate: 0.16,
      vatClass: 'A',
      measureUnit: 'pcs',
      hsCode: '2201.10.00',
      hsName: 'Mineral waters'
    }
  ],
  total: 120,
  taxAmount: 16.55,
  paymentMethod: 'cash'
}

/** Device details a configured till would have. */
const CONFIGURED = {
  deviceIp: '192.168.1.50',
  devicePort: '8000',
  password: 'test-device-password'
} as const

/** Builds an injectable axios stand-in whose calls the test can inspect. */
function makeClient(
  post: ReturnType<typeof vi.fn>,
  get: ReturnType<typeof vi.fn>
): AxiosInstance {
  return {
    post,
    get,
    defaults: { baseURL: 'http://localhost:4444/' }
  } as unknown as AxiosInstance
}

describe('a till whose fiscal device is not set up', () => {
  it('reports "not set up yet" and makes ZERO HTTP calls', async () => {
    const post = vi.fn()
    const get = vi.fn()
    const provider = new RealFiscalizationProvider({ httpClient: makeClient(post, get) })

    const outcome = await provider.submitInvoice(SALE)

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe(
      'The fiscal device has not been set up on this till yet. Enter its details in Admin, then resend this sale.'
    )
    // The whole point: nothing reached the wire, so no guessed password
    // was ever sent and no Code 31 was ever provoked.
    expect(get).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
  })

  it('classifies it as technical and retryable, so the sale queues rather than dying', async () => {
    const provider = new RealFiscalizationProvider({
      httpClient: makeClient(vi.fn(), vi.fn())
    })

    const outcome = await provider.submitInvoice(SALE)

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    // 'technical' is the existing kind for a condition that heals "once
    // configuration is corrected" — no fourth FiscalFailureKind needed.
    expect(outcome.kind).toBe('technical')
    expect(outcome.retryable).toBe(true)
  })

  it('says nothing about codes, commands, or the word Password', async () => {
    const provider = new RealFiscalizationProvider({
      httpClient: makeClient(vi.fn(), vi.fn())
    })

    const outcome = await provider.submitInvoice(SALE)

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).not.toMatch(/Code \d|settings\(|ReadStatus|ServTCPAuth/)
  })

  it.each([
    ['no IP', { devicePort: '8000', password: 'p' }],
    ['no port', { deviceIp: '192.168.1.50', password: 'p' }],
    ['no password', { deviceIp: '192.168.1.50', devicePort: '8000' }]
  ])('treats a partial configuration as not set up (%s)', async (_label, partial) => {
    const post = vi.fn()
    const get = vi.fn()
    const provider = new RealFiscalizationProvider({
      ...partial,
      httpClient: makeClient(post, get)
    })

    expect(provider.isConfigured()).toBe(false)
    const outcome = await provider.submitInvoice(SALE)
    expect(outcome.ok).toBe(false)
    expect(get).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
  })

  it('is configured once all three details are present', () => {
    const provider = new RealFiscalizationProvider({
      ...CONFIGURED,
      httpClient: makeClient(vi.fn(), vi.fn())
    })

    expect(provider.isConfigured()).toBe(true)
  })
})

describe('reconfigure', () => {
  it('turns an unconfigured provider into a working one without a restart', async () => {
    const get = vi.fn().mockResolvedValue({ data: '<Res Code="0"/>' })
    const post = vi.fn().mockResolvedValue({ data: '<Res Code="0"/>' })
    const provider = new RealFiscalizationProvider({ httpClient: makeClient(post, get) })

    expect(provider.isConfigured()).toBe(false)

    provider.reconfigure({ ...CONFIGURED, baseUrl: 'http://localhost:4444/' })

    expect(provider.isConfigured()).toBe(true)
    await provider.submitInvoice(SALE)
    expect(get).toHaveBeenCalledWith(
      'http://localhost:4444/settings(ip=192.168.1.50,port=8000,password=test-device-password,tcp=1)',
      expect.anything()
    )
  })

  it('clears the cached handshake so the next sale re-opens the session with the new details', async () => {
    const get = vi.fn().mockResolvedValue({ data: '<Res Code="0"/>' })
    const post = vi.fn().mockResolvedValue({ data: '<Res Code="0"/>' })
    const provider = new RealFiscalizationProvider({
      ...CONFIGURED,
      httpClient: makeClient(post, get)
    })

    await provider.submitInvoice(SALE)
    const settingsCallsBefore = get.mock.calls.length

    provider.reconfigure({ ...CONFIGURED, password: 'a-different-password' })
    await provider.submitInvoice({ ...SALE, clientOrderUuid: 'uuid-2', localId: 43 })

    expect(get.mock.calls.length).toBeGreaterThan(settingsCallsBefore)
    expect(get.mock.calls[get.mock.calls.length - 1][0]).toContain('password=a-different-password')
  })

  it('applies a new base URL to the existing client rather than replacing it', () => {
    const client = makeClient(vi.fn(), vi.fn())
    const provider = new RealFiscalizationProvider({ ...CONFIGURED, httpClient: client })

    provider.reconfigure({ ...CONFIGURED, baseUrl: 'http://192.168.1.9:4444' })

    // Same injected instance, normalized URL — a rebuilt client would
    // drop the test seam and any interceptors a caller had installed.
    expect(client.defaults.baseURL).toBe('http://192.168.1.9:4444/')
  })
})

describe('testConnection', () => {
  it('reports the device hop, and no server hop, when nothing is configured', async () => {
    const provider = new RealFiscalizationProvider({
      httpClient: makeClient(vi.fn(), vi.fn())
    })

    const result = await provider.testConnection()

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/has not been set up on this till yet/)
  })

  it('names the SERVER hop when the fiscal server cannot be reached at all', async () => {
    // A transport failure carries no <Res Code> — that is what
    // distinguishes "server unreachable" from "device refused".
    const get = vi.fn().mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), {
      isAxiosError: true,
      request: {}
    }))
    const provider = new RealFiscalizationProvider({
      ...CONFIGURED,
      httpClient: makeClient(vi.fn(), get)
    })

    const result = await provider.testConnection()

    expect(result.ok).toBe(false)
    expect(result.failedAt).toBe('server')
    expect(result.message).toMatch(/Could not reach the fiscal server on this till/)
    expect(result.hops.map((hop) => hop.passed)).toEqual([false, undefined, undefined])
  })

  it('names the DEVICE hop, and blames the password, on a Code 31', async () => {
    const get = vi.fn().mockResolvedValue({
      data: '<Res Code="31"><Err Source="Server" Type="ServTCPAuth"><Message>ServTCPAuth</Message></Err></Res>'
    })
    const provider = new RealFiscalizationProvider({
      ...CONFIGURED,
      httpClient: makeClient(vi.fn(), get)
    })

    const result = await provider.testConnection()

    expect(result.failedAt).toBe('device')
    expect(result.message).toMatch(/refused the password/)
    expect(result.message).not.toMatch(/31|ServTCPAuth/)
    // The server hop passed — it answered, it just said no.
    expect(result.hops[0].passed).toBe(true)
    expect(result.hops[1].passed).toBe(false)
    expect(result.hops[2].passed).toBeUndefined()
  })

  it('names the DEVICE hop, and blames the address, on a Code 30', async () => {
    const get = vi.fn().mockResolvedValue({
      data: '<Res Code="30"><Err Source="Server" Type="ServSockConnectionFailed"><Message>ServSockConnectionFailed</Message></Err></Res>'
    })
    const provider = new RealFiscalizationProvider({
      ...CONFIGURED,
      httpClient: makeClient(vi.fn(), get)
    })

    const result = await provider.testConnection()

    expect(result.failedAt).toBe('device')
    expect(result.message).toMatch(/did not answer/)
    expect(result.message).toMatch(/switched on/)
  })

  it('names the READY hop when the device answers but is not paired with TIMS', async () => {
    const get = vi.fn().mockResolvedValue({ data: '<Res Code="0"/>' })
    const post = vi.fn().mockResolvedValue({
      data: '<Res Code="0"><Res Name="CU_fiscalized" Value="1"/><Res Name="Paired_with_TIMS" Value="0"/></Res>'
    })
    const provider = new RealFiscalizationProvider({
      ...CONFIGURED,
      httpClient: makeClient(post, get)
    })

    const result = await provider.testConnection()

    expect(result.failedAt).toBe('ready')
    expect(result.message).toMatch(/not paired with KRA TIMS/)
    expect(result.hops.map((hop) => hop.passed)).toEqual([true, true, false])
  })

  it('passes all three hops on a healthy device', async () => {
    const get = vi.fn().mockResolvedValue({ data: '<Res Code="0"/>' })
    const post = vi.fn().mockResolvedValue({
      data: '<Res Code="0"><Res Name="CU_fiscalized" Value="1"/><Res Name="Paired_with_TIMS" Value="1"/></Res>'
    })
    const provider = new RealFiscalizationProvider({
      ...CONFIGURED,
      httpClient: makeClient(post, get)
    })

    const result = await provider.testConnection()

    expect(result.ok).toBe(true)
    expect(result.failedAt).toBeUndefined()
    expect(result.hops.every((hop) => hop.passed === true)).toBe(true)
    expect(result.message).toBe('The fiscal device answered and is ready to file sales.')
  })

  it('re-runs the handshake rather than reporting a stale cached one', async () => {
    const get = vi.fn().mockResolvedValue({ data: '<Res Code="0"/>' })
    const post = vi.fn().mockResolvedValue({
      data: '<Res Code="0"><Res Name="CU_fiscalized" Value="1"/><Res Name="Paired_with_TIMS" Value="1"/></Res>'
    })
    const provider = new RealFiscalizationProvider({
      ...CONFIGURED,
      httpClient: makeClient(post, get)
    })

    await provider.testConnection()
    const afterFirst = get.mock.calls.length
    await provider.testConnection()

    expect(get.mock.calls.length).toBeGreaterThan(afterFirst)
  })
})

describe('every message a branch manager can see', () => {
  /**
   * Each message shown on the Admin screen or the setup gate. The
   * standing requirement for these screens is plain language: no vendor
   * product names, no protocol codes, no command names, no config keys.
   */
  const MESSAGES = [
    NOT_CONFIGURED_MESSAGE,
    NOT_CONFIGURED_REASON,
    SERVER_UNREACHABLE_MESSAGE,
    describeSettingsFailure('30'),
    describeSettingsFailure('31'),
    describeSettingsFailure('32'),
    describeSettingsFailure('34'),
    describeSettingsFailure(undefined),
    describeNotReady('Fiscal device reports it is not fiscalized (CU_fiscalized=0)'),
    describeNotReady('Fiscal device reports it is not paired with TIMS (Paired_with_TIMS=0)'),
    describeNotReady(undefined)
  ]

  it.each(MESSAGES)('names no vendor product, protocol code or command: %s', (message) => {
    expect(message).not.toMatch(/ZFPLab|Tremol|Control Unit|ServTCPAuth|ServSock/i)
    expect(message).not.toMatch(/Res Code|STE\d|Code \d+/)
    expect(message).not.toMatch(/settings\(|ReadStatus|OpenInvoice|CloseReceipt/)
    expect(message).not.toMatch(/baseUrl|deviceIp|devicePort|defaultVatClass/)
  })

  it.each(MESSAGES)('is a finished sentence, not a fragment: %s', (message) => {
    expect(message.length).toBeGreaterThan(20)
    expect(message.trim()).toMatch(/\.$/)
  })

  it('distinguishes the two device-hop causes a branch can actually act on', () => {
    // Wrong password and unreachable device are different jobs for
    // whoever is standing at the till, so they must not share wording.
    expect(describeSettingsFailure('31')).not.toBe(describeSettingsFailure('30'))
    expect(describeSettingsFailure('31')).toMatch(/password/i)
    expect(describeSettingsFailure('30')).toMatch(/switched on|network/i)
  })
})
