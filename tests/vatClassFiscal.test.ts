/**
 * Per-item VAT class through the real checkout and the real fiscal
 * provider (docs/phase-194, commit 1): the wire for each class, the
 * class-A golden, the group gate before `CloseReceipt`, and the checkout
 * gate. The device is a recording mock.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { shouldRefuseCheckoutForDiscount } from '../src/main/lib/requestHasDiscount.js'
import type { FiscalInvoiceRequest } from '../src/main/services/integrations/etims.js'
import {
  GOLDEN_SALES,
  commandName,
  makeCheckoutHarness,
  makeRecordingProvider,
  sellCash,
  type DeviceGroups
} from './helpers/vatClassWire.js'

interface Golden {
  commands: string[]
  bodies: string[]
  request: unknown
}
const GOLDEN = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/vat-class-a-golden.json'), 'utf8')
) as Record<string, Golden>

/** The `§5` WIRE SELL line of docs/phase-194.md, character for character. */
const SECTION_5_WIRE_SELL =
  '<Command Name="SellPLUfromExtDB"><Args><Arg Name="NamePLU" Value="Maize"/><Arg Name="OptionVATClass" Value="A"/><Arg Name="Price" Value="1"/><Arg Name="MeasureUnit" Value="pcs"/><Arg Name="HSCode" Value=""/><Arg Name="HSName" Value=""/><Arg Name="VATGrRate" Value="16.00"/><Arg Name="Quantity" Value="1"/></Args></Command>'

const argsOf = (body: string): Array<[string, string]> =>
  [...body.matchAll(/<Arg Name="([^"]*)" Value="([^"]*)"\/>/g)].map(([, name, value]) => [name, value])

const HS = { hsCode: '0013.12.02', hsName: 'Maize' }

function request(items: FiscalInvoiceRequest['items']): FiscalInvoiceRequest {
  return {
    clientOrderUuid: 'u-1',
    localId: 1,
    items,
    total: items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0),
    taxAmount: 0
  }
}

function line(vatClass: string | undefined, extra: Record<string, string> = {}): FiscalInvoiceRequest['items'][number] {
  return { description: 'Maize', quantity: 1, unitPrice: 1, taxRate: 0.16, vatClass, ...extra }
}

describe('class A is byte-for-byte what it was (docs/phase-194 section 5 golden)', () => {
  it('reproduces the section 5 WIRE SELL line through runCheckout', async () => {
    const h = makeCheckoutHarness({ A: '1.00' })
    await sellCash(h, GOLDEN_SALES[0].items, 1)
    const sell = h.rec.sent.find((body) => commandName(body).startsWith('SellPLU'))
    expect(sell).toBe(SECTION_5_WIRE_SELL)
  })

  it.each(GOLDEN_SALES.map((sale) => [sale.name, sale] as const))(
    'sends the same commands and bodies as the pre-change build: %s',
    async (name, sale) => {
      const h = makeCheckoutHarness({ A: sale.total.toFixed(2), B: '0.00' })
      const result = await sellCash(h, sale.items, sale.total, sale.extra)
      const order = h.db.getOrder(result.data!.localId)!
      expect(order.fiscal_status).toBe('fiscalized')
      expect(h.rec.commands()).toEqual(GOLDEN[name].commands)
      expect(h.rec.sent).toEqual(GOLDEN[name].bodies)
      expect(JSON.parse(order.fiscal_request_json!)).toEqual(GOLDEN[name].request)
    }
  )

  it.each([undefined, '', '   '])('files an absent or blank class (%j) as class A, exactly as the golden', async (vatClass) => {
    const h = makeCheckoutHarness({ A: '1.00' })
    const result = await sellCash(h, [{ ...GOLDEN_SALES[0].items[0], vatClass }], 1)
    expect(h.db.getOrder(result.data!.localId)?.fiscal_status).toBe('fiscalized')
    expect(h.rec.sent.find((body) => commandName(body).startsWith('SellPLU'))).toBe(SECTION_5_WIRE_SELL)
  })
})

describe('sell command per class', () => {
  it.each([undefined, '', 'A'])('sends class %j to SellPLUfromExtDB with OptionVATClass A and the store rate', async (vatClass) => {
    const rec = makeRecordingProvider({ A: '1.00' })
    const out = await rec.provider.submitInvoice(request([line(vatClass)]))
    expect(out.ok).toBe(true)
    expect(rec.commands()).toContain('SellPLUfromExtDB')
    expect(rec.commands()).not.toContain('SellPLUfromExtDB_HS')
    const args = Object.fromEntries(argsOf(rec.sent.find((b) => commandName(b) === 'SellPLUfromExtDB')!))
    expect(args.OptionVATClass).toBe('A')
    expect(args.VATGrRate).toBe('16.00')
  })

  it.each([
    ['B', { B: '1.00' }],
    ['C', { C: '1.00' }],
    ['D', { D: '1.00' }],
    ['E', { E: '1.00' }],
    ['e', { E: '1.00' }]
  ] as Array<[string, DeviceGroups]>)('sends class %s to SellPLUfromExtDB_HS with only name, price, HS code and quantity', async (vatClass, groups) => {
    const rec = makeRecordingProvider(groups)
    const out = await rec.provider.submitInvoice(request([line(vatClass, HS)]))
    expect(out.ok).toBe(true)
    expect(rec.commands()).not.toContain('SellPLUfromExtDB')
    expect(argsOf(rec.sent.find((b) => commandName(b) === 'SellPLUfromExtDB_HS')!)).toEqual([
      ['NamePLU', 'Maize'],
      ['Price', '1'],
      ['HSCode', '0013.12.02'],
      ['Quantity', '1']
    ])
  })

  it.each(['Z', 'AA', 'F'])('refuses the unknown class %s before any device call: never _HS, never A', async (vatClass) => {
    const rec = makeRecordingProvider({ A: '1.00' })
    const out = await rec.provider.submitInvoice(request([line(vatClass, HS)]))
    expect(out).toMatchObject({ ok: false, kind: 'data', retryable: false })
    expect(rec.sent).toEqual([])
  })

  it('ignores the Admin default tax class: a class-less line is still A', async () => {
    const rec = makeRecordingProvider({ A: '1.00' })
    rec.provider.reconfigure({ deviceIp: '1.2.3.4', devicePort: '8000', password: 'x', defaultVatClass: 'E' })
    const out = await rec.provider.submitInvoice(request([line(undefined)]))
    expect(out.ok).toBe(true)
    expect(rec.commands()).toContain('SellPLUfromExtDB')
    expect(rec.commands()).not.toContain('SellPLUfromExtDB_HS')
  })
})

describe('the group gate before CloseReceipt', () => {
  const mixed = (): FiscalInvoiceRequest['items'] => [
    { description: 'Bread', quantity: 1, unitPrice: 100, taxRate: 0.16 },
    line('E', HS)
  ]

  it('files a mixed sale when the device put the exempt amount in group E', async () => {
    const rec = makeRecordingProvider({ A: '100.00', E: '1.00' })
    const out = await rec.provider.submitInvoice(request(mixed()))
    expect(out.ok).toBe(true)
    expect(rec.commands()).toContain('CloseReceipt')
  })

  it('refuses before CloseReceipt when the device put the E amount in group C', async () => {
    const rec = makeRecordingProvider({ A: '100.00', C: '1.00' })
    const out = await rec.provider.submitInvoice(request(mixed()))
    expect(out).toMatchObject({ ok: false, kind: 'system', retryable: false })
    expect((out as { reason: string }).reason).toMatch(/group E/)
    expect(rec.commands()).not.toContain('CloseReceipt')
    expect(rec.commands().slice(-2)).toEqual(['ReadCurrentReceiptInfo', 'CancelReceipt'])
    expect(rec.commands().filter((c) => c === 'OpenInvoiceWithFreeCustomerData')).toHaveLength(1)
  })

  it('refuses when the device returns no group for the non-A line at all', async () => {
    const rec = makeRecordingProvider({ A: '100.00' })
    const out = await rec.provider.submitInvoice(request(mixed()))
    expect(out.ok).toBe(false)
    expect(rec.commands()).not.toContain('CloseReceipt')
  })

  it('refuses when the device charged the E line to group A', async () => {
    const rec = makeRecordingProvider({ A: '101.00' })
    const out = await rec.provider.submitInvoice(request(mixed()))
    expect(out.ok).toBe(false)
    expect(rec.commands()).not.toContain('CloseReceipt')
  })

  it('does not compare an A-only sale: its commands are the ones it always sent', async () => {
    const rec = makeRecordingProvider({ A: '5.00', C: '9.99' })
    const out = await rec.provider.submitInvoice(request([line(undefined)]))
    expect(out.ok).toBe(true)
    expect(rec.commands()).toEqual([
      'ReadCUnumbers',
      'ReadStatus',
      'OpenInvoiceWithFreeCustomerData',
      'SellPLUfromExtDB',
      'ReadCurrentReceiptInfo',
      'CloseReceipt',
      'ReadDateTime'
    ])
  })
})

describe('buildFiscalRequest through runCheckout', () => {
  it('stores the resolved class per line, with the store rate on A only', async () => {
    const h = makeCheckoutHarness({ A: '2.00', C: '1.00', E: '1.00' })
    const base = GOLDEN_SALES[0].items[0]
    const result = await sellCash(
      h,
      [
        { ...base, id: 'v1' },
        { ...base, id: 'v2', vatClass: '' },
        { ...base, id: 'v3', vatClass: 'C', ...HS },
        { ...base, id: 'v4', vatClass: ' e', ...HS }
      ],
      4
    )
    const order = h.db.getOrder(result.data!.localId)!
    expect(order.fiscal_status).toBe('fiscalized')
    const items = (JSON.parse(order.fiscal_request_json!) as FiscalInvoiceRequest).items
    expect(items.map((item) => item.vatClass)).toEqual(['A', 'A', 'C', 'E'])
    expect(items.map((item) => item.taxRate)).toEqual([0.16, 0.16, 0, 0])
    expect(h.rec.commands().filter((c) => c === 'SellPLUfromExtDB_HS')).toHaveLength(2)
  })
})

describe('the checkout gate (D2 and D4) leaves nothing behind', () => {
  const base = GOLDEN_SALES[0].items[0]

  it.each([
    ['an unknown class', { vatClass: 'Z' }, /tax class the till does not recognise/],
    ['a non-A line with no HS code', { vatClass: 'E', hsName: 'Maize' }, /HS code/],
    ['a non-A line with a malformed HS code', { vatClass: 'E', hsCode: '13.12', hsName: 'Maize' }, /HS code/]
  ] as const)('refuses %s, naming the item, before any order or device call', async (_label, fields, pattern) => {
    const h = makeCheckoutHarness({ A: '1.00' })
    const result = await sellCash(h, [{ ...base, ...fields }], 1)
    expect(result.success).toBe(false)
    expect(result.error).toContain('"Maize (D)"')
    expect(result.error).toMatch(pattern)
    expect(h.db.getOrder(1)).toBeUndefined()
    expect(h.rec.sent).toEqual([])
  })

  it('writes no order row and no payment row for a refused manual M-Pesa sale', async () => {
    const h = makeCheckoutHarness({ A: '1.00' })
    h.deps.manualEntryEnabled = true
    const result = await sellCash(h, [{ ...base, vatClass: 'E' }], 1, {
      paymentMethod: 'mpesa',
      referenceNumber: 'ABCDE12345',
      manualApproval: { acknowledgedUnverified: true }
    })
    expect(result.success).toBe(false)
    expect(h.db.getOrder(1)).toBeUndefined()
    expect(h.db.hasRecordedMpesaPayment('ABCDE12345')).toBe(false)
  })

  it('still refuses a discounted cart that holds a class C line', () => {
    const request = { items: [{ vatClass: 'C', discount: { type: 'percent' as const, value: 5 } }] }
    expect(shouldRefuseCheckoutForDiscount(true, request)).toBe(true)
  })
})
