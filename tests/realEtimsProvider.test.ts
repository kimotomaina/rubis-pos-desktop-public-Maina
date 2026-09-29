/**
 * Real eTIMS provider tests.
 *
 * Injects a mock `AxiosInstance` so the local ZFPLabServer workflow —
 * `settings()` → ReadStatus → OpenInvoiceWithFreeCustomerData →
 * SellPLUfromExtDB (per line) → ReadCurrentReceiptInfo → CloseReceipt →
 * ReadDateTime — can be asserted without the server or a device
 * running. Every wire shape asserted here (the `settings()` GET string,
 * the `<Command Name="…"><Args>` envelope, the vendor argument names,
 * and the response field names) comes from the decompiled `FPcore.jar`
 * definitions plus live calls against the running server.
 *
 * The server is a single endpoint: commands route on the XML body's
 * `Command/@Name`, so mocks key their responses off the posted body
 * (`call[1]`) via {@link commandNameOf} rather than the path.
 */

import { describe, it, expect, vi } from 'vitest'
import type { AxiosInstance } from 'axios'
import {
  RealFiscalizationProvider,
  DEFAULT_FISCAL_ENDPOINTS,
  mapFiscalDeviceError,
  mapFiscalServerError,
  sumVatGroupSubtotals,
  extractVatGroupAmounts,
  DAILY_CLOSURE_BLOCK_REASON,
  UNVERIFIABLE_RETRY_REASON
} from '../src/main/services/integrations/real-etims-provider.js'
import { EXPECTED_DEF_VERSION } from '../src/main/services/integrations/http-client.js'
import { routeFiscalOutcome } from '../src/main/services/fiscal-routing.js'
import type { FiscalInvoiceRequest } from '../src/main/services/integrations/etims.js'

/**
 * Device details every construction here supplies.
 *
 * `RealFiscalizationProvider` has no defaults for ip/port/password by
 * design (a guessed password reads as a device fault on the wire — see
 * `docs/phase-89.md` section 5), and without them `submitInvoice`
 * short-circuits with "not set up yet" before sending anything. Tests
 * that want the not-configured path assert it explicitly in
 * `tests/fiscalNotConfigured.test.ts`.
 */
const TEST_DEVICE = {
  deviceIp: '192.168.1.50',
  devicePort: '8000',
  password: 'test-device-password'
} as const

/** Builds a mock axios instance exposing `post`, `get` and `defaults.baseURL`. */
function makeMockClient(
  post: ReturnType<typeof vi.fn>,
  get: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({ data: '<Res Code="0"/>' })
): AxiosInstance {
  return { post, get, defaults: { baseURL: 'http://localhost:4444/' } } as unknown as AxiosInstance
}

/**
 * Builds the `settings()` GET mock for a server echoing `defVer` — the
 * selector for every version-dependent behaviour (phase-110). Omit
 * `defVer` for the blank `<defVer></defVer>` a real captured
 * `settings-ok.xml` carries.
 *
 * @param {string} [defVer]
 * @returns {ReturnType<typeof vi.fn>}
 */
function makeSettingsGet(defVer?: string): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    data: `<Res Code="0"><settings><defVer>${defVer ?? ''}</defVer></settings></Res>`
  })
}

/** Builds a successful `<Res Code="0">` response body from flat field values. */
function xmlResponse(fields: Record<string, string> = {}): string {
  const body = Object.entries(fields)
    .map(([key, value]) => `<${key}>${value}</${key}>`)
    .join('')
  return `<Res Code="0">${body}</Res>`
}

/** Builds a server-level error response (`<Err Source="Server">`), e.g. Code 31 (TCP auth). */
function xmlServerError(code: string, message: string): string {
  return `<Res Code="${code}"><Err Source="Server" Type="ServTCPAuth"><Message>${message}</Message></Err></Res>`
}

/**
 * Builds a real Code-40 ("command error") device business-error response —
 * the actual wire shape (phase-69, finding 4.1b): a `<Res Code="40">`
 * envelope with `STE1`/`STE2` as hex **attributes** on `<Err>`, confirmed
 * from `fp_core.js:71-75` (the vendor client only ever reads `STE1`/`STE2`/
 * `FPLibErrorCode` when `resCode === 40`) and protocol PDF §1.2.1's
 * two-column "Table Errors". An earlier revision of these tests used the
 * STE2 *decimal* value directly as the outer `<Res Code>` with STE1/STE2
 * as child elements — that shape never occurs on the real wire; see
 * `docs/phase-69.md`.
 *
 * @param {number} ste2Decimal decimal STE2 (command-errors column) value
 * @param {string} message
 * @param {number} [ste1Decimal=0] decimal STE1 (FD-errors column) value — only the open-receipt tests pass this explicitly
 */
function xmlCommandError(ste2Decimal: number, message: string, ste1Decimal = 0): string {
  const ste1Hex = ste1Decimal.toString(16)
  const ste2Hex = ste2Decimal.toString(16)
  return `<Res Code="40"><Err Source="Device" Type="FPException" STE1="${ste1Hex}" STE2="${ste2Hex}" FPLibErrorCode="00"><Message>${message}</Message></Err></Res>`
}

/** Reads the `<Command Name="...">` command name out of a mock `axios.post` call's posted body. */
function commandNameOf(call: unknown[]): string {
  return /<Command Name="([^"]+)"/.exec(String(call[1]))?.[1] ?? ''
}

/** The ordered list of command names a mock `post` was called with. */
function commandSequence(post: ReturnType<typeof vi.fn>): string[] {
  return post.mock.calls.map((call) => commandNameOf(call))
}

/** Returns the posted XML body for the first call to `commandName`. */
function bodyFor(post: ReturnType<typeof vi.fn>, commandName: string): string {
  const call = post.mock.calls.find((c) => commandNameOf(c) === commandName)
  return String(call?.[1] ?? '')
}

/** Extracts `<Arg Name Value/>` pairs, in order, from a posted command body. */
function argsOf(body: string): Array<[string, string]> {
  return [...body.matchAll(/<Arg Name="([^"]*)" Value="([^"]*)"\/>/g)].map(([, name, value]) => [
    name,
    value
  ])
}

/**
 * Default per-command responses for a fully successful run: ReadStatus
 * reports a fiscalized, TIMS-paired device; ReadCurrentReceiptInfo
 * reports an open receipt with a non-zero VAT-group subtotal (the read-
 * VAT gate); CloseReceipt returns the vendor's `InvoiceNum`/`QRcode`;
 * ReadDateTime returns a device timestamp. Everything else succeeds
 * with a bare `<Res Code="0"/>`.
 */
function makeSuccessfulPostImpl(): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation((path: string, body: string) => {
    switch (commandNameOf([path, body])) {
      case 'ReadStatus':
        return Promise.resolve({
          data: xmlResponse({ CU_fiscalized: '1', Paired_with_TIMS: '1' })
        })
      case 'ReadCurrentReceiptInfo':
        return Promise.resolve({
          data: xmlResponse({
            OptionIsReceiptOpened: '1',
            SalesNumber: '2',
            SubtotalAmountVATGA: '219.20',
            SubtotalAmountVATGB: '0.00'
          })
        })
      case 'CloseReceipt':
        return Promise.resolve({ data: xmlResponse({ InvoiceNum: 'KRA-0001', QRcode: 'base64qr' }) })
      case 'ReadDateTime':
        return Promise.resolve({ data: xmlResponse({ DateTime: '01-01-2026 09:30' }) })
      case 'ReadCUnumbers':
        return Promise.resolve({
          data: xmlResponse({ SerialNumber: 'MOCK-CU-SERIAL-0001', PINnumber: '00000000001' })
        })
      default:
        return Promise.resolve({ data: xmlResponse() })
    }
  })
}

const SAMPLE_REQUEST: FiscalInvoiceRequest = {
  clientOrderUuid: '11111111-2222-3333-4444-555555555555',
  items: [
    { description: 'Bread', quantity: 2, unitPrice: 60, taxRate: 0.16 },
    { description: 'Milk', quantity: 1, unitPrice: 80, taxRate: 0.16 }
  ],
  total: 219.2,
  taxAmount: 30.2,
  paymentMethod: 'cash',
  amountTendered: 250
}

describe('mapFiscalServerError', () => {
  it.each([
    ['19', /open socket/i],
    ['30', /cannot reach the fiscal device/i],
    ['31', /TCP password/i],
    ['53', /not initialized/i],
    ['63', /request format/i]
  ])('maps server code %s to an actionable message', (code, expected) => {
    expect(mapFiscalServerError(code)?.message).toMatch(expected)
  })

  it('returns undefined for a code that is not a server code', () => {
    expect(mapFiscalServerError('52')).toBeUndefined()
  })

  it('marks the transient/technical codes (19, 30, 31, 53) retryable — only 63 (bad request format) is not', () => {
    expect(mapFiscalServerError('19')?.retryable).toBe(true)
    expect(mapFiscalServerError('30')?.retryable).toBe(true)
    expect(mapFiscalServerError('31')?.retryable).toBe(true)
    expect(mapFiscalServerError('53')?.retryable).toBe(true)
    expect(mapFiscalServerError('63')?.retryable).toBe(false)
  })
})

describe('mapFiscalDeviceError (phase-69: full STE2 command-errors table, protocol PDF §1.2.1)', () => {
  it.each([
    ['49', 'Invalid command'],
    ['51', 'Z daily report is not zero'],
    ['52', 'Syntax error'],
    ['53', 'Input registers overflow'],
    ['54', 'Zero input registers'],
    ['55', 'Unavailable transaction for correction'],
    ['56', 'Insufficient amount on hand'],
    ['57', 'Conflict in tax group'],
    ['58', 'Invoice number not found'],
    ['59', 'Wrong client PIN'],
    ['60', 'Missing defined item'],
    ['61', 'Item quantity too large'],
    ['62', 'Item amount too large'],
    ['63', 'Amount exceeds original invoice'],
    ['64', 'HS code is not valid']
  ])('maps STE2 decimal %s to the PDF-correct message, non-retryable', (code, expectedMessage) => {
    const result = mapFiscalDeviceError(code, 'raw device message')
    expect(result.message).toBe(expectedMessage)
    expect(result.retryable).toBe(false)
  })

  it('maps STE2 decimal 50 (0x32, "Illegal command") as retryable — refused on the device state, not the data (docs/phase-184)', () => {
    const result = mapFiscalDeviceError('50', 'raw device message')
    expect(result.message).toBe('Illegal command')
    expect(result.retryable).toBe(true)
  })

  it('falls back to the raw message for an unrecognized code', () => {
    const result = mapFiscalDeviceError('99', 'Something the manual never listed')
    expect(result.message).toBe('Something the manual never listed')
    expect(result.retryable).toBe(false)
  })
})

describe('sumVatGroupSubtotals', () => {
  it('sums the five per-VAT-group subtotal fields', () => {
    expect(
      sumVatGroupSubtotals({ SubtotalAmountVATGA: '100.00', SubtotalAmountVATGC: '19.20' })
    ).toBeCloseTo(119.2)
  })

  it('treats absent or non-numeric groups as zero', () => {
    expect(sumVatGroupSubtotals({})).toBe(0)
    expect(sumVatGroupSubtotals({ SubtotalAmountVATGA: '', SubtotalAmountVATGB: 'n/a' })).toBe(0)
  })
})

describe('extractVatGroupAmounts (docs/phase-163)', () => {
  it('reads the raw strings verbatim, keyed by VAT class letter', () => {
    expect(
      extractVatGroupAmounts({
        SubtotalAmountVATGA: '120.00',
        SubtotalAmountVATGB: '0.00',
        SubtotalAmountVATGC: '0.00',
        SubtotalAmountVATGD: '0.00',
        SubtotalAmountVATGE: '0.00'
      })
    ).toEqual({ A: '120.00', B: '0.00', C: '0.00', D: '0.00', E: '0.00' })
  })

  it('leaves a group out entirely when the response has no field for it — never defaults to "0.00"', () => {
    expect(extractVatGroupAmounts({ SubtotalAmountVATGA: '219.20' })).toEqual({ A: '219.20' })
  })

  it('returns an empty object for a response with no VAT-group fields at all', () => {
    expect(extractVatGroupAmounts({})).toEqual({})
  })

  it('does not parse or sum — a non-numeric string is carried through unchanged', () => {
    expect(extractVatGroupAmounts({ SubtotalAmountVATGA: 'n/a' })).toEqual({ A: 'n/a' })
  })
})

describe('settings() session handshake', () => {
  it('sends the exact settings() GET before the first command', async () => {
    const post = makeSuccessfulPostImpl()
    const get = vi.fn().mockResolvedValue({ data: '<Res Code="0"><settings/></Res>' })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE,
      httpClient: makeMockClient(post, get),
      deviceIp: '154.79.253.236',
      devicePort: '8000',
      password: 'Password'
    })

    await provider.submitInvoice(SAMPLE_REQUEST)

    expect(get).toHaveBeenCalledWith(
      'http://localhost:4444/settings(ip=154.79.253.236,port=8000,password=Password,tcp=1)',
      expect.anything()
    )
    expect(get.mock.invocationCallOrder[0]).toBeLessThan(post.mock.invocationCallOrder[0])
  })

  it('sends settings() once per session, not once per sale', async () => {
    const post = makeSuccessfulPostImpl()
    const get = vi.fn().mockResolvedValue({ data: '<Res Code="0"/>' })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post, get) })

    await provider.submitInvoice(SAMPLE_REQUEST)
    await provider.submitInvoice(SAMPLE_REQUEST)

    expect(get).toHaveBeenCalledTimes(1)
  })

})

describe('ReadCUnumbers session read (phase-67, finding #3)', () => {
  it('sends the arg-free ReadCUnumbers command and surfaces cuSerialNumber on the result', async () => {
    const post = makeSuccessfulPostImpl()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(true)
    expect(result.ok && result.data.cuSerialNumber).toBe('MOCK-CU-SERIAL-0001')
    expect(commandSequence(post)).toContain('ReadCUnumbers')
    expect(argsOf(bodyFor(post, 'ReadCUnumbers'))).toEqual([])
  })

  it('reads ReadCUnumbers once per session, not once per sale', async () => {
    const post = makeSuccessfulPostImpl()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    await provider.submitInvoice(SAMPLE_REQUEST)
    await provider.submitInvoice(SAMPLE_REQUEST)

    expect(commandSequence(post).filter((c) => c === 'ReadCUnumbers')).toHaveLength(1)
  })

  it('never blocks a sale when ReadCUnumbers fails — best-effort only', async () => {
    const post = vi.fn().mockImplementation((path: string, body: string) => {
      if (commandNameOf([path, body]) === 'ReadCUnumbers') {
        return Promise.resolve({ data: '<Res Code="30"><Err Source="Server"/></Res>' })
      }
      return makeSuccessfulPostImpl()(path, body)
    })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(true)
    expect(result.ok && result.data.cuSerialNumber).toBeUndefined()
  })

  it('retries ReadCUnumbers on the next sale after a failed one, not caching the failure', async () => {
    let failFirst = true
    const post = vi.fn().mockImplementation((path: string, body: string) => {
      if (commandNameOf([path, body]) === 'ReadCUnumbers') {
        if (failFirst) {
          failFirst = false
          return Promise.resolve({ data: '<Res Code="30"><Err Source="Server"/></Res>' })
        }
      }
      return makeSuccessfulPostImpl()(path, body)
    })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const first = await provider.submitInvoice(SAMPLE_REQUEST)
    const second = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(first.ok && first.data.cuSerialNumber).toBeUndefined()
    expect(second.ok && second.data.cuSerialNumber).toBe('MOCK-CU-SERIAL-0001')
    expect(commandSequence(post).filter((c) => c === 'ReadCUnumbers')).toHaveLength(2)
  })
})

describe('defVer gating (phase-68, finding #1)', () => {
  it('surfaces defVerStatus="unknown" on the result when settings() echoes no defVer', async () => {
    const post = makeSuccessfulPostImpl()
    const get = vi.fn().mockResolvedValue({ data: '<Res Code="0"><settings/></Res>' })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post, get) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(true)
    expect(result.ok && result.data.defVerStatus).toBe('unknown')
  })

  it('surfaces defVerStatus="match" when settings() echoes the expected defVer', async () => {
    const post = makeSuccessfulPostImpl()
    const get = vi
      .fn()
      .mockResolvedValue({ data: '<Res Code="0"><settings><defVer>2509041522</defVer></settings></Res>' })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post, get) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok && result.data.defVerStatus).toBe('match')
  })

  it('surfaces defVerStatus="mismatch" but still completes the sale — never a hard block', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const post = makeSuccessfulPostImpl()
    const get = vi
      .fn()
      .mockResolvedValue({ data: '<Res Code="0"><settings><defVer>2112311201</defVer></settings></Res>' })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post, get) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(true)
    expect(result.ok && result.data.defVerStatus).toBe('mismatch')
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('MISMATCH'),
      expect.objectContaining({ defVerStatus: 'mismatch' })
    )
    warn.mockRestore()
  })

  it('reads defVerStatus once per session (from the cached settings() handshake), not once per sale', async () => {
    const post = makeSuccessfulPostImpl()
    const get = vi
      .fn()
      .mockResolvedValue({ data: '<Res Code="0"><settings><defVer>2112311201</defVer></settings></Res>' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post, get) })

    const first = await provider.submitInvoice(SAMPLE_REQUEST)
    const second = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(first.ok && first.data.defVerStatus).toBe('mismatch')
    expect(second.ok && second.data.defVerStatus).toBe('mismatch')
    expect(get).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})

describe('settings() session handshake — configured device details', () => {
  it('sends the configured device ip/port/password verbatim in the settings() string', async () => {
    const get = vi.fn().mockResolvedValue({ data: '<Res Code="0"/>' })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE,
      httpClient: makeMockClient(makeSuccessfulPostImpl(), get)
    })

    await provider.submitInvoice(SAMPLE_REQUEST)

    expect(get.mock.calls[0][0]).toBe(
      'http://localhost:4444/settings(ip=192.168.1.50,port=8000,password=test-device-password,tcp=1)'
    )
  })

  it('substitutes NO default for a missing ip/port/password — it refuses to call instead', async () => {
    // The `'Password'` placeholder default this replaced turned "nobody
    // has set this up" into a device-side Code 31 that reads like a
    // hardware fault. See `docs/phase-89.md` section 5.
    const get = vi.fn()
    const post = vi.fn()
    const provider = new RealFiscalizationProvider({
      httpClient: makeMockClient(post, get)
    })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(false)
    expect(get).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
  })

  it('fails the sale without issuing commands when settings() itself fails', async () => {
    const post = makeSuccessfulPostImpl()
    const get = vi.fn().mockResolvedValue({ data: xmlServerError('30', 'ServSockConnectionFailed') })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post, get) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/cannot reach the fiscal device/i)
    expect(post).not.toHaveBeenCalled()
  })

  it('retries the handshake on the next sale after a failed one (never caches a failure)', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ data: xmlServerError('30', 'ServSockConnectionFailed') })
      .mockResolvedValue({ data: '<Res Code="0"/>' })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE,
      httpClient: makeMockClient(makeSuccessfulPostImpl(), get)
    })

    const first = await provider.submitInvoice(SAMPLE_REQUEST)
    const second = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(first.ok).toBe(false)
    expect(second.ok).toBe(true)
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('re-sends settings() and retries once when a command returns Code 53', async () => {
    let readStatusCalls = 0
    const post = vi.fn().mockImplementation((path: string, body: string) => {
      const command = commandNameOf([path, body])
      if (command === 'ReadStatus') {
        readStatusCalls += 1
        if (readStatusCalls === 1) {
          return Promise.resolve({ data: xmlServerError('53', 'Client settings not initialized') })
        }
        return Promise.resolve({ data: xmlResponse({ CU_fiscalized: '1', Paired_with_TIMS: '1' }) })
      }
      return makeSuccessfulPostImpl()(path, body)
    })
    const get = vi.fn().mockResolvedValue({ data: '<Res Code="0"/>' })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post, get) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(true)
    expect(readStatusCalls).toBe(2)
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('does not close the server connection on the per-sale happy path', async () => {
    const get = vi.fn().mockResolvedValue({ data: '<Res Code="0"/>' })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE,
      httpClient: makeMockClient(makeSuccessfulPostImpl(), get)
    })

    await provider.submitInvoice(SAMPLE_REQUEST)

    expect(get.mock.calls.some(([url]) => String(url).includes('clientremove'))).toBe(false)
  })

  it('closes the server connection on demand, for app shutdown', async () => {
    const get = vi.fn().mockResolvedValue({ data: '<Res Code="0"/>' })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE,
      httpClient: makeMockClient(makeSuccessfulPostImpl(), get)
    })

    await provider.closeServerConnection()

    expect(get).toHaveBeenCalledWith(
      'http://localhost:4444/clientremove(who=me)',
      expect.anything()
    )
  })
})

describe('RealFiscalizationProvider.submitInvoice', () => {
  it('drives the workflow in order: ReadCUnumbers, ReadStatus, OpenInvoice, SellPLU per line, ReadCurrentReceiptInfo, CloseReceipt, ReadDateTime', async () => {
    const post = makeSuccessfulPostImpl()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(commandSequence(post)).toEqual([
      'ReadCUnumbers',
      'ReadStatus',
      'OpenInvoiceWithFreeCustomerData',
      'SellPLUfromExtDB',
      'SellPLUfromExtDB',
      'ReadCurrentReceiptInfo',
      'CloseReceipt',
      'ReadDateTime'
    ])
    expect(result.ok).toBe(true)
    expect(result.ok && result.data.invoiceNumber).toBe('KRA-0001')
    expect(result.ok && result.data.qrCode).toBe('base64qr')
  })

  it('records the device timestamp and marks it device-sourced', async () => {
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE,
      httpClient: makeMockClient(makeSuccessfulPostImpl())
    })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok && result.data.fiscalizedAt).toBe('01-01-2026 09:30')
    expect(result.ok && result.data.fiscalizedAtSource).toBe('device')
  })

  it('flags a local-clock timestamp as not device-sourced when ReadDateTime returns nothing', async () => {
    const post = vi.fn().mockImplementation((path: string, body: string) => {
      if (commandNameOf([path, body]) === 'ReadDateTime') {
        return Promise.resolve({ data: xmlResponse() })
      }
      return makeSuccessfulPostImpl()(path, body)
    })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(true)
    expect(result.ok && result.data.fiscalizedAtSource).toBe('local-fallback')
  })

  it('posts every command to the base URL as a <Command Name> envelope — never <Request Name>', async () => {
    const post = makeSuccessfulPostImpl()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    await provider.submitInvoice(SAMPLE_REQUEST)

    for (const call of post.mock.calls) {
      expect(call[0]).toBe('')
      expect(String(call[1])).toMatch(/^<Command Name="/)
      expect(String(call[1])).not.toContain('<Request')
    }
  })

  it('sends no ip/port/password in any posted command body', async () => {
    const post = makeSuccessfulPostImpl()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE,
      httpClient: makeMockClient(post),
      deviceIp: '154.79.253.236',
      devicePort: '8000',
      password: 'Password'
    })

    await provider.submitInvoice(SAMPLE_REQUEST)

    const allBodies = post.mock.calls.map((call) => String(call[1])).join('')
    expect(allBodies).not.toContain('154.79.253.236')
    expect(allBodies).not.toContain('Password')
  })

  it('sends ReadStatus and CloseReceipt as self-closing, argument-free commands', async () => {
    const post = makeSuccessfulPostImpl()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    await provider.submitInvoice(SAMPLE_REQUEST)

    expect(bodyFor(post, 'ReadStatus')).toBe('<Command Name="ReadStatus"/>')
    expect(bodyFor(post, 'CloseReceipt')).toBe('<Command Name="CloseReceipt"/>')
    expect(bodyFor(post, 'ReadCurrentReceiptInfo')).toBe(
      '<Command Name="ReadCurrentReceiptInfo"/>'
    )
    expect(bodyFor(post, 'ReadDateTime')).toBe('<Command Name="ReadDateTime"/>')
  })

  it('rejects a request with no line items without calling the device', async () => {
    const post = makeSuccessfulPostImpl()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice({ ...SAMPLE_REQUEST, items: [] })

    expect(result.ok).toBe(false)
    expect(post).not.toHaveBeenCalled()
  })

  it('uses configured endpoint overrides instead of the single-endpoint default', async () => {
    const post = makeSuccessfulPostImpl()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE,
      httpClient: makeMockClient(post),
      endpoints: { readStatus: '/status', closeReceipt: '/close' }
    })

    await provider.submitInvoice(SAMPLE_REQUEST)

    const pathOf = (command: string): unknown =>
      post.mock.calls.find((call) => commandNameOf(call) === command)?.[0]
    expect(pathOf('ReadStatus')).toBe('/status')
    expect(pathOf('CloseReceipt')).toBe('/close')
    expect(pathOf('SellPLUfromExtDB')).toBe(DEFAULT_FISCAL_ENDPOINTS.sellPLU)
  })
})

describe('ReadStatus gate', () => {
  it('passes on Res Code 0 with CU_fiscalized=1 and Paired_with_TIMS=1', async () => {
    const post = makeSuccessfulPostImpl()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(true)
  })

  it('fails with a device-auth message on a Code 31 ReadStatus', async () => {
    const post = vi.fn().mockImplementation((path: string, body: string) => {
      if (commandNameOf([path, body]) === 'ReadStatus') {
        return Promise.resolve({ data: xmlServerError('31', 'ServTCPAuth') })
      }
      return makeSuccessfulPostImpl()(path, body)
    })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/TCP password/i)
    expect(commandSequence(post)).not.toContain('OpenInvoiceWithFreeCustomerData')
  })

  it('fails when the device reports it is not fiscalized', async () => {
    const post = vi.fn().mockImplementation((path: string, body: string) => {
      if (commandNameOf([path, body]) === 'ReadStatus') {
        return Promise.resolve({
          data: xmlResponse({ CU_fiscalized: '0', Paired_with_TIMS: '1' })
        })
      }
      return makeSuccessfulPostImpl()(path, body)
    })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/not fiscalized/i)
  })

  it('fails when the device reports it is not paired with TIMS', async () => {
    const post = vi.fn().mockImplementation((path: string, body: string) => {
      if (commandNameOf([path, body]) === 'ReadStatus') {
        return Promise.resolve({
          data: xmlResponse({ CU_fiscalized: '1', Paired_with_TIMS: '0' })
        })
      }
      return makeSuccessfulPostImpl()(path, body)
    })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/not paired with TIMS/i)
  })

  it('proceeds (with a warning) when the status bits are absent but the code is 0', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const post = vi.fn().mockImplementation((path: string, body: string) => {
      if (commandNameOf([path, body]) === 'ReadStatus') {
        return Promise.resolve({ data: xmlResponse() })
      }
      return makeSuccessfulPostImpl()(path, body)
    })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(true)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('OpenInvoiceWithFreeCustomerData payload', () => {
  it('sends exactly the vendor seven arguments, in order, with no reserved/InvoiceType', async () => {
    const post = makeSuccessfulPostImpl()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    await provider.submitInvoice(SAMPLE_REQUEST)

    const body = bodyFor(post, 'OpenInvoiceWithFreeCustomerData')
    expect(argsOf(body).map(([name]) => name)).toEqual([
      'CompanyName',
      'ClientPINnum',
      'HeadQuarters',
      'Address',
      'PostalCodeAndCity',
      'ExemptionNum',
      'TraderSystemInvNum'
    ])
    expect(body).not.toContain('reserved')
    expect(body).not.toContain('InvoiceType')
  })

  it('keeps blank <Arg> elements for uncaptured customer fields', async () => {
    const post = makeSuccessfulPostImpl()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    await provider.submitInvoice(SAMPLE_REQUEST)

    const args = Object.fromEntries(argsOf(bodyFor(post, 'OpenInvoiceWithFreeCustomerData')))
    expect(args.CompanyName).toBe('')
    expect(args.ClientPINnum).toBe('')
    expect(args.HeadQuarters).toBe('')
    expect(args.Address).toBe('')
  })

  it('populates CompanyName and ClientPINnum when captured', async () => {
    const post = makeSuccessfulPostImpl()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    await provider.submitInvoice({
      ...SAMPLE_REQUEST,
      companyName: 'Acme Traders Ltd',
      buyerPin: 'P051234567Z'
    })

    const args = Object.fromEntries(argsOf(bodyFor(post, 'OpenInvoiceWithFreeCustomerData')))
    expect(args.CompanyName).toBe('Acme Traders Ltd')
    expect(args.ClientPINnum).toBe('P051234567Z')
  })

  it('truncates CompanyName to 30 characters', async () => {
    const post = makeSuccessfulPostImpl()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    await provider.submitInvoice({
      ...SAMPLE_REQUEST,
      companyName: 'A'.repeat(60)
    })

    const args = Object.fromEntries(argsOf(bodyFor(post, 'OpenInvoiceWithFreeCustomerData')))
    expect(args.CompanyName).toHaveLength(30)
  })

  it('ClientPINnum truncation is defense-in-depth only, unreachable via validated input (phase-66)', async () => {
    // Anything long enough to need MAX_CLIENT_PIN_LENGTH (14) truncation
    // is, by construction, not an 11-character KRA PIN — so
    // validateFiscalInvoiceRequest (fiscal-validate.ts) now rejects it
    // before buildOpenInvoiceArgs's sanitizeFiscalText(..., 14) truncation
    // ever runs. The truncation call stays in the provider as belt-and-
    // braces (same philosophy as fiscal-sanitize.ts's own doc comment),
    // but this test documents that it's no longer reachable through the
    // public submitInvoice() API — a bad-shaped PIN fails validation
    // first, every time.
    const post = makeSuccessfulPostImpl()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice({ ...SAMPLE_REQUEST, buyerPin: 'P'.repeat(30) })

    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/must be 11 characters/)
    expect(post).not.toHaveBeenCalled()
  })

  it('sanitizes free-text fields, stripping symbols that can silently block TIMS', async () => {
    const post = makeSuccessfulPostImpl()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    await provider.submitInvoice({ ...SAMPLE_REQUEST, companyName: 'Acme #1 <Traders> & Co!' })

    const args = Object.fromEntries(argsOf(bodyFor(post, 'OpenInvoiceWithFreeCustomerData')))
    expect(args.CompanyName).toBe('Acme 1 Traders Co')
  })

  it('uses a zero-padded INV-<localId> for TraderSystemInvNum, never over 15 characters', async () => {
    const post = makeSuccessfulPostImpl()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    await provider.submitInvoice({ ...SAMPLE_REQUEST, localId: 42 })

    const args = Object.fromEntries(argsOf(bodyFor(post, 'OpenInvoiceWithFreeCustomerData')))
    expect(args.TraderSystemInvNum).toBe('INV-000000042')
    expect(args.TraderSystemInvNum.length).toBeLessThanOrEqual(15)
  })

  it('falls back to a truncated clientOrderUuid when there is no localId', async () => {
    const post = makeSuccessfulPostImpl()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    await provider.submitInvoice(SAMPLE_REQUEST)

    const args = Object.fromEntries(argsOf(bodyFor(post, 'OpenInvoiceWithFreeCustomerData')))
    expect(args.TraderSystemInvNum).toBe('111111112222333')
  })

  /**
   * phase-74 Part A: `buildTraderSystemInvNum` is a pure function of the
   * sale's stable id (`localId`, falling back to `clientOrderUuid`) — a
   * queued retry resubmits the exact same stored `FiscalInvoiceRequest`
   * (see `fiscal-engine.ts#tick`), so it necessarily recomputes the
   * identical number. This is the number the device would use to
   * recognize a resubmission as a duplicate (phase-75's Part B) — it
   * has to stay stable across attempts, or that recovery can never work.
   */
  it('produces the SAME TraderSystemInvNum across two submissions of the same sale (original + retry)', async () => {
    const post = makeSuccessfulPostImpl()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })
    const request = { ...SAMPLE_REQUEST, localId: 7 }

    await provider.submitInvoice(request)
    const firstArgs = Object.fromEntries(argsOf(bodyFor(post, 'OpenInvoiceWithFreeCustomerData')))

    post.mockClear()
    // The exact same stored request object, resubmitted — precisely what
    // `fiscal-engine.ts#tick` does with a queued retry's `item.payload`.
    await provider.submitInvoice(request)
    const secondArgs = Object.fromEntries(argsOf(bodyFor(post, 'OpenInvoiceWithFreeCustomerData')))

    expect(secondArgs.TraderSystemInvNum).toBe(firstArgs.TraderSystemInvNum)
    expect(firstArgs.TraderSystemInvNum).toBe('INV-000000007')
  })

  it('produces DIFFERENT TraderSystemInvNum values for two different sales', async () => {
    const post = makeSuccessfulPostImpl()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    await provider.submitInvoice({ ...SAMPLE_REQUEST, localId: 7 })
    const saleOneArgs = Object.fromEntries(argsOf(bodyFor(post, 'OpenInvoiceWithFreeCustomerData')))

    post.mockClear()
    await provider.submitInvoice({ ...SAMPLE_REQUEST, localId: 8 })
    const saleTwoArgs = Object.fromEntries(argsOf(bodyFor(post, 'OpenInvoiceWithFreeCustomerData')))

    expect(saleOneArgs.TraderSystemInvNum).not.toBe(saleTwoArgs.TraderSystemInvNum)
  })

  it('cancels and retries once when the device reports STE1=52 (opened fiscal receipt)', async () => {
    let openCalls = 0
    const post = vi.fn().mockImplementation((path: string, body: string) => {
      if (commandNameOf([path, body]) === 'OpenInvoiceWithFreeCustomerData') {
        openCalls += 1
        if (openCalls === 1) {
          // STE1=52 (hex 0x34, FD-errors column) — "Opened fiscal receipt".
          // STE2 is irrelevant here (0/no condition) — the recovery keys
          // on STE1, never STE2.
          return Promise.resolve({ data: xmlCommandError(0, 'Opened fiscal receipt', 52) })
        }
      }
      return makeSuccessfulPostImpl()(path, body)
    })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(true)
    expect(openCalls).toBe(2)
    expect(commandSequence(post).slice(0, 4)).toEqual([
      'ReadCUnumbers',
      'ReadStatus',
      'OpenInvoiceWithFreeCustomerData',
      'CancelReceipt'
    ])
  })

  it('gives up after a second STE1=52 (opened receipt) rather than retrying forever', async () => {
    const post = vi.fn().mockImplementation((path: string, body: string) => {
      if (commandNameOf([path, body]) === 'OpenInvoiceWithFreeCustomerData') {
        return Promise.resolve({ data: xmlCommandError(0, 'Opened fiscal receipt', 52) })
      }
      return makeSuccessfulPostImpl()(path, body)
    })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(false)
    expect(commandSequence(post).filter((c) => c === 'OpenInvoiceWithFreeCustomerData')).toHaveLength(
      2
    )
  })

  it('does NOT trigger the open-receipt recovery on a bare STE2=52 (0x34, "Syntax error") — different column, same hex byte', async () => {
    const post = vi.fn().mockImplementation((path: string, body: string) => {
      if (commandNameOf([path, body]) === 'OpenInvoiceWithFreeCustomerData') {
        // STE1=0 (no FD condition), STE2=52 (hex 0x34) — "Syntax error" on
        // the *command*-errors column. Must NOT be mistaken for STE1=52
        // ("Opened fiscal receipt") on the FD-errors column.
        return Promise.resolve({ data: xmlCommandError(52, 'Syntax error') })
      }
      return makeSuccessfulPostImpl()(path, body)
    })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/Syntax error/)
    // No retry: exactly one OpenInvoiceWithFreeCustomerData call, no CancelReceipt.
    expect(commandSequence(post).filter((c) => c === 'OpenInvoiceWithFreeCustomerData')).toHaveLength(1)
    expect(commandSequence(post)).not.toContain('CancelReceipt')
  })

  it('surfaces a non-retryable device error (e.g. STE2=59, wrong PIN) immediately', async () => {
    const post = vi.fn().mockImplementation((path: string, body: string) => {
      if (commandNameOf([path, body]) === 'OpenInvoiceWithFreeCustomerData') {
        return Promise.resolve({ data: xmlCommandError(59, 'Wrong client PIN') })
      }
      return makeSuccessfulPostImpl()(path, body)
    })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    // A validly-shaped PIN, so the request passes pre-send validation and
    // reaches the (mocked) device — the device's own STE2=59 rejection is
    // what this test exercises, not the format check.
    const result = await provider.submitInvoice({ ...SAMPLE_REQUEST, buyerPin: 'P051234567Z' })

    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/Wrong client PIN/)
    expect(commandSequence(post)).not.toContain('SellPLUfromExtDB')
  })

  /**
   * phase-77: STE2=59 ("Wrong client PIN") is tagged `dataIssue:
   * 'wrong-pin'` — the small, stable marker the till uses to offer a
   * same-visit fix, set from the code `classifyDeviceFailure` already
   * has, never by matching this test's own `reason` string.
   */
  it('tags STE2=59 (wrong PIN) with dataIssue:"wrong-pin"', async () => {
    const post = vi.fn().mockImplementation((path: string, body: string) => {
      if (commandNameOf([path, body]) === 'OpenInvoiceWithFreeCustomerData') {
        return Promise.resolve({ data: xmlCommandError(59, 'Wrong client PIN') })
      }
      return makeSuccessfulPostImpl()(path, body)
    })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice({ ...SAMPLE_REQUEST, buyerPin: 'P051234567Z' })

    expect(result.ok).toBe(false)
    expect(!result.ok && result.dataIssue).toBe('wrong-pin')
  })

  it('does NOT tag a different STE2 data rejection (e.g. STE2=64, invalid HS code) with dataIssue', async () => {
    const post = vi.fn().mockImplementation((path: string, body: string) => {
      if (commandNameOf([path, body]) === 'OpenInvoiceWithFreeCustomerData') {
        return Promise.resolve({ data: xmlCommandError(64, 'HS code is not valid') })
      }
      return makeSuccessfulPostImpl()(path, body)
    })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(false)
    expect(!result.ok && result.dataIssue).toBeUndefined()
  })
})

/**
 * STE1=59 (hex 0x3b, "24 hours block, missing Z report" — docs/phase-159
 * B1.5, built in docs/phase-162). Named on `STE1` alone, checked ahead of
 * `STE2`'s command-errors table, at every one of the five submitInvoice
 * steps docs/phase-162's audit identified as able to carry a Code 40
 * (ReadStatus, OpenInvoice, SellPLU, ReadCurrentReceiptInfo, CloseReceipt),
 * and independent of whatever STE2 happens to carry alongside it — the
 * real STE1/STE2 pairing has never been observed on a live device.
 */
describe('STE1=59 (0x3b, "missing daily closure") named at every step it can arrive (docs/phase-162)', () => {
  const STEPS = [
    'ReadStatus',
    'OpenInvoiceWithFreeCustomerData',
    'SellPLUfromExtDB',
    'ReadCurrentReceiptInfo',
    'CloseReceipt'
  ] as const

  /** Fails exactly one named command with `xml`; every other command succeeds normally. */
  function withCommandError(commandName: string, xml: string): ReturnType<typeof vi.fn> {
    const success = makeSuccessfulPostImpl()
    return vi.fn().mockImplementation((path: string, body: string) => {
      if (commandNameOf([path, body]) === commandName) {
        return Promise.resolve({ data: xml })
      }
      return success(path, body)
    })
  }

  /** Asserts the daily-closure outcome shape common to every case below. */
  function expectDailyClosureOutcome(result: Awaited<ReturnType<RealFiscalizationProvider['submitInvoice']>>): void {
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toBe(
      'The fiscal device needs its daily closure before it can file sales. The sale is saved and will ' +
        'be filed once the closure is done. Call support.'
    )
    expect(!result.ok && result.kind).toBe('technical')
    expect(!result.ok && result.retryable).toBe(true)
    expect(!result.ok && result.dataIssue).toBeUndefined()
  }

  it.each(STEPS)(
    'STE2=59 at %s: daily-closure reason, kind technical, retryable, NOT tagged wrong-pin',
    async (step) => {
      // STE2=59 is "Wrong client PIN" in the command-errors table — this
      // proves STE1 wins outright, never falling through to STE2's mapping.
      const post = withCommandError(step, xmlCommandError(59, 'irrelevant', 59))
      const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

      const result = await provider.submitInvoice(SAMPLE_REQUEST)

      expectDailyClosureOutcome(result)
    }
  )

  it.each(STEPS)(
    'STE2=some other value (64) at %s: daily-closure reason, kind technical, retryable, NOT tagged wrong-pin',
    async (step) => {
      const post = withCommandError(step, xmlCommandError(64, 'irrelevant', 59))
      const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

      const result = await provider.submitInvoice(SAMPLE_REQUEST)

      expectDailyClosureOutcome(result)
    }
  )

  it.each(STEPS)(
    'STE2 absent at %s: daily-closure reason, kind technical, retryable, NOT tagged wrong-pin',
    async (step) => {
      // No STE2 attribute on <Err> at all — `checkDeviceResponse` must not
      // depend on STE2 being present, let alone any particular value.
      const xml =
        '<Res Code="40"><Err Source="Device" Type="FPException" STE1="3b" FPLibErrorCode="00">' +
        '<Message>irrelevant</Message></Err></Res>'
      const post = withCommandError(step, xml)
      const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

      const result = await provider.submitInvoice(SAMPLE_REQUEST)

      expectDailyClosureOutcome(result)
    }
  )
})

describe('OpenInvoice duplicate-filing recovery via ReadCUinvoiceNumber (phase-75, Part B — Rule 1)', () => {
  it('on a RETRY, when the device reports the invoice as already filed, recovers as fiscalized WITHOUT resending SellPLU/CloseReceipt', async () => {
    const post = vi.fn().mockImplementation((path: string, body: string) => {
      const command = commandNameOf([path, body])
      if (command === 'OpenInvoiceWithFreeCustomerData') {
        // Any rejection reason works here — the recovery is gated on
        // `request.isRetry`, deliberately NOT on recognizing a
        // particular error code as "this means duplicate" (per this
        // step's brief: "we don't need to know which error code means
        // duplicate — we ask the device").
        return Promise.resolve({ data: xmlCommandError(57, 'Conflict in tax group') })
      }
      if (command === 'ReadCUinvoiceNumber') {
        return Promise.resolve({ data: '<Res Code="0"><CU_InvoiceNumber>0000000009999999</CU_InvoiceNumber></Res>' })
      }
      return makeSuccessfulPostImpl()(path, body)
    })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice({ ...SAMPLE_REQUEST, isRetry: true })

    expect(result.ok).toBe(true)
    expect(result.ok && result.data.invoiceNumber).toBe('0000000009999999')
    // Rule 2 groundwork: no QR was ever returned for THIS attempt (only
    // CloseReceipt returns one, and CloseReceipt was never sent) — left
    // empty, never a fake/guessed value.
    expect(result.ok && result.data.qrCode).toBe('')
    expect(commandSequence(post)).toContain('ReadCUinvoiceNumber')
    expect(commandSequence(post)).not.toContain('SellPLUfromExtDB')
    expect(commandSequence(post)).not.toContain('CloseReceipt')
    // docs/phase-163: this recovery never runs Step 5 (ReadCurrentReceiptInfo)
    // again, so it carries no vatGroups — the caller stores NULL, never a
    // guessed or re-fetched figure.
    expect(result.ok && result.data.vatGroups).toBeUndefined()
  })

  it('on a RETRY, when the device does NOT know this invoice either, the rejection is a genuine failure — NOT falsely marked fiscalized', async () => {
    const post = vi.fn().mockImplementation((path: string, body: string) => {
      const command = commandNameOf([path, body])
      if (command === 'OpenInvoiceWithFreeCustomerData') {
        return Promise.resolve({ data: xmlCommandError(59, 'Wrong client PIN') })
      }
      if (command === 'ReadCUinvoiceNumber') {
        // Not-found shape: Code 0 but no <CU_InvoiceNumber> element.
        return Promise.resolve({ data: '<Res Code="0"/>' })
      }
      return makeSuccessfulPostImpl()(path, body)
    })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice({
      ...SAMPLE_REQUEST,
      buyerPin: 'P051234567Z',
      isRetry: true
    })

    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/Wrong client PIN/)
    expect(!result.ok && result.kind).toBe('data')
    expect(commandSequence(post)).toContain('ReadCUinvoiceNumber')
    expect(commandSequence(post)).not.toContain('SellPLUfromExtDB')
  })

  it('on a RETRY under the new defs, when ReadCUinvoiceNumber itself errors, the ORIGINAL OpenInvoice rejection is still reported — not swallowed', async () => {
    // Pinned to defVer 2509041522 deliberately: on a server that
    // positively identifies itself as carrying these definitions, a
    // failed recovery call is a known-capable device having a bad
    // moment, and routing is unchanged. On a blank or older defVer a
    // refused ReadCUinvoiceNumber may equally be a server rejecting a
    // command it does not declare, which is a different question and a
    // different answer — see `tests/defVersionCompatibility.test.ts`.
    const post = vi.fn().mockImplementation((path: string, body: string) => {
      const command = commandNameOf([path, body])
      if (command === 'OpenInvoiceWithFreeCustomerData') {
        return Promise.resolve({ data: xmlCommandError(59, 'Wrong client PIN') })
      }
      if (command === 'ReadCUinvoiceNumber') {
        return Promise.resolve({ data: xmlServerError('30', 'ServCannotOpenComPort') })
      }
      return makeSuccessfulPostImpl()(path, body)
    })
    const provider = new RealFiscalizationProvider({
      ...TEST_DEVICE,
      httpClient: makeMockClient(post, makeSettingsGet(EXPECTED_DEF_VERSION))
    })

    const result = await provider.submitInvoice({
      ...SAMPLE_REQUEST,
      buyerPin: 'P051234567Z',
      isRetry: true
    })

    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/Wrong client PIN/)
  })

  it('on a FIRST attempt (isRetry unset), an OpenInvoice rejection does NOT call ReadCUinvoiceNumber — no false recovery on a sale never filed', async () => {
    const post = vi.fn().mockImplementation((path: string, body: string) => {
      const command = commandNameOf([path, body])
      if (command === 'OpenInvoiceWithFreeCustomerData') {
        return Promise.resolve({ data: xmlCommandError(57, 'Conflict in tax group') })
      }
      return makeSuccessfulPostImpl()(path, body)
    })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST) // isRetry omitted — a first attempt

    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/Conflict in tax group/)
    expect(commandSequence(post)).not.toContain('ReadCUinvoiceNumber')
  })

  it('an explicit isRetry:false behaves exactly like a first attempt — no recovery check', async () => {
    const post = vi.fn().mockImplementation((path: string, body: string) => {
      const command = commandNameOf([path, body])
      if (command === 'OpenInvoiceWithFreeCustomerData') {
        return Promise.resolve({ data: xmlCommandError(57, 'Conflict in tax group') })
      }
      return makeSuccessfulPostImpl()(path, body)
    })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice({ ...SAMPLE_REQUEST, isRetry: false })

    expect(result.ok).toBe(false)
    expect(commandSequence(post)).not.toContain('ReadCUinvoiceNumber')
  })

  it('the existing STE1=52 (opened-receipt) auto-retry-once still resolves first, even on a retry — the two recoveries do not interfere', async () => {
    let openCalls = 0
    const post = vi.fn().mockImplementation((path: string, body: string) => {
      if (commandNameOf([path, body]) === 'OpenInvoiceWithFreeCustomerData') {
        openCalls += 1
        if (openCalls === 1) {
          return Promise.resolve({ data: xmlCommandError(0, 'Opened fiscal receipt', 52) })
        }
      }
      return makeSuccessfulPostImpl()(path, body)
    })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice({ ...SAMPLE_REQUEST, isRetry: true })

    expect(result.ok).toBe(true)
    expect(openCalls).toBe(2)
    expect(commandSequence(post)).not.toContain('ReadCUinvoiceNumber')
  })
})

describe('SellPLUfromExtDB payload (VAT class A)', () => {
  it('sends the vendor argument names in order, with blank HS fields when the item carries none', async () => {
    const post = makeSuccessfulPostImpl()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    await provider.submitInvoice(SAMPLE_REQUEST)

    expect(argsOf(bodyFor(post, 'SellPLUfromExtDB'))).toEqual([
      ['NamePLU', 'Bread'],
      ['OptionVATClass', 'A'],
      ['Price', '60'],
      ['MeasureUnit', 'pcs'],
      ['HSCode', ''],
      ['HSName', ''],
      ['VATGrRate', '16.00'],
      ['Quantity', '2']
    ])
  })

  it('populates HSCode/HSName for a class-A item that does carry an HS classification', async () => {
    const post = makeSuccessfulPostImpl()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    await provider.submitInvoice({
      ...SAMPLE_REQUEST,
      items: [
        {
          description: 'Branded Water Bottle',
          quantity: 3,
          unitPrice: 150,
          taxRate: 0.16,
          vatClass: 'A',
          hsCode: '3924.10.00',
          hsName: 'Plastic bottle'
        }
      ]
    })

    const args = Object.fromEntries(argsOf(bodyFor(post, 'SellPLUfromExtDB')))
    expect(args.OptionVATClass).toBe('A')
    expect(args.HSCode).toBe('3924.10.00')
    expect(args.HSName).toBe('Plastic bottle')
    expect(args.VATGrRate).toBe('16.00')
  })

  it('always includes the HSCode/HSName arguments, even blank — never drops the tags', async () => {
    const post = makeSuccessfulPostImpl()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    await provider.submitInvoice(SAMPLE_REQUEST)

    const names = argsOf(bodyFor(post, 'SellPLUfromExtDB')).map(([name]) => name)
    expect(names).toContain('HSCode')
    expect(names).toContain('HSName')
  })

  it('formats VATGrRate as a percentage string within the 5-character limit', async () => {
    const post = makeSuccessfulPostImpl()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    await provider.submitInvoice({
      ...SAMPLE_REQUEST,
      items: [{ description: 'Item', quantity: 1, unitPrice: 10, taxRate: 0.08 }]
    })

    const args = Object.fromEntries(argsOf(bodyFor(post, 'SellPLUfromExtDB')))
    expect(args.VATGrRate).toBe('8.00')
    expect(args.VATGrRate.length).toBeLessThanOrEqual(5)
  })

  it('omits DiscAddP entirely when the line carries no discount', async () => {
    const post = makeSuccessfulPostImpl()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    await provider.submitInvoice(SAMPLE_REQUEST)

    expect(bodyFor(post, 'SellPLUfromExtDB')).not.toContain('DiscAddP')
  })

  it('includes DiscAddP when the line carries a real discount', async () => {
    const post = makeSuccessfulPostImpl()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    await provider.submitInvoice({
      ...SAMPLE_REQUEST,
      items: [{ description: 'Item', quantity: 1, unitPrice: 10, taxRate: 0.16, discAddP: '-10' }]
    })

    const args = Object.fromEntries(argsOf(bodyFor(post, 'SellPLUfromExtDB')))
    expect(args.DiscAddP).toBe('-10')
  })

  it('sanitizes and truncates NamePLU/HSName and clamps MeasureUnit to 3 characters', async () => {
    const post = makeSuccessfulPostImpl()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    await provider.submitInvoice({
      ...SAMPLE_REQUEST,
      items: [
        {
          description: `Fish & Chips ${'X'.repeat(60)}`,
          quantity: 1,
          unitPrice: 10,
          taxRate: 0.16,
          vatClass: 'A',
          measureUnit: 'kilograms',
          hsName: `Prepared & ${'Y'.repeat(40)}`
        }
      ]
    })

    const args = Object.fromEntries(argsOf(bodyFor(post, 'SellPLUfromExtDB')))
    expect(args.NamePLU).toHaveLength(36)
    expect(args.NamePLU).not.toContain('&')
    expect(args.HSName).toHaveLength(20)
    expect(args.MeasureUnit).toBe('kil')
  })

  it('sanitizes HSCode too (symbols stripped, dots preserved) — phase-66 gap fix', async () => {
    const post = makeSuccessfulPostImpl()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    await provider.submitInvoice({
      ...SAMPLE_REQUEST,
      items: [
        {
          description: 'Widget',
          quantity: 1,
          unitPrice: 10,
          taxRate: 0.16,
          vatClass: 'A',
          hsCode: '3924.10.00#invalid'
        }
      ]
    })

    const args = Object.fromEntries(argsOf(bodyFor(post, 'SellPLUfromExtDB')))
    // sanitizeFiscalText's allow-list keeps '.' and letters, strips '#'
    // (leaving "3924.10.00invalid"), then MAX_HS_CODE_LENGTH (10)
    // truncates to the clean HS-code prefix.
    expect(args.HSCode).toBe('3924.10.00')
    expect(args.HSCode).not.toContain('#')
  })

  it('sanitizes MeasureUnit symbols, not just length (phase-66 gap fix)', async () => {
    const post = makeSuccessfulPostImpl()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    await provider.submitInvoice({
      ...SAMPLE_REQUEST,
      items: [
        {
          description: 'Widget',
          quantity: 1,
          unitPrice: 10,
          taxRate: 0.16,
          vatClass: 'A',
          measureUnit: 'p#c'
        }
      ]
    })

    const args = Object.fromEntries(argsOf(bodyFor(post, 'SellPLUfromExtDB')))
    expect(args.MeasureUnit).toBe('pc')
    expect(args.MeasureUnit).not.toContain('#')
  })

  it('cancels the receipt and surfaces the error when a SellPLU call fails', async () => {
    const post = vi.fn().mockImplementation((path: string, body: string) => {
      if (commandNameOf([path, body]) === 'SellPLUfromExtDB') {
        return Promise.resolve({ data: xmlCommandError(62, 'Item amount too large') })
      }
      return makeSuccessfulPostImpl()(path, body)
    })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/Item amount too large/)
    expect(commandSequence(post)).toContain('CancelReceipt')
  })
})

/**
 * `SellPLUfromExtDB` structurally cannot express any VAT class but `A`
 * — its `OptionVATClass` enum has exactly one legal value per the
 * vendor contract. A line with any other `vatClass` routes to
 * `SellPLUfromExtDB_HS` instead, which carries no `OptionVATClass`,
 * `MeasureUnit`, `HSName`, or `VATGrRate` at all — the device derives
 * VAT treatment from `HSCode` alone via its programmed HS table. See
 * `RealFiscalizationProvider.resolveSellCommand`'s `// VERIFY-ON-DEVICE`
 * note: this routing is a strong inference from the argument lists, not
 * a quoted vendor rule.
 */
describe('SellPLUfromExtDB_HS payload (non-A VAT class)', () => {
  it('routes a non-A line to SellPLUfromExtDB_HS with only NamePLU/Price/HSCode/Quantity', async () => {
    const post = makeSuccessfulPostImpl()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    await provider.submitInvoice({
      ...SAMPLE_REQUEST,
      items: [
        {
          description: 'Maize Flour',
          quantity: 3,
          unitPrice: 150,
          taxRate: 0,
          vatClass: 'C',
          hsCode: '1102.20.00',
          hsName: 'Maize flour'
        }
      ]
    })

    expect(commandSequence(post)).toContain('SellPLUfromExtDB_HS')
    expect(commandSequence(post)).not.toContain('SellPLUfromExtDB')
    expect(argsOf(bodyFor(post, 'SellPLUfromExtDB_HS'))).toEqual([
      ['NamePLU', 'Maize Flour'],
      ['Price', '150'],
      ['HSCode', '1102.20.00'],
      ['Quantity', '3']
    ])
  })

  it('never sends OptionVATClass, VATGrRate, HSName, or MeasureUnit', async () => {
    const post = makeSuccessfulPostImpl()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    await provider.submitInvoice({
      ...SAMPLE_REQUEST,
      items: [
        {
          description: 'Exempt Item',
          quantity: 1,
          unitPrice: 100,
          taxRate: 0,
          vatClass: 'E',
          hsCode: '1234.56.78',
          hsName: 'Exempt goods'
        }
      ]
    })

    const names = argsOf(bodyFor(post, 'SellPLUfromExtDB_HS')).map(([name]) => name)
    expect(names).not.toContain('OptionVATClass')
    expect(names).not.toContain('VATGrRate')
    expect(names).not.toContain('HSName')
    expect(names).not.toContain('MeasureUnit')
  })

  it('rejects a non-A item with no HSCode — pre-send validation, finding #8 (phase-65/66)', async () => {
    const post = makeSuccessfulPostImpl()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice({
      ...SAMPLE_REQUEST,
      items: [{ description: 'Item', quantity: 1, unitPrice: 10, taxRate: 0, vatClass: 'B' }]
    })

    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/HS code is required/)
    // Fails fast, before any device round-trip at all — no command sent.
    expect(post).not.toHaveBeenCalled()
  })

  it('sanitizes and truncates NamePLU to 36 characters', async () => {
    const post = makeSuccessfulPostImpl()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    await provider.submitInvoice({
      ...SAMPLE_REQUEST,
      items: [
        {
          description: `Fish & Chips ${'X'.repeat(60)}`,
          quantity: 1,
          unitPrice: 10,
          taxRate: 0,
          vatClass: 'B',
          hsCode: '1102.20.00',
          hsName: 'Fish and chips'
        }
      ]
    })

    const args = Object.fromEntries(argsOf(bodyFor(post, 'SellPLUfromExtDB_HS')))
    expect(args.NamePLU).toHaveLength(36)
    expect(args.NamePLU).not.toContain('&')
  })

  it('omits DiscAddP entirely when the line carries no discount, includes it when it does', async () => {
    const post = makeSuccessfulPostImpl()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    await provider.submitInvoice({
      ...SAMPLE_REQUEST,
      items: [
        {
          description: 'Item',
          quantity: 1,
          unitPrice: 10,
          taxRate: 0,
          vatClass: 'C',
          hsCode: '1102.20.00',
          hsName: 'Item',
          discAddP: '-5'
        }
      ]
    })

    const args = Object.fromEntries(argsOf(bodyFor(post, 'SellPLUfromExtDB_HS')))
    expect(args.DiscAddP).toBe('-5')
  })

  it('cancels the receipt and surfaces the error when a SellPLUfromExtDB_HS call fails', async () => {
    const post = vi.fn().mockImplementation((path: string, body: string) => {
      if (commandNameOf([path, body]) === 'SellPLUfromExtDB_HS') {
        return Promise.resolve({ data: xmlCommandError(64, 'HS code is not valid') })
      }
      return makeSuccessfulPostImpl()(path, body)
    })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice({
      ...SAMPLE_REQUEST,
      items: [
        {
          description: 'Item',
          quantity: 1,
          unitPrice: 10,
          taxRate: 0,
          vatClass: 'D',
          hsCode: '1102.20.00',
          hsName: 'Item'
        }
      ]
    })

    expect(result.ok).toBe(false)
    expect(commandSequence(post)).toContain('CancelReceipt')
  })
})

describe('read-VAT gate (ReadCurrentReceiptInfo)', () => {
  it('passes when the receipt is open and one VAT group carries a non-zero subtotal', async () => {
    const post = makeSuccessfulPostImpl()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(true)
    expect(commandSequence(post)).toContain('CloseReceipt')
  })

  it('sums subtotals across VAT groups', async () => {
    const post = vi.fn().mockImplementation((path: string, body: string) => {
      if (commandNameOf([path, body]) === 'ReadCurrentReceiptInfo') {
        return Promise.resolve({
          data: xmlResponse({
            OptionIsReceiptOpened: '1',
            SubtotalAmountVATGA: '0.00',
            SubtotalAmountVATGD: '45.00'
          })
        })
      }
      return makeSuccessfulPostImpl()(path, body)
    })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(true)
  })

  it('cancels and fails when every VAT-group subtotal is zero', async () => {
    const post = vi.fn().mockImplementation((path: string, body: string) => {
      if (commandNameOf([path, body]) === 'ReadCurrentReceiptInfo') {
        return Promise.resolve({
          data: xmlResponse({
            OptionIsReceiptOpened: '1',
            SubtotalAmountVATGA: '0.00',
            SubtotalAmountVATGB: '0.00'
          })
        })
      }
      return makeSuccessfulPostImpl()(path, body)
    })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/validation failed/i)
    expect(commandSequence(post)).toContain('CancelReceipt')
    expect(commandSequence(post)).not.toContain('CloseReceipt')
  })

  it('cancels and fails when the receipt is not open', async () => {
    const post = vi.fn().mockImplementation((path: string, body: string) => {
      if (commandNameOf([path, body]) === 'ReadCurrentReceiptInfo') {
        return Promise.resolve({
          data: xmlResponse({ OptionIsReceiptOpened: '0', SubtotalAmountVATGA: '219.20' })
        })
      }
      return makeSuccessfulPostImpl()(path, body)
    })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(false)
    expect(commandSequence(post)).toContain('CancelReceipt')
  })
})

describe('CloseReceipt handling', () => {
  it('reads InvoiceNum and QRcode, the vendor response field names', async () => {
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE,
      httpClient: makeMockClient(makeSuccessfulPostImpl())
    })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok && result.data.invoiceNumber).toBe('KRA-0001')
    expect(result.ok && result.data.qrCode).toBe('base64qr')
  })

  /**
   * docs/phase-163, Commit 1 — Step 5's raw per-VAT-group strings are
   * carried through on a normal success, verbatim (no parsing, no
   * defaulting the two groups the mock response never mentions).
   */
  it('carries Step 5\'s raw VAT-group amounts through on success, exactly as returned', async () => {
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE,
      httpClient: makeMockClient(makeSuccessfulPostImpl())
    })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // makeSuccessfulPostImpl's ReadCurrentReceiptInfo only sets GA/GB —
    // C/D/E are absent here too, never defaulted to '0.00'.
    expect(result.data.vatGroups).toEqual({ A: '219.20', B: '0.00' })
  })

  it('reads InvoiceNum/QRcode from Name/Value attribute-style Res children too', async () => {
    const post = vi.fn().mockImplementation((path: string, body: string) => {
      if (commandNameOf([path, body]) === 'CloseReceipt') {
        return Promise.resolve({
          data:
            '<Res Code="0"><Res Name="InvoiceNum" Value="KRA-0009"/><Res Name="QRcode" Value="qr9"/></Res>'
        })
      }
      return makeSuccessfulPostImpl()(path, body)
    })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok && result.data.invoiceNumber).toBe('KRA-0009')
    expect(result.ok && result.data.qrCode).toBe('qr9')
  })

  it('rolls back and fails when CloseReceipt returns no invoice number', async () => {
    const post = vi.fn().mockImplementation((path: string, body: string) => {
      if (commandNameOf([path, body]) === 'CloseReceipt') {
        return Promise.resolve({ data: xmlResponse() })
      }
      return makeSuccessfulPostImpl()(path, body)
    })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/without returning an invoice number/i)
    expect(commandSequence(post)).toContain('CancelReceipt')
  })

  it('rolls back when CloseReceipt itself fails', async () => {
    const post = vi.fn().mockImplementation((path: string, body: string) => {
      if (commandNameOf([path, body]) === 'CloseReceipt') {
        return Promise.resolve({ data: xmlCommandError(60, 'Missing defined item') })
      }
      return makeSuccessfulPostImpl()(path, body)
    })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(false)
    expect(commandSequence(post)).toContain('CancelReceipt')
  })

  it('returns a failed ServiceResult, never throws, when the transport dies mid-flow', async () => {
    const post = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(false)
  })
})

describe('RealFiscalizationProvider.cancelInvoice', () => {
  const SAMPLE_CREDIT_NOTE_DETAILS = {
    companyName: 'Acme Traders Ltd',
    buyerPin: 'P051234567Z',
    headQuarters: 'Nairobi HQ',
    address: '123 Moi Ave',
    postalCodeAndCity: '00100 Nairobi',
    exemptionNum: '',
    relatedInvoiceNum: 'KRA-0001',
    traderSystemInvNum: 'INV-000000099'
  }

  it('issues a contract-valid OpenCreditNoteWithFreeCustomerData when full details are supplied', async () => {
    const post = vi.fn().mockResolvedValue({ data: xmlResponse() })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.cancelInvoice('KRA-0001', SAMPLE_CREDIT_NOTE_DETAILS)

    expect(result.success).toBe(true)
    expect(commandNameOf(post.mock.calls[0])).toBe('OpenCreditNoteWithFreeCustomerData')
    expect(argsOf(post.mock.calls[0][1])).toEqual([
      ['CompanyName', 'Acme Traders Ltd'],
      ['ClientPINnum', 'P051234567Z'],
      ['HeadQuarters', 'Nairobi HQ'],
      ['Address', '123 Moi Ave'],
      ['PostalCodeAndCity', '00100 Nairobi'],
      ['ExemptionNum', ''],
      ['RelatedInvoiceNum', 'KRA-0001'],
      ['TraderSystemInvNum', 'INV-000000099']
    ])
  })

  it('never sends the reserved/InvoiceDebitNoteType hardcoded args', async () => {
    const post = vi.fn().mockResolvedValue({ data: xmlResponse() })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    await provider.cancelInvoice('KRA-0001', SAMPLE_CREDIT_NOTE_DETAILS)

    expect(post.mock.calls[0][1]).not.toContain('reserved')
    expect(post.mock.calls[0][1]).not.toContain('InvoiceDebitNoteType')
  })

  it('reports a manual-credit-note fallback and posts nothing when no details are supplied', async () => {
    const post = vi.fn().mockResolvedValue({ data: xmlCommandError(58, 'Invoice number not found') })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.cancelInvoice('KRA-0001')

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/manual credit note/i)
    expect(post).not.toHaveBeenCalled()
  })

  it('reports a manual-credit-note fallback when the device rejects the call', async () => {
    const post = vi.fn().mockResolvedValue({ data: xmlCommandError(58, 'Invoice number not found') })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.cancelInvoice('KRA-0001', SAMPLE_CREDIT_NOTE_DETAILS)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/manual credit note/i)
  })
})

describe('RealFiscalizationProvider.readCUInvoiceNumber', () => {
  it('sends the contract-valid, argument-free command and extracts CU_InvoiceNumber', async () => {
    const post = vi.fn().mockResolvedValue({
      data: '<Res Code="0"><CU_InvoiceNumber>0000000001234567</CU_InvoiceNumber></Res>'
    })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.readCUInvoiceNumber()

    expect(commandNameOf(post.mock.calls[0])).toBe('ReadCUinvoiceNumber')
    expect(post.mock.calls[0][1]).toBe('<Command Name="ReadCUinvoiceNumber"/>')
    expect(result.success).toBe(true)
    expect(result.data?.cuInvoiceNumber).toBe('0000000001234567')
  })

  it('fails when the response carries no CU_InvoiceNumber', async () => {
    const post = vi.fn().mockResolvedValue({ data: '<Res Code="0"/>' })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.readCUInvoiceNumber()

    expect(result.success).toBe(false)
  })
})

describe('RealFiscalizationProvider.getInvoiceDetails', () => {
  it('reports not configured when no local lookup function is supplied', async () => {
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(vi.fn()) })

    const result = await provider.getInvoiceDetails('KRA-0001')

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/No local invoice lookup/)
  })

  it('returns the local lookup result on a hit', async () => {
    const invoice = {
      invoiceNumber: 'KRA-0001',
      qrCode: 'qr',
      fiscalizedAt: '2026-01-01T00:00:00.000Z'
    }
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE,
      httpClient: makeMockClient(vi.fn()),
      lookupInvoice: () => invoice
    })

    const result = await provider.getInvoiceDetails('KRA-0001')

    expect(result.data).toEqual(invoice)
  })

  it('reports not found when the local lookup misses', async () => {
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE,
      httpClient: makeMockClient(vi.fn()),
      lookupInvoice: () => undefined
    })

    const result = await provider.getInvoiceDetails('KRA-9999')

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found/)
  })
})

describe('provider logging (phase-80)', () => {
  it('a normal sale is quiet by default (debugLogging off) — no [ETIMS] step trace, no warn', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const post = makeSuccessfulPostImpl()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(true)
    expect(log).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    log.mockRestore()
    warn.mockRestore()
  })

  it('with debugLogging on, logs the per-step [ETIMS] progress trace', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const post = makeSuccessfulPostImpl()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post), debugLogging: true })

    await provider.submitInvoice(SAMPLE_REQUEST)

    expect(log.mock.calls.some((call) => String(call[0]).includes('[ETIMS] Step 1/7'))).toBe(true)
    log.mockRestore()
  })

  it('routes the already-opened-receipt recovery through the injected logger, including the sale localId', async () => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    let openCalls = 0
    const post = vi.fn().mockImplementation((path: string, body: string) => {
      if (commandNameOf([path, body]) === 'OpenInvoiceWithFreeCustomerData') {
        openCalls += 1
        if (openCalls === 1) {
          return Promise.resolve({ data: xmlCommandError(0, 'Opened fiscal receipt', 52) })
        }
      }
      return makeSuccessfulPostImpl()(path, body)
    })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post), logger })

    const result = await provider.submitInvoice({ ...SAMPLE_REQUEST, localId: 42 })

    expect(result.ok).toBe(true)
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Sale 42'))
  })

  it('routes the duplicate-filing recovery (ReadCUinvoiceNumber) through the injected logger', async () => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const post = vi.fn().mockImplementation((path: string, body: string) => {
      const command = commandNameOf([path, body])
      if (command === 'OpenInvoiceWithFreeCustomerData') {
        return Promise.resolve({ data: xmlCommandError(39, 'Conflict in tax group') })
      }
      if (command === 'ReadCUinvoiceNumber') {
        return Promise.resolve({ data: '<Res Code="0"><CU_InvoiceNumber>0000000005555555</CU_InvoiceNumber></Res>' })
      }
      return makeSuccessfulPostImpl()(path, body)
    })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post), logger })

    const result = await provider.submitInvoice({ ...SAMPLE_REQUEST, localId: 43, isRetry: true })

    expect(result.ok).toBe(true)
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Sale 43'))
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('0000000005555555'))
  })
})

/**
 * docs/phase-162-1, Test A. `submitInvoice` has no built-in queue — a
 * "retry" is simply a later, separate call with `isRetry: true` and the
 * same `localId` (so `buildTraderSystemInvNum` produces the same
 * `TraderSystemInvNum`). These tests drive three such calls against one
 * shared `post` mock/provider to prove what actually happens when a
 * STE1=59 block persists across a retry and then clears.
 */
describe('TEST A: retry while the device is still blocked, then recovers when the block clears (docs/phase-162-1)', () => {
  /**
   * `OpenInvoiceWithFreeCustomerData` is blocked (STE1=59) on its first
   * two calls, then succeeds. `ReadCUinvoiceNumber` — `verifyAlreadyFiled`'s
   * own probe — hits the SAME block on the one retry that calls it (the
   * realistic pairing for a device-wide condition, not a coincidence).
   */
  function makeBlockedThenClearedPost(): ReturnType<typeof vi.fn> {
    let openInvoiceCalls = 0
    return vi.fn().mockImplementation((path: string, body: string) => {
      const command = commandNameOf([path, body])
      if (command === 'OpenInvoiceWithFreeCustomerData') {
        openInvoiceCalls += 1
        if (openInvoiceCalls <= 2) {
          return Promise.resolve({ data: xmlCommandError(0, 'irrelevant', 59) })
        }
      }
      if (command === 'ReadCUinvoiceNumber' && openInvoiceCalls === 2) {
        return Promise.resolve({ data: xmlCommandError(0, 'irrelevant', 59) })
      }
      return makeSuccessfulPostImpl()(path, body)
    })
  }

  it('under the newer definitions (defVer=2509041522): recovers automatically, exactly one CloseReceipt, one invoice number', async () => {
    const post = makeBlockedThenClearedPost()
    const provider = new RealFiscalizationProvider({
      ...TEST_DEVICE,
      httpClient: makeMockClient(post, makeSettingsGet(EXPECTED_DEF_VERSION))
    })
    const request = { ...SAMPLE_REQUEST, localId: 900 }

    // Attempt 1 — first attempt, not yet a retry.
    const attempt1 = await provider.submitInvoice(request)
    expect(attempt1.ok).toBe(false)
    if (attempt1.ok) return
    expect(attempt1.reason).toBe(DAILY_CLOSURE_BLOCK_REASON)
    expect(attempt1.kind).toBe('technical')
    expect(attempt1.retryable).toBe(true)
    expect(routeFiscalOutcome(attempt1)).toEqual({ status: 'waiting', enqueue: true })

    // Attempt 2 — a queued retry; OpenInvoice AND ReadCUinvoiceNumber both
    // still hit the block. `verifyAlreadyFiled`'s branches
    // (real-etims-provider.ts): `support` resolves to `'available'` for
    // this defVer, so `if (support === 'available' || deviceNeverSawIt)`
    // is true regardless of `deviceNeverSawIt` — the failed recovery read
    // is treated as `'genuine-failure'`, which is NOT one of the two
    // outcomes `submitInvoice`'s retry branch returns early for
    // (`'already-filed'`/`'unverifiable'`), so it falls through to
    // `classifyDeviceFailure(openResult, ...)` — the ORIGINAL OpenInvoice
    // rejection's own `retryable: true`/reason, unchanged.
    const attempt2 = await provider.submitInvoice({ ...request, isRetry: true })
    expect(attempt2.ok).toBe(false)
    if (attempt2.ok) return
    expect(attempt2.reason).toBe(DAILY_CLOSURE_BLOCK_REASON)
    expect(attempt2.kind).toBe('technical')
    expect(attempt2.retryable).toBe(true)
    expect(routeFiscalOutcome(attempt2)).toEqual({ status: 'waiting', enqueue: true })

    // Attempt 3 — block cleared; the full sequence completes.
    const attempt3 = await provider.submitInvoice({ ...request, isRetry: true })
    expect(attempt3.ok).toBe(true)
    if (!attempt3.ok) return
    expect(attempt3.data.invoiceNumber).toBe('KRA-0001')
    expect(routeFiscalOutcome(attempt3)).toEqual({ status: 'fiscalized', enqueue: false })

    expect(commandSequence(post).filter((c) => c === 'CloseReceipt')).toHaveLength(1)
    expect(commandSequence(post).filter((c) => c === 'OpenInvoiceWithFreeCustomerData')).toHaveLength(3)
    expect(commandSequence(post).filter((c) => c === 'ReadCUinvoiceNumber')).toHaveLength(1)
  })

  /**
   * UPDATED (docs/phase-162-2 — builds the carve-out proposed as a
   * FINDING in docs/phase-162-1.md). Before this phase, with a blank/
   * unrecognized defVer, `verifyAlreadyFiled` treated attempt 2's failed
   * `ReadCUinvoiceNumber` probe as `'unverifiable'` regardless of why it
   * failed, discarding the original OpenInvoice rejection's own
   * `retryable: true`/daily-closure reason and landing on `needs_fixing`.
   * The new carve-out in `verifyAlreadyFiled` (checked ahead of the
   * `support`/`deviceNeverSawIt` fail-safe) fires here because BOTH the
   * original `OpenInvoice` failure and the `ReadCUinvoiceNumber` failure
   * carry `code === CODE_DAILY_CLOSURE_BLOCK`, so the outcome is
   * `'genuine-failure'` and falls through to the original rejection's own
   * classification — attempt 2 now stays `'waiting'`, exactly like
   * attempt 1, and recovers automatically once the block clears (attempt
   * 3), with no manual resend needed.
   *
   * CHANGED ASSERTIONS (docs/phase-162-2, listed per the task's rule):
   * attempt2.reason: was `UNVERIFIABLE_RETRY_REASON` -> now
   * `DAILY_CLOSURE_BLOCK_REASON` (this is the behaviour docs/phase-162-1
   * flagged as wrong and this phase fixes); attempt2.kind: was `'system'`
   * -> now `'technical'`; attempt2.retryable: was `false` -> now `true`;
   * routeFiscalOutcome(attempt2): was `{ status: 'needs_fixing', enqueue:
   * false }` -> now `{ status: 'waiting', enqueue: true }`.
   */
  it('under an unrecognized/blank defVer, both blocked: attempt 2 now recovers automatically too (docs/phase-162-2)', async () => {
    const post = makeBlockedThenClearedPost()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })
    const request = { ...SAMPLE_REQUEST, localId: 901 }

    const attempt1 = await provider.submitInvoice(request)
    expect(attempt1.ok).toBe(false)
    if (attempt1.ok) return
    expect(attempt1.retryable).toBe(true)

    const attempt2 = await provider.submitInvoice({ ...request, isRetry: true })
    expect(attempt2.ok).toBe(false)
    if (attempt2.ok) return
    expect(attempt2.reason).toBe(DAILY_CLOSURE_BLOCK_REASON)
    expect(attempt2.kind).toBe('technical')
    expect(attempt2.retryable).toBe(true)
    expect(routeFiscalOutcome(attempt2)).toEqual({ status: 'waiting', enqueue: true })

    // Attempt 3 — block cleared; the device has no record for this
    // TraderSystemInvNum, so the full sequence completes with exactly one
    // CloseReceipt.
    const attempt3 = await provider.submitInvoice({ ...request, isRetry: true })
    expect(attempt3.ok).toBe(true)
    if (!attempt3.ok) return
    expect(attempt3.data.invoiceNumber).toBe('KRA-0001')

    expect(commandSequence(post).filter((c) => c === 'CloseReceipt')).toHaveLength(1)
  })

  /**
   * The task's third scenario: the block clears, but this time the device
   * DOES hold a record for this TraderSystemInvNum (OpenInvoice is
   * rejected for an unrelated reason and ReadCUinvoiceNumber names the CU
   * invoice number) — the pre-existing `if (cuInvoiceNumber) { return {
   * outcome: 'already-filed', cuInvoiceNumber } }` branch, entirely
   * unaffected by the new carve-out (recovery did not fail at all here).
   */
  it('blank defVer, block clears, device ALREADY HAS the sale on file: recovers as already-filed, zero new CloseReceipt calls', async () => {
    let openInvoiceCalls = 0
    const post = vi.fn().mockImplementation((path: string, body: string) => {
      const command = commandNameOf([path, body])
      if (command === 'OpenInvoiceWithFreeCustomerData') {
        openInvoiceCalls += 1
        if (openInvoiceCalls === 1) {
          return Promise.resolve({ data: xmlCommandError(0, 'irrelevant', 59) })
        }
        // Attempt 2 — block cleared, but the device already holds this
        // TraderSystemInvNum (a reply lost on attempt 1's own device-side
        // processing, or an operator resend after the closure ran).
        return Promise.resolve({ data: xmlCommandError(57, 'Conflict in tax group') })
      }
      if (command === 'ReadCUinvoiceNumber') {
        return Promise.resolve({ data: '<Res Code="0"><CU_InvoiceNumber>0000000009999999</CU_InvoiceNumber></Res>' })
      }
      return makeSuccessfulPostImpl()(path, body)
    })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })
    const request = { ...SAMPLE_REQUEST, localId: 902 }

    const attempt1 = await provider.submitInvoice(request)
    expect(attempt1.ok).toBe(false)

    const attempt2 = await provider.submitInvoice({ ...request, isRetry: true })
    expect(attempt2.ok).toBe(true)
    if (!attempt2.ok) return
    expect(attempt2.data.invoiceNumber).toBe('0000000009999999')
    expect(attempt2.data.qrCode).toBe('')

    expect(commandSequence(post)).not.toContain('CloseReceipt')
  })

  /**
   * The carve-out must not widen: OpenInvoice is blocked (STE1=59), but
   * `ReadCUinvoiceNumber` fails with an unrelated server error (Code 63) —
   * only ONE side carries `CODE_DAILY_CLOSURE_BLOCK`, so the carve-out
   * does not fire and the pre-existing blank-defVer fail-safe still
   * applies, exactly as `tests/defVersionCompatibility.test.ts`'s own
   * `'flags when ReadCUinvoiceNumber is refused ...'` test already
   * establishes for a different original error.
   */
  it('blank defVer, OpenInvoice blocked but ReadCUinvoiceNumber fails with Code 63: still unverifiable — the carve-out does not widen', async () => {
    const post = vi.fn().mockImplementation((path: string, body: string) => {
      const command = commandNameOf([path, body])
      if (command === 'OpenInvoiceWithFreeCustomerData') {
        return Promise.resolve({ data: xmlCommandError(0, 'irrelevant', 59) })
      }
      if (command === 'ReadCUinvoiceNumber') {
        return Promise.resolve({ data: xmlServerError('63', 'Invalid POST') })
      }
      return makeSuccessfulPostImpl()(path, body)
    })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice({ ...SAMPLE_REQUEST, isRetry: true })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe(UNVERIFIABLE_RETRY_REASON)
    expect(result.kind).toBe('system')
    expect(result.retryable).toBe(false)
  })

  /**
   * The carve-out must not widen the other way either: OpenInvoice fails
   * with an unrelated error (not the daily-closure block), while
   * `ReadCUinvoiceNumber` happens to be blocked — only the RECOVERY side
   * carries `CODE_DAILY_CLOSURE_BLOCK`, so the carve-out still does not
   * fire (both sides must match).
   */
  it('blank defVer, OpenInvoice fails with another error, ReadCUinvoiceNumber blocked: still unverifiable — the carve-out does not widen', async () => {
    const post = vi.fn().mockImplementation((path: string, body: string) => {
      const command = commandNameOf([path, body])
      if (command === 'OpenInvoiceWithFreeCustomerData') {
        return Promise.resolve({ data: xmlCommandError(57, 'Conflict in tax group') })
      }
      if (command === 'ReadCUinvoiceNumber') {
        return Promise.resolve({ data: xmlCommandError(0, 'irrelevant', 59) })
      }
      return makeSuccessfulPostImpl()(path, body)
    })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice({ ...SAMPLE_REQUEST, isRetry: true })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe(UNVERIFIABLE_RETRY_REASON)
    expect(result.kind).toBe('system')
    expect(result.retryable).toBe(false)
  })
})

/**
 * docs/phase-162-1, Test B. Once `CloseReceipt` has actually succeeded,
 * nothing that runs afterward should be able to turn a filed sale back
 * into `waiting`/`needs_fixing` — `submitInvoice` only ever returns
 * `invoiceNumber` from the block after `closeResult.success` is already
 * confirmed true.
 */
describe('TEST B: nothing after a successful CloseReceipt can mark a filed sale for retry (docs/phase-162-1)', () => {
  /** Fails ReadDateTime only, in the given way; CloseReceipt (and everything else) succeeds normally. */
  function makeReadDateTimeFailingPost(kind: 'daily-closure' | 'other-error' | 'timeout'): ReturnType<typeof vi.fn> {
    const success = makeSuccessfulPostImpl()
    return vi.fn().mockImplementation((path: string, body: string) => {
      if (commandNameOf([path, body]) === 'ReadDateTime') {
        if (kind === 'daily-closure') {
          return Promise.resolve({ data: xmlCommandError(0, 'irrelevant', 59) })
        }
        if (kind === 'other-error') {
          return Promise.resolve({ data: xmlCommandError(64, 'HS code is not valid') })
        }
        return Promise.reject(new Error('ETIMEDOUT'))
      }
      return success(path, body)
    })
  }

  it.each(['daily-closure', 'other-error', 'timeout'] as const)(
    'ReadDateTime failing with %s AFTER a successful CloseReceipt: still ok:true, routes to fiscalized, invoice number intact',
    async (kind) => {
      const post = makeReadDateTimeFailingPost(kind)
      const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

      const result = await provider.submitInvoice(SAMPLE_REQUEST)

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.data.invoiceNumber).toBe('KRA-0001')
      expect(result.data.fiscalizedAtSource).toBe('local-fallback')
      expect(routeFiscalOutcome(result)).toEqual({ status: 'fiscalized', enqueue: false })
      expect(commandSequence(post).filter((c) => c === 'CloseReceipt')).toHaveLength(1)
    }
  )

  /**
   * Resolves docs/phase-162's internal contradiction: its "How it
   * currently works" section said every command "except the best-effort
   * ReadDateTime" goes through `sendCommand`; its own §7/"Observed but not
   * changed" said `checkDeviceResponse` is called for every command
   * "including ReadDateTime". The code settles it in ReadDateTime's
   * favour of the SECOND statement — proven here, not just read: Step 7's
   * call is `this.sendCommand(this.endpoints.readDateTime, 'ReadDateTime',
   * {})`, the identical helper every other step uses, so it inherits
   * `sendCommand`'s own Code-53 ("settings missing") re-handshake-and-
   * retry-once behaviour, which only `sendCommand` implements — a command
   * that "skipped" it could not exhibit this. "Best-effort" describes
   * `submitInvoice` never inspecting `dateTimeResult.success` for a
   * failure branch afterward (see the `it.each` above), not that parsing
   * is skipped.
   */
  it('ReadDateTime goes through sendCommand, proven by its Code-53 re-handshake-and-retry firing exactly as it does for every other command', async () => {
    let readDateTimeCalls = 0
    const post = vi.fn().mockImplementation((path: string, body: string) => {
      if (commandNameOf([path, body]) === 'ReadDateTime') {
        readDateTimeCalls += 1
        if (readDateTimeCalls === 1) {
          return Promise.resolve({ data: xmlServerError('53', 'Client settings not initialized') })
        }
        return Promise.resolve({ data: xmlResponse({ DateTime: '01-01-2026 09:30' }) })
      }
      return makeSuccessfulPostImpl()(path, body)
    })
    const get = vi.fn().mockResolvedValue({ data: '<Res Code="0"/>' })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post, get) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.fiscalizedAtSource).toBe('device')
    expect(readDateTimeCalls).toBe(2)
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('ReadCUnumbers runs once, near the start of the session — never after CloseReceipt, so it cannot be "the thing that runs after the close"', async () => {
    const post = makeSuccessfulPostImpl()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    await provider.submitInvoice(SAMPLE_REQUEST)

    const sequence = commandSequence(post)
    expect(sequence.indexOf('ReadCUnumbers')).toBeGreaterThanOrEqual(0)
    expect(sequence.indexOf('ReadCUnumbers')).toBeLessThan(sequence.indexOf('CloseReceipt'))
    expect(sequence.filter((c) => c === 'ReadCUnumbers')).toHaveLength(1)
  })
})

describe('device session lock (docs/phase-184, commit 1)', () => {
  /** One full sale's commands after the session-level ReadCUnumbers, in order. */
  const ONE_SALE = [
    'ReadStatus',
    'OpenInvoiceWithFreeCustomerData',
    'SellPLUfromExtDB',
    'SellPLUfromExtDB',
    'ReadCurrentReceiptInfo',
    'CloseReceipt',
    'ReadDateTime'
  ]

  /**
   * Wraps the successful post so replies arrive after uneven delays —
   * without the lock, two concurrent sales would interleave their
   * commands under this mock.
   *
   * @returns {ReturnType<typeof vi.fn>}
   */
  function makeUnevenPost(): ReturnType<typeof vi.fn> {
    const success = makeSuccessfulPostImpl()
    let call = 0
    return vi.fn().mockImplementation((path: string, body: string) => {
      const delayMs = 3 - (call++ % 3)
      return new Promise((resolve) => setTimeout(resolve, delayMs)).then(() => success(path, body))
    })
  }

  it('never interleaves two concurrent sales: the second starts only after the first has finished', async () => {
    const post = makeUnevenPost()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const [first, second] = await Promise.all([
      provider.submitInvoice({ ...SAMPLE_REQUEST, localId: 1 }),
      provider.submitInvoice({ ...SAMPLE_REQUEST, localId: 2 })
    ])

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(commandSequence(post)).toEqual(['ReadCUnumbers', ...ONE_SALE, ...ONE_SALE])
    const openBodies = post.mock.calls
      .filter((call) => commandNameOf(call) === 'OpenInvoiceWithFreeCustomerData')
      .map((call) => String(call[1]))
    expect(openBodies[0]).toContain('INV-000000001')
    expect(openBodies[1]).toContain('INV-000000002')
  })

  it('releases the lock when a sale throws, so the next sale still runs', async () => {
    const post = makeSuccessfulPostImpl()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })
    const throwing = provider.submitInvoice({
      ...SAMPLE_REQUEST,
      items: [null as unknown as FiscalInvoiceRequest['items'][number]]
    })
    const next = provider.submitInvoice(SAMPLE_REQUEST)

    await expect(throwing).rejects.toThrow(TypeError)
    const result = await next
    expect(result.ok).toBe(true)
  })

  it('makes the status badge wait: its ReadStatus is sent only after the sale in flight has finished', async () => {
    const post = makeUnevenPost()
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const sale = provider.submitInvoice(SAMPLE_REQUEST)
    const badge = provider.checkConnectivity()
    await Promise.all([sale, badge])

    expect(commandSequence(post)).toEqual(['ReadCUnumbers', ...ONE_SALE, 'ReadStatus'])
  })

  it('makes the quit-time session close wait: clientremove is sent only after the sale in flight has finished', async () => {
    const events: string[] = []
    const success = makeSuccessfulPostImpl()
    const post = vi.fn().mockImplementation((path: string, body: string) => {
      events.push(commandNameOf([path, body]))
      return new Promise((resolve) => setTimeout(resolve, 2)).then(() => success(path, body))
    })
    const get = vi.fn().mockImplementation((url: string) => {
      events.push(String(url).includes('clientremove') ? 'clientremove' : 'settings')
      return Promise.resolve({ data: '<Res Code="0"/>' })
    })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post, get) })

    const sale = provider.submitInvoice(SAMPLE_REQUEST)
    const close = provider.closeServerConnection()
    await Promise.all([sale, close])

    expect(events.indexOf('clientremove')).toBe(events.length - 1)
    expect(events.indexOf('clientremove')).toBeGreaterThan(events.indexOf('ReadDateTime'))
  })
})

describe('STE2 codes and their guards (docs/phase-184, commit 2)', () => {
  /**
   * A post that answers `failing` with `reply` and succeeds otherwise.
   *
   * @param {string} failing command name to fail
   * @param {string} reply response body for that command
   * @returns {ReturnType<typeof vi.fn>}
   */
  function makePostFailing(failing: string, reply: string): ReturnType<typeof vi.fn> {
    const success = makeSuccessfulPostImpl()
    return vi.fn().mockImplementation((path: string, body: string) =>
      commandNameOf([path, body]) === failing ? Promise.resolve({ data: reply }) : success(path, body)
    )
  }

  it('queues a SellPLU refused with STE2 0x32 ("Illegal command") for retry, after cancelling the receipt', async () => {
    const post = makePostFailing('SellPLUfromExtDB', xmlCommandError(0x32, 'FP: OK; Command: Illegal.'))
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('technical')
    expect(result.retryable).toBe(true)
    expect(result.reason).toMatch(/Illegal command/)
    expect(commandSequence(post)).toContain('CancelReceipt')
    expect(commandSequence(post)).not.toContain('CloseReceipt')
    expect(routeFiscalOutcome(result)).toEqual({ status: 'waiting', enqueue: true })
  })

  it('on a RETRY whose OpenInvoice is refused with STE2 0x32, asks ReadCUinvoiceNumber first and never reports the sale as filed', async () => {
    const post = vi.fn().mockImplementation((path: string, body: string) => {
      const command = commandNameOf([path, body])
      if (command === 'OpenInvoiceWithFreeCustomerData') {
        return Promise.resolve({ data: xmlCommandError(0x32, 'Illegal command') })
      }
      if (command === 'ReadCUinvoiceNumber') {
        return Promise.resolve({ data: '<Res Code="0"/>' })
      }
      return makeSuccessfulPostImpl()(path, body)
    })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice({ ...SAMPLE_REQUEST, isRetry: true })

    expect(result.ok).toBe(false)
    expect(!result.ok && result.retryable).toBe(true)
    expect(commandSequence(post)).toContain('ReadCUinvoiceNumber')
    expect(commandSequence(post)).not.toContain('SellPLUfromExtDB')
    expect(commandSequence(post)).not.toContain('CloseReceipt')
  })

  it('never reads a server Code 50 (ClientArgDefMissing) as a retryable "Illegal command"', async () => {
    const post = makePostFailing(
      'OpenInvoiceWithFreeCustomerData',
      '<Res Code="50"><Err Source="Server" Type="ClientArgDefMissing"><Message>Argument definition missing</Message></Err></Res>'
    )
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.retryable).toBe(false)
    expect(result.reason).not.toMatch(/Illegal command/)
    expect(result.reason).toMatch(/Argument definition missing/)
  })

  it('does not treat STE2 0x35 (decimal 53, "Input registers overflow") as a dropped session — no settings() resend, no repeated command', async () => {
    const post = makePostFailing('SellPLUfromExtDB', xmlCommandError(0x35, 'Input registers overflow'))
    const get = vi.fn().mockResolvedValue({ data: '<Res Code="0"/>' })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post, get) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/Input registers overflow/)
    expect(!result.ok && result.retryable).toBe(false)
    expect(get).toHaveBeenCalledTimes(1)
    expect(commandSequence(post).filter((c) => c === 'SellPLUfromExtDB')).toHaveLength(1)
  })
})

describe('the stored reason names the refused step (docs/phase-184, commit 3)', () => {
  it.each([
    ['ReadStatus', 'Refused while checking the device status (ReadStatus).'],
    ['OpenInvoiceWithFreeCustomerData', 'Refused while opening the invoice (OpenInvoiceWithFreeCustomerData).'],
    ['ReadCurrentReceiptInfo', 'Refused while reading the receipt totals (ReadCurrentReceiptInfo).'],
    ['CloseReceipt', 'Refused while closing the invoice (CloseReceipt).']
  ])('a refusal at %s ends the reason with its step and command', async (failing, expectedStep) => {
    const post = vi.fn().mockImplementation((path: string, body: string) =>
      commandNameOf([path, body]) === failing
        ? Promise.resolve({ data: xmlCommandError(57, 'Conflict in tax group') })
        : makeSuccessfulPostImpl()(path, body)
    )
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toBe(
      `Fiscal device error (Code 40, STE2=57): Conflict in tax group. ${expectedStep}`
    )
  })

  it('a failed session handshake ends the reason with the settings step', async () => {
    const get = vi.fn().mockResolvedValue({ data: xmlServerError('30', 'ServSockConnectionFailed') })
    const provider = new RealFiscalizationProvider({
      ...TEST_DEVICE,
      httpClient: makeMockClient(makeSuccessfulPostImpl(), get)
    })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(!result.ok && result.reason).toMatch(/Refused while opening the device session \(settings\)\.$/)
  })

  it('names which line was refused, and the sell command actually sent', async () => {
    let sells = 0
    const post = vi.fn().mockImplementation((path: string, body: string) => {
      if (commandNameOf([path, body]) === 'SellPLUfromExtDB' && ++sells === 2) {
        return Promise.resolve({ data: xmlCommandError(62, 'Item amount too large') })
      }
      return makeSuccessfulPostImpl()(path, body)
    })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(!result.ok && result.reason).toBe(
      'Fiscal device error (Code 40, STE2=62): Item amount too large. Refused while adding item 2 of 2 (SellPLUfromExtDB).'
    )
  })
})
