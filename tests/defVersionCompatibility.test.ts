/**
 * Both-definition-version compatibility (phase-110).
 *
 * The fiscal integration was built and validated against `defVer`
 * `2509041522`. These tests drive the *real* `RealFiscalizationProvider`
 * against a server echoing `2204120945` instead — the older "API Files"
 * SDK's definitions — and assert the two things that actually differ,
 * plus the thing that must not:
 *
 *   1. **The old path never sends `ReadCUinvoiceNumber`**, which those
 *      definitions do not declare, and a retry it cannot verify as
 *      already-filed ends FLAGGED for a person rather than re-filed
 *      (Rule 1 — never file twice).
 *   2. **`Price` fits the older 10-character maximum**, checked
 *      mechanically against `tremol-old-contract.json` — extracted from
 *      the old SDK's own `FP.cs` defs blob by the same
 *      `scripts/extract-tremol-contract.mjs` that produced the newer
 *      `tremol-contract.json`, so neither side is hand-transcribed.
 *   3. **The new path is unchanged**, asserted on the same sequences.
 *
 * VERIFY-AGAINST-REAL-OLD-DEVICE: no device running `2204120945` has ever
 * been reachable (`docs/phase-109.md`), so everything here is a unit test
 * against the vendor's own definitions, not evidence the old path works
 * live.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AxiosInstance } from 'axios'
import {
  RealFiscalizationProvider,
  UNVERIFIABLE_RETRY_REASON,
  MAX_PRICE_LENGTH_OLD_DEFS
} from '../src/main/services/integrations/real-etims-provider.js'
import {
  EXPECTED_DEF_VERSION,
  OLD_DEF_VERSION
} from '../src/main/services/integrations/http-client.js'
import { routeFiscalOutcome } from '../src/main/services/fiscal-routing.js'
import type { FiscalInvoiceRequest } from '../src/main/services/integrations/etims.js'

const TEST_DEVICE = {
  deviceIp: '192.168.1.50',
  devicePort: '8000',
  password: 'test-device-password'
} as const

interface TremolContract {
  defVersion: string
  commandCount: number
  commands: Record<string, { args: Array<{ name: string; maxLen?: number }> }>
}

/** Loads one of the two committed vendor contracts by fixture basename. */
function loadContract(basename: string): TremolContract {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', `${basename}-contract.json`), 'utf8'))
}

const oldContract = loadContract('tremol-old')
const newContract = loadContract('tremol')

/** Reads the `<Command Name="X">` name out of a posted body. */
function commandNameOf(body: string): string {
  return /<Command Name="([^"]+)"/.exec(body)?.[1] ?? ''
}

/** Extracts `<Arg Name Value/>` pairs, in order, from a posted command body. */
function argsOf(body: string): Array<[string, string]> {
  return [...body.matchAll(/<Arg Name="([^"]*)" Value="([^"]*)"\/>/g)].map(([, name, value]) => [
    name,
    value
  ])
}

/** A healthy per-command response, enough to drive `submitInvoice` end to end. */
function healthyResponse(command: string): string {
  switch (command) {
    case 'ReadStatus':
      return '<Res Code="0"><CU_fiscalized>1</CU_fiscalized><Paired_with_TIMS>1</Paired_with_TIMS></Res>'
    case 'ReadCUnumbers':
      return '<Res Code="0"><SerialNumber>CU-0001</SerialNumber><PINnumber>00000000001</PINnumber></Res>'
    case 'ReadCurrentReceiptInfo':
      return '<Res Code="0"><OptionIsReceiptOpened>1</OptionIsReceiptOpened><SubtotalAmountVATGA>219.20</SubtotalAmountVATGA></Res>'
    case 'CloseReceipt':
      return '<Res Code="0"><InvoiceNum>KRA-0001</InvoiceNum><QRcode>base64qr</QRcode></Res>'
    case 'ReadDateTime':
      return '<Res Code="0"><DateTime>01-01-2026 09:30</DateTime></Res>'
    default:
      return '<Res Code="0"/>'
  }
}

/** A device-level business rejection — the wire shape a duplicate would arrive in. */
function deviceRejection(ste2Decimal: number, message: string): string {
  return `<Res Code="40"><Err Source="Device" Type="FPException" STE1="00" STE2="${ste2Decimal.toString(16)}" FPLibErrorCode="00"><Message>${message}</Message></Err></Res>`
}

/** A server-level transport failure — no session opened, the device never saw the command. */
function transportFailure(code: string, message: string): string {
  return `<Res Code="${code}"><Err Source="Server" Type="ServUndefined"><Message>${message}</Message></Err></Res>`
}

/** What a `settings()` GET echoes as its `<defVer>`; omit for the blank a real capture carries. */
function settingsGet(defVer?: string): ReturnType<typeof vi.fn> {
  return vi
    .fn()
    .mockResolvedValue({ data: `<Res Code="0"><settings><defVer>${defVer ?? ''}</defVer></settings></Res>` })
}

/** Builds a provider whose server reports `defVer`, recording every posted body. */
function makeProvider(
  defVer: string | undefined,
  overrides: (command: string) => string | undefined = () => undefined
): { provider: RealFiscalizationProvider; bodies: string[] } {
  const bodies: string[] = []
  const post = vi.fn().mockImplementation((_path: string, body: string) => {
    bodies.push(body)
    const command = commandNameOf(body)
    return Promise.resolve({ data: overrides(command) ?? healthyResponse(command) })
  })
  const client = {
    post,
    get: settingsGet(defVer),
    defaults: { baseURL: 'http://localhost:4444/' }
  } as unknown as AxiosInstance
  return { provider: new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: client }), bodies }
}

const SAMPLE_REQUEST: FiscalInvoiceRequest = {
  clientOrderUuid: '11111111-2222-3333-4444-555555555555',
  localId: 42,
  items: [
    { description: 'Bread', quantity: 2, unitPrice: 60, taxRate: 0.16 },
    { description: 'Milk', quantity: 1, unitPrice: 80, taxRate: 0.16 }
  ],
  total: 219.2,
  taxAmount: 30.2,
  paymentMethod: 'cash'
}

/**
 * The old definitions evaluate as a `defVer` `'mismatch'`, which
 * `getSettings` reports with one deliberate `console.warn`. Silenced so
 * the suite output stays readable; §"the old definitions are recognized"
 * asserts the warning itself.
 */
let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warn.mockRestore()
})

describe('the two committed vendor contracts are the two versions they claim to be', () => {
  it('identifies itself by the defVer the server echoes, and the old set is the smaller one', () => {
    expect(newContract.defVersion).toBe(EXPECTED_DEF_VERSION)
    expect(oldContract.defVersion).toBe(OLD_DEF_VERSION)
    expect(newContract.commandCount).toBe(122)
    expect(oldContract.commandCount).toBe(91)
  })

  it('confirms mechanically that ReadCUinvoiceNumber exists only in the newer definitions', () => {
    expect(newContract.commands.ReadCUinvoiceNumber).toBeDefined()
    expect(oldContract.commands.ReadCUinvoiceNumber).toBeUndefined()
  })

  it('confirms Price is the one argument width the older definitions narrow', () => {
    for (const command of ['SellPLUfromExtDB', 'SellPLUfromExtDB_HS']) {
      const argMaxLen = (contract: TremolContract): number | undefined =>
        contract.commands[command].args.find((a) => a.name === 'Price')?.maxLen
      expect(argMaxLen(newContract)).toBe(15)
      expect(argMaxLen(oldContract)).toBe(MAX_PRICE_LENGTH_OLD_DEFS)
    }
  })
})

describe('OLD defs — the per-sale sequence', () => {
  it('files a sale end to end without ever sending ReadCUinvoiceNumber', async () => {
    const { provider, bodies } = makeProvider(OLD_DEF_VERSION)

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(true)
    expect(result.ok && result.data.invoiceNumber).toBe('KRA-0001')
    expect(bodies.map(commandNameOf)).toEqual([
      'ReadCUnumbers',
      'ReadStatus',
      'OpenInvoiceWithFreeCustomerData',
      'SellPLUfromExtDB',
      'SellPLUfromExtDB',
      'ReadCurrentReceiptInfo',
      'CloseReceipt',
      'ReadDateTime'
    ])
    expect(bodies.map(commandNameOf)).not.toContain('ReadCUinvoiceNumber')
  })

  it('sends only commands and arguments the OLD contract declares, every value within its old maximum', async () => {
    const { provider, bodies } = makeProvider(OLD_DEF_VERSION)

    await provider.submitInvoice({
      ...SAMPLE_REQUEST,
      buyerPin: 'P051234567Z',
      companyName: 'Acme Traders Ltd',
      items: [
        { description: 'Bread', quantity: 2, unitPrice: 60, taxRate: 0.16 },
        {
          description: 'Maize Flour',
          quantity: 1,
          unitPrice: 150,
          taxRate: 0,
          vatClass: 'C',
          hsCode: '1102.20.00',
          hsName: 'Maize flour'
        }
      ]
    })

    const offenses: string[] = []
    for (const body of bodies) {
      const name = commandNameOf(body)
      const command = oldContract.commands[name]
      if (!command) {
        offenses.push(`Command "${name}" does not exist in defVer ${OLD_DEF_VERSION}`)
        continue
      }
      for (const [argName, value] of argsOf(body)) {
        const arg = command.args.find((a) => a.name === argName)
        if (!arg) {
          offenses.push(`"${name}" was sent an arg "${argName}" those definitions don't declare`)
        } else if (arg.maxLen !== undefined && value.length > arg.maxLen) {
          offenses.push(
            `"${name}.${argName}" sent ${value.length} chars ("${value}"), over its old maximum of ${arg.maxLen}`
          )
        }
      }
    }

    expect(offenses).toEqual([])
  })

  it('is recognized as the older definitions rather than reported as an unsupported mismatch', async () => {
    const { provider } = makeProvider(OLD_DEF_VERSION)

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok && result.data.defVerStatus).toBe('mismatch')
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('older protocol definitions'),
      expect.objectContaining({ defVer: OLD_DEF_VERSION })
    )
  })
})

describe('OLD defs — the fail-safe: an unverifiable retry is flagged, never re-filed', () => {
  /** A retry whose `OpenInvoice` the device itself refused — the shape a duplicate arrives in. */
  const rejectOpenInvoice = (command: string): string | undefined =>
    command === 'OpenInvoiceWithFreeCustomerData'
      ? deviceRejection(57, 'Conflict in tax group')
      : undefined

  it('flags the sale for a person instead of resending it', async () => {
    const { provider } = makeProvider(OLD_DEF_VERSION, rejectOpenInvoice)

    const result = await provider.submitInvoice({ ...SAMPLE_REQUEST, isRetry: true })

    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toBe(UNVERIFIABLE_RETRY_REASON)
    expect(!result.ok && result.kind).toBe('system')
    expect(!result.ok && result.retryable).toBe(false)
  })

  it('never asks for ReadCUinvoiceNumber, and never re-files: no SellPLU, no CloseReceipt', async () => {
    const { provider, bodies } = makeProvider(OLD_DEF_VERSION, rejectOpenInvoice)

    await provider.submitInvoice({ ...SAMPLE_REQUEST, isRetry: true })

    const sent = bodies.map(commandNameOf)
    expect(sent).not.toContain('ReadCUinvoiceNumber')
    expect(sent).not.toContain('SellPLUfromExtDB')
    expect(sent).not.toContain('SellPLUfromExtDB_HS')
    expect(sent).not.toContain('CloseReceipt')
  })

  it('routes to needs_fixing and is NEVER enqueued — so no background retry can re-file it', async () => {
    const { provider } = makeProvider(OLD_DEF_VERSION, rejectOpenInvoice)

    const result = await provider.submitInvoice({ ...SAMPLE_REQUEST, isRetry: true })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(routeFiscalOutcome(result)).toEqual({ status: 'needs_fixing', enqueue: false })
  })

  it('explains itself in plain language, naming the check a person has to make', async () => {
    const { provider } = makeProvider(OLD_DEF_VERSION, rejectOpenInvoice)

    const result = await provider.submitInvoice({ ...SAMPLE_REQUEST, isRetry: true })

    const reason = !result.ok ? result.reason : ''
    expect(reason).toMatch(/already filed/i)
    expect(reason).toMatch(/NOT sent a second time/i)
    // The Needs Attention copy rules: no device codes, no protocol jargon.
    expect(reason).not.toMatch(/defVer|ReadCUinvoiceNumber|Code \d|STE\d/)
  })

  it('does NOT flag a FIRST attempt — a sale that never filed still routes as a normal rejection', async () => {
    const { provider } = makeProvider(OLD_DEF_VERSION, rejectOpenInvoice)

    const result = await provider.submitInvoice(SAMPLE_REQUEST) // isRetry omitted

    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/Conflict in tax group/)
    expect(!result.ok && result.kind).toBe('data')
  })

  it('does NOT flag a transport failure on a retry — the device never saw it, so it stays queued', async () => {
    const { provider } = makeProvider(OLD_DEF_VERSION, (command) =>
      command === 'OpenInvoiceWithFreeCustomerData'
        ? transportFailure('30', 'ZFPLabServer cannot reach the fiscal device')
        : undefined
    )

    const result = await provider.submitInvoice({ ...SAMPLE_REQUEST, isRetry: true })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).not.toBe(UNVERIFIABLE_RETRY_REASON)
    expect(result.retryable).toBe(true)
    expect(routeFiscalOutcome(result)).toEqual({ status: 'waiting', enqueue: true })
  })
})

describe('BLANK defVer — the capability probe fails safe', () => {
  /**
   * REWRITTEN (docs/phase-208).
   * OLD: asked ReadCUinvoiceNumber on a blank defVer and flagged the sale when it was refused.
   * NEW: ReadCUinvoiceNumber is never sent, so what it would answer cannot matter; the final
   * refusal on a retry is flagged straight away.
   */
  it('flags a final refusal on a retry without sending ReadCUinvoiceNumber, whatever it would answer', async () => {
    const { provider, bodies } = makeProvider(undefined, (command) => {
      if (command === 'OpenInvoiceWithFreeCustomerData') return deviceRejection(57, 'Conflict in tax group')
      if (command === 'ReadCUinvoiceNumber') return '<Res Code="63"><Err Source="Server"><Message>Invalid POST</Message></Err></Res>'
      return undefined
    })

    const result = await provider.submitInvoice({ ...SAMPLE_REQUEST, isRetry: true })

    expect(bodies.map(commandNameOf)).not.toContain('ReadCUinvoiceNumber')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toBe(UNVERIFIABLE_RETRY_REASON)
    expect(!result.ok && result.retryable).toBe(false)
  })

  /**
   * REWRITTEN (docs/phase-208).
   * OLD: when the device named an invoice number the retry was recovered as filed with that number.
   * NEW: the number is never asked for, so nothing is recovered: the sale is flagged and no
   * CloseReceipt is sent.
   */
  it('does not recover from an invoice number the device would name: the sale is flagged', async () => {
    const { provider, bodies } = makeProvider(undefined, (command) => {
      if (command === 'OpenInvoiceWithFreeCustomerData') return deviceRejection(57, 'Conflict in tax group')
      if (command === 'ReadCUinvoiceNumber')
        return '<Res Code="0"><CU_InvoiceNumber>0000000009999999</CU_InvoiceNumber></Res>'
      return undefined
    })

    const result = await provider.submitInvoice({ ...SAMPLE_REQUEST, isRetry: true })

    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toBe(UNVERIFIABLE_RETRY_REASON)
    const sent = bodies.map(commandNameOf)
    expect(sent).not.toContain('ReadCUinvoiceNumber')
    expect(sent).not.toContain('CloseReceipt')
  })

  it('still treats an explicit not-found as a genuine failure, not a flag', async () => {
    const { provider } = makeProvider(undefined, (command) => {
      if (command === 'OpenInvoiceWithFreeCustomerData') return deviceRejection(59, 'Wrong client PIN')
      if (command === 'ReadCUinvoiceNumber') return '<Res Code="0"/>'
      return undefined
    })

    const result = await provider.submitInvoice({
      ...SAMPLE_REQUEST,
      buyerPin: 'P051234567Z',
      isRetry: true
    })

    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/Wrong client PIN/)
    expect(!result.ok && result.reason).not.toBe(UNVERIFIABLE_RETRY_REASON)
  })
})

describe('NEW defs — regression: the 2509041522 path is unchanged', () => {
  it('posts the same command sequence as it always has', async () => {
    const { provider, bodies } = makeProvider(EXPECTED_DEF_VERSION)

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(true)
    expect(result.ok && result.data.defVerStatus).toBe('match')
    expect(bodies.map(commandNameOf)).toEqual([
      'ReadCUnumbers',
      'ReadStatus',
      'OpenInvoiceWithFreeCustomerData',
      'SellPLUfromExtDB',
      'SellPLUfromExtDB',
      'ReadCurrentReceiptInfo',
      'CloseReceipt',
      'ReadDateTime'
    ])
    expect(warn).not.toHaveBeenCalled()
  })

  it('sends byte-identical SellPLUfromExtDB arguments, in the vendor order', async () => {
    const { provider, bodies } = makeProvider(EXPECTED_DEF_VERSION)

    await provider.submitInvoice(SAMPLE_REQUEST)

    const sell = bodies.find((b) => commandNameOf(b) === 'SellPLUfromExtDB') ?? ''
    expect(argsOf(sell)).toEqual([
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

  /**
   * REWRITTEN (docs/phase-208).
   * OLD: on these definitions a refused retry recovered an already-filed sale through
   * ReadCUinvoiceNumber, with an empty QR and no second filing.
   * NEW: the newer definitions behave like the older ones: ReadCUinvoiceNumber is never sent
   * and a final refusal is flagged, never recorded as filed.
   */
  it('no longer recovers through ReadCUinvoiceNumber: a final refusal on a retry is flagged', async () => {
    const { provider, bodies } = makeProvider(EXPECTED_DEF_VERSION, (command) => {
      if (command === 'OpenInvoiceWithFreeCustomerData') return deviceRejection(57, 'Conflict in tax group')
      if (command === 'ReadCUinvoiceNumber')
        return '<Res Code="0"><CU_InvoiceNumber>0000000009999999</CU_InvoiceNumber></Res>'
      return undefined
    })

    const result = await provider.submitInvoice({ ...SAMPLE_REQUEST, isRetry: true })

    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toBe(UNVERIFIABLE_RETRY_REASON)
    const sent = bodies.map(commandNameOf)
    expect(sent).not.toContain('ReadCUinvoiceNumber')
    expect(sent).not.toContain('SellPLUfromExtDB')
    expect(sent).not.toContain('CloseReceipt')
  })

  it('never produces the unverifiable flag — that outcome cannot be reached on these definitions', async () => {
    for (const recoveryResponse of [
      transportFailure('30', 'ZFPLabServer cannot reach the fiscal device'),
      '<Res Code="63"><Err Source="Server"><Message>Invalid POST</Message></Err></Res>'
    ]) {
      const { provider } = makeProvider(EXPECTED_DEF_VERSION, (command) => {
        if (command === 'OpenInvoiceWithFreeCustomerData') return deviceRejection(59, 'Wrong client PIN')
        if (command === 'ReadCUinvoiceNumber') return recoveryResponse
        return undefined
      })

      const result = await provider.submitInvoice({
        ...SAMPLE_REQUEST,
        buyerPin: 'P051234567Z',
        isRetry: true
      })

      expect(!result.ok && result.reason).toMatch(/Wrong client PIN/)
    }
  })
})

describe('Price fits whichever maximum the connected definitions impose', () => {
  /** Posts one line item at `unitPrice` and returns the `Price` argument actually sent. */
  async function sentPrice(defVer: string | undefined, unitPrice: number): Promise<string> {
    const { provider, bodies } = makeProvider(defVer)
    await provider.submitInvoice({
      ...SAMPLE_REQUEST,
      items: [{ description: 'Item', quantity: 1, unitPrice, taxRate: 0.16 }]
    })
    const sell = bodies.find((b) => commandNameOf(b) === 'SellPLUfromExtDB') ?? ''
    return argsOf(sell).find(([name]) => name === 'Price')?.[1] ?? ''
  }

  it.each([60, 80, 150, 12.5, 19.99, 0, 100])(
    'sends an ordinary price %s identically on both versions',
    async (unitPrice) => {
      const onOld = await sentPrice(OLD_DEF_VERSION, unitPrice)
      const onNew = await sentPrice(EXPECTED_DEF_VERSION, unitPrice)
      expect(onOld).toBe(String(unitPrice))
      expect(onNew).toBe(String(unitPrice))
    }
  )

  it('reduces a price that overflows the old 10-character maximum, keeping whole units intact', async () => {
    const onOld = await sentPrice(OLD_DEF_VERSION, 1234567.891)

    expect(onOld).toBe('1234567.89')
    expect(onOld.length).toBeLessThanOrEqual(MAX_PRICE_LENGTH_OLD_DEFS)
  })

  it('leaves that same price at full precision on the newer definitions', async () => {
    const onNew = await sentPrice(EXPECTED_DEF_VERSION, 1234567.891)

    expect(onNew).toBe('1234567.891')
  })

  it('strips binary-float artifacts on both, which the raw String() form never fit under either', async () => {
    const artifact = 0.1 + 0.2 // 0.30000000000000004 — 19 characters as a string

    expect(String(artifact).length).toBeGreaterThan(15)
    expect(await sentPrice(OLD_DEF_VERSION, artifact)).toBe('0.3')
    expect(await sentPrice(EXPECTED_DEF_VERSION, artifact)).toBe('0.3')
  })
})
