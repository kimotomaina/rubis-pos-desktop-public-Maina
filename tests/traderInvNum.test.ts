/**
 * The trader invoice number is stored where the provider sends it
 * (docs/phase-198): recorded before the OpenInvoice send, with the value the
 * device is given, and the posted body is byte-for-byte what it was before this
 * phase.
 */

import { describe, it, expect, vi } from 'vitest'
import type { AxiosInstance } from 'axios'
import { RealFiscalizationProvider } from '../src/main/services/integrations/real-etims-provider.js'
import { MockFiscalizationProvider } from '../src/main/services/integrations/mock-etims-provider.js'
import { freshDb, seedSale } from './helpers/slipOrders.js'
import type { FiscalInvoiceRequest } from '../src/main/services/integrations/etims.js'

const OPEN = 'OpenInvoiceWithFreeCustomerData'
const DEVICE = { deviceIp: '192.168.1.50', devicePort: '8000', password: 'pw' } as const

/**
 * The body the provider posted for OpenInvoice BEFORE phase 198, captured from the
 * code as it stood (seven arguments, all blank but the trader number). Written out
 * rather than built from the provider, so a change to the posted bytes fails here.
 */
const baselineBody = (traderInvNum: string): string =>
  '<Command Name="OpenInvoiceWithFreeCustomerData"><Args>' +
  '<Arg Name="CompanyName" Value=""/><Arg Name="ClientPINnum" Value=""/><Arg Name="HeadQuarters" Value=""/>' +
  '<Arg Name="Address" Value=""/><Arg Name="PostalCodeAndCity" Value=""/><Arg Name="ExemptionNum" Value=""/>' +
  `<Arg Name="TraderSystemInvNum" Value="${traderInvNum}"/></Args></Command>`

const commandNameOf = (body: string): string => /<Command Name="([^"]+)"/.exec(body)?.[1] ?? ''

function xml(fields: Record<string, string> = {}): string {
  return `<Res Code="0">${Object.entries(fields).map(([k, v]) => `<${k}>${v}</${k}>`).join('')}</Res>`
}

const OPENED_RECEIPT =
  '<Res Code="40"><Err Source="Device" Type="FPException" STE1="34" STE2="0" FPLibErrorCode="00"><Message>Opened fiscal receipt</Message></Err></Res>'

interface Harness {
  provider: RealFiscalizationProvider
  /** Every posted [path, body], in order, with the recorder's calls interleaved as `recorder:<value>`. */
  events: string[]
  posts: Array<[string, string]>
  recorder: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
}

function harness(options: { failFirstOpen?: boolean; recorderThrows?: boolean; noRecorder?: boolean } = {}): Harness {
  const events: string[] = []
  const posts: Array<[string, string]> = []
  let opens = 0
  const post = vi.fn().mockImplementation((path: string, body: string) => {
    posts.push([path, body])
    const name = commandNameOf(body)
    if (name === OPEN) {
      events.push('post:open')
      opens++
      if (options.failFirstOpen && opens === 1) return Promise.resolve({ data: OPENED_RECEIPT })
    }
    switch (name) {
      case 'ReadStatus':
        return Promise.resolve({ data: xml({ CU_fiscalized: '1', Paired_with_TIMS: '1' }) })
      case 'ReadCurrentReceiptInfo':
        return Promise.resolve({
          data: xml({ OptionIsReceiptOpened: '1', SalesNumber: '2', SubtotalAmountVATGA: '120.00', SubtotalAmountVATGB: '0.00' })
        })
      case 'CloseReceipt':
        return Promise.resolve({ data: xml({ InvoiceNum: 'KRA-0001', QRcode: 'https://example.invalid/q' }) })
      case 'ReadDateTime':
        return Promise.resolve({ data: xml({ DateTime: '01-01-2026 09:30' }) })
      case 'ReadCUnumbers':
        return Promise.resolve({ data: xml({ SerialNumber: 'S1', PINnumber: 'P1' }) })
      default:
        return Promise.resolve({ data: xml() })
    }
  })
  const client = {
    post,
    get: vi.fn().mockResolvedValue({ data: '<Res Code="0"><settings><defVer></defVer></settings></Res>' }),
    defaults: { baseURL: 'http://localhost:4444/' }
  } as unknown as AxiosInstance
  const recorder = vi.fn().mockImplementation((_id: number, value: string) => {
    events.push(`recorder:${value}`)
    if (options.recorderThrows) throw new Error('disk is full')
  })
  const warn = vi.fn()
  const provider = new RealFiscalizationProvider({
    ...DEVICE,
    httpClient: client,
    recordTraderInvNum: options.noRecorder ? undefined : recorder,
    logger: { log: vi.fn(), warn, error: vi.fn() } as never
  })
  return { provider, events, posts, recorder, warn }
}

const request = (localId: number | undefined): FiscalInvoiceRequest =>
  ({
    clientOrderUuid: '11111111-2222-3333-4444-555555555555',
    localId,
    items: [{ description: 'Bread', quantity: 2, unitPrice: 60, taxRate: 0.16 }],
    total: 120,
    taxAmount: 16.55,
    paymentMethod: 'cash',
    amountTendered: 150
  }) as FiscalInvoiceRequest

const opens = (h: Harness): Array<[string, string]> => h.posts.filter(([, body]) => commandNameOf(body) === OPEN)

describe('the OpenInvoice body is unchanged', () => {
  it.each([
    [1, 'INV-000000001'],
    [42, 'INV-000000042'],
    [123456789, 'INV-123456789']
  ])('local id %d posts exactly the body the old code posted', async (localId, traderNum) => {
    const h = harness()

    const result = await h.provider.submitInvoice(request(localId))

    expect(result.ok).toBe(true)
    expect(opens(h)).toHaveLength(1)
    expect(opens(h)[0][1]).toBe(baselineBody(traderNum))
  })

  it.each([
    [1, 'INV-000000001'],
    [42, 'INV-000000042'],
    [123456789, 'INV-123456789']
  ])('local id %d: the retry after a rolled-back open receipt posts the same bytes as the first send', async (localId, traderNum) => {
    const h = harness({ failFirstOpen: true })

    await h.provider.submitInvoice(request(localId))

    const sent = opens(h)
    expect(sent).toHaveLength(2)
    expect(sent[0][1]).toBe(baselineBody(traderNum))
    expect(sent[1][1]).toBe(sent[0][1])
    expect(sent[1][0]).toBe(sent[0][0])
  })

  it('a request with no local id still posts the trader number built from its uuid', async () => {
    const h = harness()

    await h.provider.submitInvoice(request(undefined))

    expect(opens(h)[0][1]).toBe(baselineBody('111111112222333'))
  })
})

describe('the recorder', () => {
  it.each([1, 42, 123456789])('is given, for local id %d, the value that was posted', async (localId) => {
    const h = harness()

    await h.provider.submitInvoice(request(localId))

    const posted = /Name="TraderSystemInvNum" Value="([^"]*)"/.exec(opens(h)[0][1])?.[1]
    expect(h.recorder).toHaveBeenCalledTimes(1)
    expect(h.recorder).toHaveBeenCalledWith(localId, posted)
  })

  it('runs before the OpenInvoice send', async () => {
    const h = harness()

    await h.provider.submitInvoice(request(42))

    expect(h.events.indexOf('recorder:INV-000000042')).toBeGreaterThanOrEqual(0)
    expect(h.events.indexOf('recorder:INV-000000042')).toBeLessThan(h.events.indexOf('post:open'))
  })

  it('is called once with one value when the open is retried, so the retry writes nothing new', async () => {
    const h = harness({ failFirstOpen: true })

    await h.provider.submitInvoice(request(42))

    expect(h.events.filter((e) => e.startsWith('recorder:'))).toEqual(['recorder:INV-000000042'])
    expect(h.events.filter((e) => e === 'post:open')).toHaveLength(2)
  })

  it('never stops or alters the device call when it throws; the failure is logged at warn', async () => {
    const h = harness({ recorderThrows: true })

    const result = await h.provider.submitInvoice(request(42))

    expect(result.ok).toBe(true)
    expect(opens(h)[0][1]).toBe(baselineBody('INV-000000042'))
    expect(h.warn).toHaveBeenCalledTimes(1)
    expect(String(h.warn.mock.calls[0][0])).toContain('could not store the trader invoice number')
  })

  it('is not called for a request with no local id, which has no order row to hold it', async () => {
    const h = harness()

    await h.provider.submitInvoice(request(undefined))

    expect(h.recorder).not.toHaveBeenCalled()
  })

  it('is optional: a provider built without one sends as before', async () => {
    const h = harness({ noRecorder: true })

    const result = await h.provider.submitInvoice(request(42))

    expect(result.ok).toBe(true)
    expect(opens(h)[0][1]).toBe(baselineBody('INV-000000042'))
  })

  it('is not called when the device is not set up, because nothing is sent', async () => {
    const recorder = vi.fn()
    const provider = new RealFiscalizationProvider({ recordTraderInvNum: recorder })

    await provider.submitInvoice(request(42))

    expect(recorder).not.toHaveBeenCalled()
  })
})

describe('the mock provider records the same value as the real one', () => {
  it.each([1, 42, 123456789])('for local id %d', async (localId) => {
    const real = harness()
    await real.provider.submitInvoice(request(localId))
    const mockRecorder = vi.fn()
    const mock = new MockFiscalizationProvider(0, { recordTraderInvNum: mockRecorder })

    await mock.submitInvoice(request(localId))

    expect(mockRecorder).toHaveBeenCalledWith(...(real.recorder.mock.calls[0] as [number, string]))
  })
})

describe('fiscal_trader_inv_num', () => {
  it('stores the first value and keeps it, whatever is recorded later', () => {
    const db = freshDb()
    const id = seedSale(db).localId

    db.recordTraderInvNum(id, 'INV-000000042')
    db.recordTraderInvNum(id, 'SOMETHING-ELSE')

    expect(db.getOrder(id)?.fiscal_trader_inv_num).toBe('INV-000000042')
  })

  it('is empty for an order that was never sent', () => {
    const db = freshDb()
    const id = seedSale(db).localId

    expect(db.getOrder(id)?.fiscal_trader_inv_num ?? null).toBeNull()
  })

  it('is untouched when the sale is filed: setOrderFiscalInfo never writes it', () => {
    const db = freshDb()
    const id = seedSale(db).localId
    db.recordTraderInvNum(id, 'INV-000000042')

    db.setOrderFiscalInfo(id, '0123456789012345678', 'https://example.invalid/q')

    expect(db.getOrder(id)?.fiscal_trader_inv_num).toBe('INV-000000042')
    expect(db.getOrder(id)?.fiscal_invoice_number).toBe('0123456789012345678')
  })
})
