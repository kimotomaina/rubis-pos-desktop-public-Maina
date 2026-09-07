/**
 * Fiscal HTTP client tests.
 *
 * Guards the two wire shapes the local ZFPLabServer actually speaks
 * (both confirmed against the vendor's decompiled `FPcore.jar` and live
 * calls): the literal `settings(…)` GET that opens the server→device
 * session, and the `<Command Name="…">` POST to the bare base URL that
 * carries every fiscal command. Also guards what must *not* be sent —
 * the `ip`/`port`/`password` query parameters and `X-Device-*` headers
 * an earlier revision invented.
 */

import { describe, it, expect, vi } from 'vitest'
import type { AxiosInstance } from 'axios'
import {
  buildSettingsCommand,
  checkDefVersion,
  closeDeviceConnection,
  createFiscalHttpClient,
  getSettings,
  normalizeBaseUrl,
  postXml,
  DEFAULT_ETIMS_BASE_URL,
  ETIMS_REQUEST_TIMEOUT_MS,
  EXPECTED_DEF_VERSION,
  FISCAL_CONTENT_TYPE
} from '../src/main/services/integrations/http-client.js'

/**
 * Device details these tests drive `getSettings` with. Literals rather
 * than exported constants: the provider no longer has defaults for any
 * of them, deliberately — see `RealFiscalizationProvider.isConfigured`.
 */
const TEST_DEVICE_IP = '154.79.253.236'
const TEST_DEVICE_PORT = '8000'
const TEST_DEVICE_PASSWORD = 'Password'

function makeMockClient(
  impl: { post?: ReturnType<typeof vi.fn>; get?: ReturnType<typeof vi.fn> },
  baseURL = DEFAULT_ETIMS_BASE_URL,
  timeout?: number
): AxiosInstance {
  return { ...impl, defaults: { baseURL, timeout } } as unknown as AxiosInstance
}

describe('createFiscalHttpClient', () => {
  it('defaults to the local ZFPLabServer base URL', () => {
    const client = createFiscalHttpClient()
    expect(client.defaults.baseURL).toBe('http://localhost:4444/')
    expect(DEFAULT_ETIMS_BASE_URL).toBe('http://localhost:4444/')
  })

  it('keeps exactly one trailing slash on the base URL — settings() concatenates onto it', () => {
    expect(createFiscalHttpClient({ baseUrl: 'http://localhost:4444' }).defaults.baseURL).toBe(
      'http://localhost:4444/'
    )
    expect(createFiscalHttpClient({ baseUrl: 'http://localhost:4444/' }).defaults.baseURL).toBe(
      'http://localhost:4444/'
    )
    expect(createFiscalHttpClient({ baseUrl: 'http://localhost:4444///' }).defaults.baseURL).toBe(
      'http://localhost:4444/'
    )
  })

  it("sets the vendor's one header, Content-Type, and no Accept header", () => {
    const client = createFiscalHttpClient()
    // text/plain, not application/xml — the authoritative vendor JS
    // client (fp_core.js:32) sends this literal value on every request
    // despite the body being XML.
    expect(client.defaults.headers['Content-Type']).toBe('text/plain')
    // `sendReq` (fp_core.js:29-37) makes exactly one setRequestHeader
    // call. An earlier revision also sent `Accept: application/xml` on
    // the strength of a comment claiming the vendor did; it does not.
    expect(client.defaults.headers['Accept']).toBeUndefined()
  })

  it('never attaches ip/port/password query params or X-Device-* headers', () => {
    const client = createFiscalHttpClient({ baseUrl: 'http://localhost:4444/' })
    expect(client.defaults.params).toBeUndefined()
    expect(client.defaults.headers['X-Device-IP']).toBeUndefined()
    expect(client.defaults.headers['X-Device-Port']).toBeUndefined()
    expect(client.defaults.headers['X-Device-Password']).toBeUndefined()
    expect(client.defaults.headers['X-ZFP-Password']).toBeUndefined()
  })
})

describe('normalizeBaseUrl', () => {
  it('guarantees a single trailing slash', () => {
    expect(normalizeBaseUrl('http://localhost:4444')).toBe('http://localhost:4444/')
    expect(normalizeBaseUrl('http://localhost:4444/')).toBe('http://localhost:4444/')
  })
})

describe('buildSettingsCommand', () => {
  it('builds the literal, unencoded settings() string', () => {
    expect(buildSettingsCommand('154.79.253.236', '8000', 'Password')).toBe(
      'settings(ip=154.79.253.236,port=8000,password=Password,tcp=1)'
    )
  })

  it('omits the password segment entirely when the password is empty', () => {
    // Matches the vendor's `(password ? (",password=" + password) : "")`
    // — fp_core.js:409 / SDK_RECON section 2.4 — rather than sending a
    // bare `password=`.
    expect(buildSettingsCommand('192.168.1.50', '8000', '')).toBe(
      'settings(ip=192.168.1.50,port=8000,tcp=1)'
    )
  })
})

describe('getSettings', () => {
  it('GETs the exact settings() URL, with parens/commas/equals left unencoded', async () => {
    const get = vi.fn().mockResolvedValue({ data: '<Res Code="0"><settings/></Res>' })
    const client = makeMockClient({ get })

    await getSettings(client, TEST_DEVICE_IP, TEST_DEVICE_PORT, TEST_DEVICE_PASSWORD)

    expect(get).toHaveBeenCalledWith(
      'http://localhost:4444/settings(ip=154.79.253.236,port=8000,password=Password,tcp=1)',
      { timeout: ETIMS_REQUEST_TIMEOUT_MS }
    )
  })

  it('logs nothing by default (debug off) — no request/response trace on a normal call', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const get = vi.fn().mockResolvedValue({ data: '<Res Code="0"><settings/></Res>' })

    await getSettings(makeMockClient({ get }), TEST_DEVICE_IP, TEST_DEVICE_PORT, TEST_DEVICE_PASSWORD)

    expect(log).not.toHaveBeenCalled()
    log.mockRestore()
  })

  it('with debug on, logs the request URL but redacts the real device password (phase-80)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const get = vi.fn().mockResolvedValue({ data: '<Res Code="0"><settings/></Res>' })

    await getSettings(
      makeMockClient({ get }),
      TEST_DEVICE_IP,
      TEST_DEVICE_PORT,
      'SuperSecretDevicePassword',
      true
    )

    const loggedLines = log.mock.calls.map((call) => String(call[0]))
    expect(loggedLines.some((line) => line.includes('SuperSecretDevicePassword'))).toBe(false)
    expect(loggedLines.some((line) => line.includes('password=***'))).toBe(true)
    log.mockRestore()
  })

  it('parses the Res Code out of the response', async () => {
    const get = vi
      .fn()
      .mockResolvedValue({ data: '<Res Code="0"><settings><clientID>Localhost</clientID></settings></Res>' })

    const result = await getSettings(makeMockClient({ get }), '1.2.3.4', '8000', 'pw')

    expect(result.success).toBe(true)
    expect(result.data?.code).toBe('0')
    expect(result.data?.clientID).toBe('Localhost')
  })

  it('returns a failed ServiceResult when the server is unreachable', async () => {
    const get = vi.fn().mockRejectedValue(new Error('connection refused'))

    const result = await getSettings(makeMockClient({ get }), '1.2.3.4', '8000', 'pw')

    expect(result.success).toBe(false)
  })

  it('surfaces defVerStatus="match" and does not warn when defVer equals EXPECTED_DEF_VERSION', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const get = vi.fn().mockResolvedValue({
      data: `<Res Code="0"><settings><defVer>${EXPECTED_DEF_VERSION}</defVer></settings></Res>`
    })

    const result = await getSettings(makeMockClient({ get }), '1.2.3.4', '8000', 'pw')

    expect(result.data?.defVerStatus).toBe('match')
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('surfaces defVerStatus="unknown" (not a warning) when defVer is blank — a real server build does this', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const get = vi.fn().mockResolvedValue({
      data: '<Res Code="0"><settings><defVer></defVer></settings></Res>'
    })

    const result = await getSettings(makeMockClient({ get }), '1.2.3.4', '8000', 'pw')

    expect(result.data?.defVerStatus).toBe('unknown')
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('surfaces defVerStatus="mismatch" and logs one prominent, structured warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const get = vi.fn().mockResolvedValue({
      data: '<Res Code="0"><settings><defVer>2112311201</defVer></settings></Res>'
    })

    const result = await getSettings(makeMockClient({ get }), '1.2.3.4', '8000', 'pw')

    expect(result.data?.defVerStatus).toBe('mismatch')
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('MISMATCH'),
      expect.objectContaining({
        defVer: '2112311201',
        expectedDefVer: EXPECTED_DEF_VERSION,
        defVerStatus: 'mismatch'
      })
    )
    warn.mockRestore()
  })
})

describe('checkDefVersion', () => {
  it('is "match" when defVer equals EXPECTED_DEF_VERSION', () => {
    expect(checkDefVersion(EXPECTED_DEF_VERSION)).toBe('match')
  })

  it('is "mismatch" when defVer is present and different — e.g. the older VIL manual\'s defVer', () => {
    expect(checkDefVersion('2112311201')).toBe('mismatch')
  })

  it('is "unknown", not "mismatch", when defVer is blank or absent', () => {
    expect(checkDefVersion('')).toBe('unknown')
    expect(checkDefVersion(undefined)).toBe('unknown')
  })
})

describe('closeDeviceConnection', () => {
  it('GETs clientremove(who=me), the vendor ServerCloseDeviceConnection call', async () => {
    const get = vi.fn().mockResolvedValue({ data: '<Res Code="0"/>' })

    await closeDeviceConnection(makeMockClient({ get }))

    expect(get).toHaveBeenCalledWith('http://localhost:4444/clientremove(who=me)', {
      timeout: ETIMS_REQUEST_TIMEOUT_MS
    })
  })

  it('honors the client instance timeout instead of always hardcoding ETIMS_REQUEST_TIMEOUT_MS (phase-69)', async () => {
    const get = vi.fn().mockResolvedValue({ data: '<Res Code="0"/>' })

    await closeDeviceConnection(makeMockClient({ get }, DEFAULT_ETIMS_BASE_URL, 9999))

    expect(get).toHaveBeenCalledWith('http://localhost:4444/clientremove(who=me)', { timeout: 9999 })
  })
})

describe('postXml', () => {
  it('posts a <Command Name> envelope to the base URL with the vendor header', async () => {
    const post = vi.fn().mockResolvedValue({ data: '<Res Code="0"/>' })
    const client = makeMockClient({ post })

    await postXml(client, '', 'OpenInvoiceWithFreeCustomerData', { CompanyName: 'Acme' })

    expect(post).toHaveBeenCalledWith(
      '',
      '<Command Name="OpenInvoiceWithFreeCustomerData"><Args><Arg Name="CompanyName" Value="Acme"/></Args></Command>',
      {
        headers: { 'Content-Type': FISCAL_CONTENT_TYPE },
        timeout: ETIMS_REQUEST_TIMEOUT_MS
      }
    )
  })

  it('posts a self-closing Command for a no-argument command', async () => {
    const post = vi.fn().mockResolvedValue({ data: '<Res Code="0"/>' })

    await postXml(makeMockClient({ post }), '', 'ReadStatus', {})

    expect(post.mock.calls[0][1]).toBe('<Command Name="ReadStatus"/>')
  })

  it('still honors a non-empty path for a differently routed deployment', async () => {
    const post = vi.fn().mockResolvedValue({ data: '<Res Code="0"/>' })

    await postXml(makeMockClient({ post }), '/api/v1/receipt/open', 'CloseReceipt', {})

    expect(post.mock.calls[0][0]).toBe('/api/v1/receipt/open')
  })

  it('returns a failed ServiceResult on a network error', async () => {
    const post = vi.fn().mockRejectedValue(new Error('connection refused'))

    const result = await postXml(makeMockClient({ post }), '', 'ReadStatus', {})

    expect(result.success).toBe(false)
  })

  it('honors the client instance timeout instead of always hardcoding ETIMS_REQUEST_TIMEOUT_MS (phase-69)', async () => {
    const post = vi.fn().mockResolvedValue({ data: '<Res Code="0"/>' })
    const client = makeMockClient({ post }, DEFAULT_ETIMS_BASE_URL, 9999)

    await postXml(client, '', 'ReadStatus', {})

    expect(post).toHaveBeenCalledWith('', '<Command Name="ReadStatus"/>', expect.objectContaining({ timeout: 9999 }))
  })

  it('falls back to ETIMS_REQUEST_TIMEOUT_MS when the client has no instance timeout configured', async () => {
    const post = vi.fn().mockResolvedValue({ data: '<Res Code="0"/>' })

    await postXml(makeMockClient({ post }), '', 'ReadStatus', {})

    expect(post).toHaveBeenCalledWith(
      '',
      '<Command Name="ReadStatus"/>',
      expect.objectContaining({ timeout: ETIMS_REQUEST_TIMEOUT_MS })
    )
  })

  it('logs nothing by default (debug off) — no wire trace on a normal call (phase-80)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const post = vi.fn().mockResolvedValue({ data: '<Res Code="0"/>' })

    await postXml(makeMockClient({ post }), '', 'ReadStatus', {})

    expect(log).not.toHaveBeenCalled()
    log.mockRestore()
  })

  it('with debug on, logs the request and response', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const post = vi.fn().mockResolvedValue({ data: '<Res Code="0"/>' })

    await postXml(makeMockClient({ post }), '', 'ReadStatus', {}, true)

    expect(log).toHaveBeenCalledTimes(2)
    log.mockRestore()
  })
})
