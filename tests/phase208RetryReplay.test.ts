/**
 * docs/phase-208: a retry is never read as proof of filing, and a CloseReceipt number is guarded.
 *
 * The replay half runs the sequence the server log recorded on 2026-10-03 (docs/phase-206.md
 * section 1b): `OpenInvoiceWithFreeCustomerData` refused twice with the device's own frames
 * `06 96 30 32 39 34 0A` and `06 98 30 32 39 3A 0A` (STE1 `30`, STE2 `32`, "Illegal command"),
 * then `ReadCUinvoiceNumber` answering `;0110605040000000000;`.
 *
 * The frame bytes and the reply are real. The XML envelope around them is the shape recorded in
 * docs/phase-183.md and tests/fiscalDuplicatePrint.test.ts; the app's own copy of the envelope was
 * never captured. Inference.
 */

import { describe, it, expect, vi } from 'vitest'
import type { AxiosInstance } from 'axios'
import {
  RealFiscalizationProvider,
  UNVERIFIABLE_RETRY_REASON,
  isAcceptableCuInvoiceNumber
} from '../src/main/services/integrations/real-etims-provider.js'
import { routeFiscalOutcome } from '../src/main/services/fiscal-routing.js'
import type { FiscalInvoiceRequest } from '../src/main/services/integrations/etims.js'

const TEST_DEVICE = {
  deviceIp: '192.168.1.50',
  devicePort: '8000',
  password: 'test-device-password'
} as const

/** The device's refusals, as recorded: STE2 `0x32`, the frame bytes inside the message. */
const ILLEGAL_FIRST =
  '<Res Code="40"><Err Source="Device" Type="FPException" STE1="30" STE2="32" FPLibErrorCode="00"><Message>FP: OK; Command: Illegal. FP: 06 96 30 32 39 34 0A</Message></Err></Res>'
const ILLEGAL_SECOND =
  '<Res Code="40"><Err Source="Device" Type="FPException" STE1="30" STE2="32" FPLibErrorCode="00"><Message>FP: OK; Command: Illegal. FP: 06 98 30 32 39 3A 0A</Message></Err></Res>'

/** What `ReadCUinvoiceNumber` answered after those refusals: `;0110605040000000000;`, the zero counter. */
const READ_CU_ZERO =
  '<Res Code="0"><Res Name="Option" Value="I" Type="OptionHardcoded"/><Res Name="CU_InvoiceNumber" Value="0110605040000000000" Type="Text"/></Res>'

/** A refusal the device calls final: the plain-text rejection shape of every other test in this suite. */
const FINAL_REFUSAL =
  '<Res Code="40"><Err Source="Device" Type="FPException" STE1="00" STE2="39" FPLibErrorCode="00"><Message>Conflict in tax group</Message></Err></Res>'

const SAMPLE_REQUEST: FiscalInvoiceRequest = {
  clientOrderUuid: 'c2770b2d-e10d-4ca7-9900-8b4e304600b3',
  localId: 1,
  items: [{ description: 'test', quantity: 1, unitPrice: 1, taxRate: 0.16 }],
  total: 1,
  taxAmount: 0.14,
  paymentMethod: 'cash',
  amountTendered: 1
}

/** Reads the command name out of a posted body. */
function commandNameOf(body: string): string {
  return /<Command Name="([^"]+)"/.exec(body)?.[1] ?? ''
}

/** A healthy reply per command, with `overrides` replacing individual commands. */
function replyFor(command: string, overrides: Record<string, string>): string {
  if (overrides[command]) return overrides[command]
  switch (command) {
    case 'ReadStatus':
      return '<Res Code="0"><CU_fiscalized>1</CU_fiscalized><Paired_with_TIMS>1</Paired_with_TIMS></Res>'
    case 'ReadCUnumbers':
      return '<Res Code="0"><SerialNumber>KRAMW011202207060504</SerialNumber><PINnumber>P000593549A</PINnumber></Res>'
    case 'ReadCurrentReceiptInfo':
      return '<Res Code="0"><OptionIsReceiptOpened>1</OptionIsReceiptOpened><SubtotalAmountVATGA>1.00</SubtotalAmountVATGA></Res>'
    case 'ReadDateTime':
      return '<Res Code="0"><DateTime>03-10-2026 00:37</DateTime></Res>'
    default:
      return '<Res Code="0"/>'
  }
}

/**
 * Builds a provider over a scripted device. `perOpen` answers the nth `OpenInvoice`; every other
 * command answers from `overrides` or the healthy defaults.
 */
function makeProvider(
  overrides: Record<string, string>,
  perOpen: string[] = [],
  logger?: { log: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> }
): { provider: RealFiscalizationProvider; sent: string[] } {
  const sent: string[] = []
  let opens = 0
  const post = vi.fn().mockImplementation((_path: string, body: string) => {
    const command = commandNameOf(body)
    sent.push(command)
    if (command === 'OpenInvoiceWithFreeCustomerData' && perOpen[opens] !== undefined) {
      return Promise.resolve({ data: perOpen[opens++] })
    }
    return Promise.resolve({ data: replyFor(command, overrides) })
  })
  const client = {
    post,
    get: vi.fn().mockResolvedValue({ data: '<Res Code="0"/>' }),
    defaults: { baseURL: 'http://localhost:4444/' }
  } as unknown as AxiosInstance
  return { provider: new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: client, logger }), sent }
}

/** Commands that would file, cancel or recover a sale: none may follow a refused retry. */
const NEVER_ON_A_REFUSED_RETRY = [
  'ReadCUinvoiceNumber',
  'SellPLUfromExtDB',
  'SellPLUfromExtDB_HS',
  'CloseReceipt'
]

describe('replay of the recorded STE2 0x32 refusals (docs/phase-206)', () => {
  it('a first attempt and its retry, both refused 0x32: the sale keeps waiting and ReadCUinvoiceNumber is never sent', async () => {
    const { provider, sent } = makeProvider({ ReadCUinvoiceNumber: READ_CU_ZERO }, [ILLEGAL_FIRST, ILLEGAL_SECOND])

    const first = await provider.submitInvoice(SAMPLE_REQUEST)
    const retry = await provider.submitInvoice({ ...SAMPLE_REQUEST, isRetry: true })

    expect(first.ok).toBe(false)
    expect(!first.ok && first.retryable).toBe(true)
    expect(retry.ok).toBe(false)
    if (retry.ok) return
    expect(retry.retryable).toBe(true)
    expect(retry.reason).not.toBe(UNVERIFIABLE_RETRY_REASON)
    expect(routeFiscalOutcome(retry)).toEqual({ status: 'waiting', enqueue: true })
    for (const command of NEVER_ON_A_REFUSED_RETRY) expect(sent).not.toContain(command)
    expect(sent.filter((c) => c === 'OpenInvoiceWithFreeCustomerData')).toHaveLength(2)
    expect(sent[sent.length - 1]).toBe('OpenInvoiceWithFreeCustomerData')
  })

  it('nothing is recorded as filed: the retry returns no invoice number, so the zero counter cannot reach an order', async () => {
    const { provider } = makeProvider({ ReadCUinvoiceNumber: READ_CU_ZERO }, [ILLEGAL_SECOND])

    const retry = await provider.submitInvoice({ ...SAMPLE_REQUEST, isRetry: true })

    expect(retry.ok).toBe(false)
    expect(JSON.stringify(retry)).not.toContain('0110605040000000000')
  })
})

describe('a retry refused as final (docs/phase-208)', () => {
  it('is flagged needs_fixing with the phase 111 message, is never enqueued, and sends nothing after OpenInvoice', async () => {
    const { provider, sent } = makeProvider({ ReadCUinvoiceNumber: READ_CU_ZERO }, [FINAL_REFUSAL])

    const retry = await provider.submitInvoice({ ...SAMPLE_REQUEST, isRetry: true })

    expect(retry.ok).toBe(false)
    if (retry.ok) return
    expect(retry.reason).toBe(UNVERIFIABLE_RETRY_REASON)
    expect(retry.kind).toBe('system')
    expect(retry.retryable).toBe(false)
    expect(routeFiscalOutcome(retry)).toEqual({ status: 'needs_fixing', enqueue: false })
    for (const command of NEVER_ON_A_REFUSED_RETRY) expect(sent).not.toContain(command)
    expect(sent[sent.length - 1]).toBe('OpenInvoiceWithFreeCustomerData')
  })

  it('a FIRST attempt refused the same way keeps its own classification, not the retry message', async () => {
    const { provider } = makeProvider({}, [FINAL_REFUSAL])

    const first = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(first.ok).toBe(false)
    expect(!first.ok && first.reason).toMatch(/Conflict in tax group/)
    expect(!first.ok && first.reason).not.toBe(UNVERIFIABLE_RETRY_REASON)
  })
})

describe('guard B: the CU invoice number from CloseReceipt (docs/phase-208)', () => {
  it.each([
    ['0110605040001000809', true],
    ['KRA-0001', true],
    // A string with a letter is ACCEPTED on purpose. By the time CloseReceipt answers, the device has
    // filed the sale; refusing a number it really issued would record a filed sale as not filed and
    // invite a second filing. The only wrong shape seen from the device is the zero counter.
    ['01106050400010008A9', true],
    ['0110605040000000000', false],
    ['000000000', false],
    ['', false]
  ])('isAcceptableCuInvoiceNumber(%j) is %s', (value, expected) => {
    expect(isAcceptableCuInvoiceNumber(value)).toBe(expected)
  })

  /** A CloseReceipt reply with `invoiceNum` and, when given, `qr`. */
  const closeReply = (invoiceNum: string, qr?: string): string =>
    `<Res Code="0"><InvoiceNum>${invoiceNum}</InvoiceNum>${qr ? `<QRcode>${qr}</QRcode>` : ''}</Res>`

  it('a zero-counter number from CloseReceipt is refused: flagged, never enqueued, nothing recorded', async () => {
    const { provider } = makeProvider({ CloseReceipt: closeReply('0110605040000000000', 'qr') })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe(UNVERIFIABLE_RETRY_REASON)
    expect(result.retryable).toBe(false)
    expect(routeFiscalOutcome(result)).toEqual({ status: 'needs_fixing', enqueue: false })
  })

  // An empty number never reaches guard B: the provider's earlier "no InvoiceNum" check refuses it with its own message.
  it('an empty number from CloseReceipt is refused, not retryable, never enqueued', async () => {
    const { provider } = makeProvider({ CloseReceipt: closeReply('', 'qr') })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.retryable).toBe(false)
    expect(routeFiscalOutcome(result).enqueue).toBe(false)
  })

  it('the number the device last issued (…1000809) is accepted and returned unchanged', async () => {
    const { provider } = makeProvider({ CloseReceipt: closeReply('0110605040001000809', 'qr') })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(true)
    expect(result.ok && result.data.invoiceNumber).toBe('0110605040001000809')
  })
})

describe('a filed sale with no QR code (docs/phase-208)', () => {
  it('is still fiscalized, with an empty QR, and warns through the logger with the sale id', async () => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const { provider } = makeProvider(
      { CloseReceipt: '<Res Code="0"><InvoiceNum>0110605040001000810</InvoiceNum></Res>' },
      [],
      logger
    )

    const result = await provider.submitInvoice({ ...SAMPLE_REQUEST, localId: 77 })

    expect(result.ok).toBe(true)
    expect(result.ok && result.data.invoiceNumber).toBe('0110605040001000810')
    expect(result.ok && result.data.qrCode).toBe('')
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Sale 77'))
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no QR code'))
  })

  it('does not warn when the QR is present', async () => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const { provider } = makeProvider(
      { CloseReceipt: '<Res Code="0"><InvoiceNum>0110605040001000810</InvoiceNum><QRcode>base64qr</QRcode></Res>' },
      [],
      logger
    )

    const result = await provider.submitInvoice({ ...SAMPLE_REQUEST, localId: 78 })

    expect(result.ok && result.data.qrCode).toBe('base64qr')
    expect(logger.warn).not.toHaveBeenCalled()
  })
})
