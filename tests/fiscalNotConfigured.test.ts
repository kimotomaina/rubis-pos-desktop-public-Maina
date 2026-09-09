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
  describeDeviceNotAnswering,
  describeNotReady,
  NOT_CONFIGURED_MESSAGE,
  NOT_CONFIGURED_REASON,
  SERVER_UNREACHABLE_MESSAGE,
  STATUS_UNREADABLE_MESSAGE
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

  it('names the DEVICE hop, and blames the password, on a Code 31 that names the password stage', async () => {
    const get = vi.fn().mockResolvedValue({
      data: '<Res Code="31"><Err Source="Server" Type="ServTCPAuth"><Message>Missing password authentication answer </Message></Err></Res>'
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

  /**
   * The phase-98 fix. A `ReadStatus` that fails for a server/connection
   * reason means the device answered NOTHING, so it belongs to hop 2 —
   * every one of these used to report hop 3's "the fiscal device
   * answered but is not ready to file sales", which is false, and which
   * cost a live investigation hours chasing KRA provisioning
   * (`docs/phase-97.md`).
   */
  describe('a ReadStatus that fails for a connection reason', () => {
    /** `settings()` always succeeds — only `ReadStatus` is under test. */
    const settingsOk = (): ReturnType<typeof vi.fn> =>
      vi.fn().mockResolvedValue({ data: '<Res Code="0"/>' })

    const readStatusFailure = (xml: string): RealFiscalizationProvider =>
      new RealFiscalizationProvider({
        ...CONFIGURED,
        httpClient: makeClient(vi.fn().mockResolvedValue({ data: xml }), settingsOk())
      })

    const SERVER_CODES: ReadonlyArray<[string, string, RegExp]> = [
      [
        '19',
        '<Res Code="19"><Err Source="Server" Type="ServUndefined"><Message>The Fiscal Printer has open socket. FP refuses new socket connection.</Message></Err></Res>',
        /session open from an earlier connection/
      ],
      [
        '30',
        '<Res Code="30"><Err Source="Server" Type="ServSockConnectionFailed"><Message>Socket connect FAILED</Message></Err></Res>',
        /switched on and on the same network/
      ],
      [
        '31 (first ping)',
        '<Res Code="31"><Err Source="Server" Type="ServTCPAuth"><Message>Missing first ping answer </Message></Err></Res>',
        /did not respond to the connection/
      ],
      [
        '31 (password)',
        '<Res Code="31"><Err Source="Server" Type="ServTCPAuth"><Message>Missing password authentication answer </Message></Err></Res>',
        /refused the password/
      ],
      [
        '63',
        '<Res Code="63"><Err Source="Server" Type="ClientInvalidPostFormat"><Message>Invalid post format</Message></Err></Res>',
        /fault in this app/
      ]
    ]

    it.each(SERVER_CODES)(
      'reports Code %s against the DEVICE hop, never the ready hop',
      async (_label, xml) => {
        const result = await readStatusFailure(xml).testConnection()

        expect(result.failedAt).toBe('device')
        // Hop 3 was never attempted, so it is neither a pass nor a fail.
        expect(result.hops.map((hop) => hop.passed)).toEqual([true, false, undefined])
      }
    )

    it.each(SERVER_CODES)('names the specific cause of Code %s', async (_label, xml, expected) => {
      const result = await readStatusFailure(xml).testConnection()

      expect(result.message).toMatch(expected)
    })

    it.each(SERVER_CODES)('never claims the device answered on Code %s', async (_label, xml) => {
      const result = await readStatusFailure(xml).testConnection()

      expect(result.message).not.toMatch(/device answered/i)
      expect(result.message).not.toMatch(/contact the device supplier/i)
    })

    it('tells the two Code 31 stages apart, and defaults to the connection one', async () => {
      const firstPing = await readStatusFailure(
        '<Res Code="31"><Err Source="Server" Type="ServTCPAuth"><Message>Missing first ping answer </Message></Err></Res>'
      ).testConnection()
      const passwordStage = await readStatusFailure(
        '<Res Code="31"><Err Source="Server" Type="ServTCPAuth"><Message>Missing password authentication answer </Message></Err></Res>'
      ).testConnection()
      // The fallback rule: a Code 31 whose message does not positively
      // name the password stage must not be reported as a password
      // problem. A false "wrong password" is the wasted chase this fix
      // exists to prevent.
      const unrecognized = await readStatusFailure(
        '<Res Code="31"><Err Source="Server" Type="ServTCPAuth"><Message></Message></Err></Res>'
      ).testConnection()

      expect(firstPing.message).not.toBe(passwordStage.message)
      expect(firstPing.message).not.toMatch(/password/i)
      expect(passwordStage.message).toMatch(/password/i)
      expect(unrecognized.message).toBe(firstPing.message)
    })

    it('names the SERVER hop when ReadStatus comes back with no response envelope', async () => {
      const provider = new RealFiscalizationProvider({
        ...CONFIGURED,
        httpClient: makeClient(
          vi.fn().mockRejectedValue(
            Object.assign(new Error('socket hang up'), { isAxiosError: true, request: {} })
          ),
          settingsOk()
        )
      })

      const result = await provider.testConnection()

      expect(result.failedAt).toBe('server')
      expect(result.message).toBe(SERVER_UNREACHABLE_MESSAGE)
    })

    it('names the READY hop when the device answers but refuses the status command', async () => {
      // A device-level command error: it answered, so hop 2 genuinely
      // passed, but its readiness was never read — reporting "not ready"
      // would assert a status nobody has seen.
      const result = await readStatusFailure(
        '<Res Code="40"><Err Source="FP" STE1="30" STE2="34"><Message>Syntax error</Message></Err></Res>'
      ).testConnection()

      expect(result.failedAt).toBe('ready')
      expect(result.message).toBe(STATUS_UNREADABLE_MESSAGE)
      expect(result.hops.map((hop) => hop.passed)).toEqual([true, true, false])
    })
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

  it('names the READY hop when the device answers but is not fiscalized', async () => {
    const get = vi.fn().mockResolvedValue({ data: '<Res Code="0"/>' })
    const post = vi.fn().mockResolvedValue({
      data: '<Res Code="0"><Res Name="CU_fiscalized" Value="0"/><Res Name="Paired_with_TIMS" Value="1"/></Res>'
    })
    const provider = new RealFiscalizationProvider({
      ...CONFIGURED,
      httpClient: makeClient(post, get)
    })

    const result = await provider.testConnection()

    expect(result.failedAt).toBe('ready')
    expect(result.message).toMatch(/has not been fiscalized/)
    // The one case "contact the device supplier" is genuinely right for.
    expect(result.message).toMatch(/contact the device supplier/)
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
  const notAnswering = (code: string, message = ''): string =>
    describeDeviceNotAnswering({ code, message })

  const MESSAGES = [
    NOT_CONFIGURED_MESSAGE,
    NOT_CONFIGURED_REASON,
    SERVER_UNREACHABLE_MESSAGE,
    STATUS_UNREADABLE_MESSAGE,
    notAnswering('19'),
    notAnswering('30'),
    notAnswering('31'),
    notAnswering('31', 'Missing password authentication answer '),
    notAnswering('32'),
    notAnswering('34'),
    notAnswering('53'),
    notAnswering('63'),
    notAnswering('999'),
    describeNotReady('not-fiscalized'),
    describeNotReady('not-paired')
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
    const password = notAnswering('31', 'Missing password authentication answer ')
    expect(password).not.toBe(notAnswering('30'))
    expect(password).toMatch(/password/i)
    expect(notAnswering('30')).toMatch(/switched on|network/i)
  })

  it('claims the device answered only where it actually did', () => {
    // "The fiscal device answered..." is a factual claim. It is true of
    // the two status-bit messages and of the unreadable-status one, and
    // false of every message that means nothing came back.
    const unanswered = ['19', '30', '31', '32', '34', '53', '63', '999'].map((code) =>
      notAnswering(code)
    )

    for (const message of unanswered) {
      expect(message).not.toMatch(/device answered/i)
    }
    expect(describeNotReady('not-fiscalized')).toMatch(/device answered/i)
    expect(describeNotReady('not-paired')).toMatch(/device answered/i)
    expect(STATUS_UNREADABLE_MESSAGE).toMatch(/device answered/i)
  })

  it('reserves "contact the device supplier" for a device that reported its own status', () => {
    // The sentence that misdirected phase-97: it points at KRA
    // provisioning, which is only the right place to look when the
    // device answered and said it is not provisioned.
    const unanswered = ['19', '30', '31', '53', '63'].map((code) => notAnswering(code))

    for (const message of unanswered) {
      expect(message).not.toMatch(/contact the device supplier/i)
    }
    expect(describeNotReady('not-fiscalized')).toMatch(/contact the device supplier/i)
    expect(describeNotReady('not-paired')).toMatch(/contact the device supplier/i)
  })
})
