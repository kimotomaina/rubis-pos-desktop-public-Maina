/**
 * The start and end markers of a filed fiscal slip (docs/phase-198-2): where they
 * sit, that a duplicate carries them too, that the sale record and the Enjoy slip
 * never do, and that the mock's test banner stays outside both.
 */

import { describe, it, expect } from 'vitest'
import { buildReceiptLayout, isReceiptLayoutQr } from '../src/main/lib/receiptLayout.js'
import type { ReceiptLayoutEntry, ReceiptLayoutOrder, ReceiptWidth } from '../src/main/lib/receiptLayout.js'
import { FISCAL_RECEIPT_END_MARKER, FISCAL_RECEIPT_START_MARKER } from '../src/main/lib/receiptFiscalBlock.js'
import { buildEnjoySlip } from '../src/main/lib/enjoySlip.js'
import { MockFiscalizationProvider, MOCK_SLIP_BANNER } from '../src/main/services/integrations/mock-etims-provider.js'
import { buildPrinterRegistry, printOrderSlips } from '../src/main/services/printer.js'
import type { ReceiptOrder } from '../src/main/services/printer.js'
import { recordingPrinter } from './helpers/recordingPrinter.js'

const SETTINGS = {
  taxRate: 0.16,
  tradingName: 'ENJOY',
  legalName: 'Rubis Energy Kenya PLC',
  address: 'Waiyaki Way, Nairobi',
  sellerPin: 'P051XXXXXXXX',
  footerMessage: 'Thank you for shopping at Enjoy!'
}

const FILED: ReceiptLayoutOrder = {
  localId: 42,
  createdAt: new Date(2026, 8, 27, 18, 58).toISOString(),
  cashierName: 'Mary W.',
  paymentMethod: 'cash',
  tenderedAmount: 100,
  changeDue: 40,
  fiscalInvoiceNumber: '0123456789012345678',
  traderInvNum: 'INV-000000042',
  fiscalQrCode: 'https://itax.kra.go.ke/verify/abc123',
  fiscalizedAt: '27-09-2026 18:58:41',
  fiscalizedAtSource: 'device',
  cuSerial: 'KRAMW0XXXXXXXXXX',
  total: 60,
  vatGroups: { A: '51.72' },
  items: [{ title: 'Mug', variantTitle: '', quantity: 1, unitPrice: 60, vatClass: 'A' }]
}

const PENDING: ReceiptLayoutOrder = {
  ...FILED,
  fiscalInvoiceNumber: undefined,
  fiscalQrCode: undefined,
  fiscalizedAt: undefined,
  cuSerial: undefined,
  vatGroups: undefined,
  fiscalPending: true
}

const texts = (entries: ReceiptLayoutEntry[]): string[] =>
  entries.map((entry) => (isReceiptLayoutQr(entry) ? '[qr]' : entry.text))

const widths: ReceiptWidth[] = [48, 32]

describe.each(widths)('a filed fiscal slip at %d columns', (width) => {
  const build = (order: ReceiptLayoutOrder) => buildReceiptLayout(order, SETTINGS, { width })

  it.each([
    ['original', FILED],
    ['duplicate', { ...FILED, isDuplicate: true }]
  ] as const)('carries each marker once, centred, on the %s', (_name, order) => {
    const entries = build(order)
    const out = texts(entries)

    expect(out.filter((l) => l === FISCAL_RECEIPT_START_MARKER)).toHaveLength(1)
    expect(out.filter((l) => l === FISCAL_RECEIPT_END_MARKER)).toHaveLength(1)
    expect(entries[out.indexOf(FISCAL_RECEIPT_START_MARKER)]).toMatchObject({ align: 'centre', style: 'normal' })
    expect(entries[out.indexOf(FISCAL_RECEIPT_END_MARKER)]).toMatchObject({ align: 'centre', style: 'normal' })
  })

  it('puts START after the header block and its rule, directly before the FISCAL RECEIPT label', () => {
    const out = texts(build(FILED))
    const start = out.indexOf(FISCAL_RECEIPT_START_MARKER)

    expect(out[start - 1]).toBe('-'.repeat(width))
    expect(out[start - 2]).toBe('PIN: P051XXXXXXXX')
    expect(out[start + 1]).toBe('FISCAL RECEIPT')
  })

  it('puts END after the QR and "Scan to verify" lines, directly before the footer', () => {
    const out = texts(build(FILED))
    const end = out.indexOf(FISCAL_RECEIPT_END_MARKER)

    expect(out.indexOf('[qr]')).toBeLessThan(end)
    expect(out.slice(0, end).join(' ')).toContain('Scan to verify this receipt with KRA')
    expect(out[end - 1]).toBe('-'.repeat(width))
    expect(out[end + 1]).toBe('Thank you for shopping at Enjoy!')
  })

  it('still puts END before the footer when the sale has no QR', () => {
    const out = texts(build({ ...FILED, fiscalQrCode: undefined }))
    const end = out.indexOf(FISCAL_RECEIPT_END_MARKER)

    expect(out[end + 1]).toBe('Thank you for shopping at Enjoy!')
    expect(out.indexOf('[qr]')).toBe(-1)
  })

  it('keeps a duplicate\'s top and bottom stamps outside the markers', () => {
    const out = texts(build({ ...FILED, isDuplicate: true }))

    expect(out[0]).toBe('*** DUPLICATE ***')
    expect(out.indexOf(FISCAL_RECEIPT_START_MARKER)).toBeGreaterThan(0)
    expect(out.at(-1)).toBe('*** DUPLICATE ***')
    expect(out.indexOf(FISCAL_RECEIPT_END_MARKER)).toBeLessThan(out.length - 1)
  })

  it('is absent on the sale record slip', () => {
    const out = texts(build(PENDING))

    expect(out).toContain('SALE RECORD')
    expect(out).not.toContain(FISCAL_RECEIPT_START_MARKER)
    expect(out).not.toContain(FISCAL_RECEIPT_END_MARKER)
    expect(out.some((l) => l.includes('FISCAL RECEIPT'))).toBe(false)
  })

  it('is absent on a sale record reprint too', () => {
    const out = texts(build({ ...PENDING, isDuplicate: true }))

    expect(out.some((l) => l.includes('OF FISCAL RECEIPT'))).toBe(false)
  })

  it('is absent on the Enjoy slip, for a filed sale and a pending one', () => {
    for (const order of [FILED, PENDING, { ...FILED, isDuplicate: true }]) {
      const out = texts(buildEnjoySlip(order, { locationName: 'Enjoy Westlands' }, { width, kraNote: 'printed' }))

      expect(out.some((l) => l.includes('FISCAL RECEIPT'))).toBe(false)
    }
  })
})

describe('the mock provider\'s test banner', () => {
  const mock = new MockFiscalizationProvider(0)

  it('stays above START and below END', () => {
    const entries = buildReceiptLayout(
      FILED,
      { ...SETTINGS, decorate: (e, o) => mock.decorateFiscalSlip(e, o) },
      { width: 48 }
    )
    const out = texts(entries)
    const stars = '*'.repeat(48)

    expect(out.slice(0, 3)).toEqual([stars, MOCK_SLIP_BANNER, stars])
    expect(out.slice(-3)).toEqual([stars, MOCK_SLIP_BANNER, stars])
    expect(out.indexOf(FISCAL_RECEIPT_START_MARKER)).toBeGreaterThan(2)
    expect(out.indexOf(FISCAL_RECEIPT_END_MARKER)).toBeLessThan(out.length - 3)
    expect(out.filter((l) => l === MOCK_SLIP_BANNER)).toHaveLength(2)
  })

  it('has nothing between END and the bottom banner but the footer', () => {
    const out = texts(
      buildReceiptLayout(FILED, { ...SETTINGS, decorate: (e, o) => mock.decorateFiscalSlip(e, o) }, { width: 48 })
    )

    const end = out.indexOf(FISCAL_RECEIPT_END_MARKER)
    expect(out.slice(end + 1, -3)).toEqual(['Thank you for shopping at Enjoy!', 'A = VAT 16%. Prices include VAT.'])
  })
})

describe('on the printer', () => {
  const registry = buildPrinterRegistry([])
  const order: ReceiptOrder = {
    localId: 42,
    createdAt: FILED.createdAt,
    cashierName: 'Mary W.',
    paymentMethod: 'cash',
    tenderedAmount: 100,
    changeDue: 40,
    fiscalInvoiceNumber: FILED.fiscalInvoiceNumber,
    traderInvNum: FILED.traderInvNum,
    fiscalQrCode: FILED.fiscalQrCode,
    fiscalizedAt: FILED.fiscalizedAt,
    fiscalizedAtSource: 'device',
    cuSerial: FILED.cuSerial,
    vatGroups: { A: '51.72' },
    total: 60
  }

  it('prints both markers in the fiscal job and neither in the Enjoy job', async () => {
    const { factory, jobs } = recordingPrinter()

    await printOrderSlips(
      order,
      [{ title: 'Mug', variantTitle: '', quantity: 1, unitPrice: 60 }],
      registry,
      { interfaceName: 'tcp://x', storeName: 'ENJOY', taxRate: 0.16 },
      { fiscal: true, customer: true },
      'receipt',
      factory,
      async () => 'C:/x.pdf'
    )

    expect(jobs[0].lines).toContain(FISCAL_RECEIPT_START_MARKER)
    expect(jobs[0].lines).toContain(FISCAL_RECEIPT_END_MARKER)
    expect(jobs[1].lines.some((l) => l.includes('FISCAL RECEIPT'))).toBe(false)
  })
})
