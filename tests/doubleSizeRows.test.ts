/**
 * Double-size lines fit on one printed line (docs/phase-216).
 *
 * A `'double'` line prints twice as wide per character, so a printer of `width`
 * columns holds only `Math.floor(width / 2)` of them; anything longer wraps on
 * the printer and the PDF. Phase 215 measured it: the 48-character TOTAL KSH
 * row printed its amount on the line below the label.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import PDFDocument from 'pdfkit'
import { buildEnjoySlip } from '../src/main/lib/enjoySlip.js'
import {
  buildReceiptLayout,
  columnsFor,
  isReceiptLayoutQr,
  keyValueLines,
  wrappedLines
} from '../src/main/lib/receiptLayout.js'
import type {
  ReceiptLayoutEntry,
  ReceiptLayoutLine,
  ReceiptLayoutOrder,
  ReceiptLayoutSettings,
  ReceiptWidth
} from '../src/main/lib/receiptLayout.js'
import { computeReceiptPdfHeight, fontSizeForWidth } from '../src/main/services/pdf-receipt.js'
import { MockFiscalizationProvider } from '../src/main/services/integrations/mock-etims-provider.js'

const WIDTHS: ReceiptWidth[] = [48, 42, 32]
const QUIET = { warn: (): void => {} }
const halfOf = (width: number): number => Math.floor(width / 2)

const SETTINGS: ReceiptLayoutSettings = {
  taxRate: 0.16,
  tradingName: 'ENJOY',
  legalName: 'Rubis Energy Kenya PLC',
  address: 'Enjoy Westlands, Waiyaki Way, Nairobi',
  phone: '0700 000 000',
  sellerPin: 'P051XXXXXXXX',
  footerMessage: 'Thank you for shopping at Enjoy!'
}

const FILED: ReceiptLayoutOrder = {
  localId: 42,
  createdAt: '2026-09-27T15:58:00.000Z',
  cashierName: 'Mary W.',
  paymentMethod: 'mpesa',
  tenderedAmount: 0,
  changeDue: 0,
  referenceNumber: 'SJK4XYZ123',
  customerPin: 'P000123456Z',
  buyerName: 'ACME TRADERS LTD',
  fiscalInvoiceNumber: 'INV-000000042',
  traderInvNum: 'INV-000000042',
  fiscalQrCode: 'https://itax.kra.go.ke/verify/abc123',
  fiscalizedAt: '27-09-2026 18:58:41',
  fiscalizedAtSource: 'device',
  cuSerial: 'KRAMW0XXXXXXXXXX',
  total: 1650,
  vatGroups: { A: '1650.00' },
  items: [
    { title: 'Coca-Cola 500ml', variantTitle: '', quantity: 2, unitPrice: 100, vatClass: 'A' },
    { title: 'Bosch AeroTwin Wipers', variantTitle: 'Pair', quantity: 1, unitPrice: 1450, vatClass: 'A' }
  ]
}

const SALE_RECORD: ReceiptLayoutOrder = {
  ...FILED,
  fiscalInvoiceNumber: undefined,
  fiscalQrCode: undefined,
  fiscalizedAt: undefined,
  cuSerial: undefined,
  fiscalPending: true,
  paymentMethod: 'cash',
  tenderedAmount: 2000,
  changeDue: 350
}

const HUGE_ITEMS: ReceiptLayoutOrder['items'] = [
  { title: 'Generator', variantTitle: '', quantity: 1, unitPrice: 123456789.5, vatClass: 'A' }
]

const RECEIPT_SCENARIOS: Record<string, { order: ReceiptLayoutOrder; settings: ReceiptLayoutSettings }> = {
  filed: { order: FILED, settings: SETTINGS },
  duplicate: { order: { ...FILED, isDuplicate: true }, settings: SETTINGS },
  saleRecord: { order: SALE_RECORD, settings: SETTINGS },
  discounted: {
    order: {
      ...FILED,
      total: 1630,
      vatGroups: { A: '1630.00' },
      items: [
        { ...FILED.items[0], discount: { type: 'percent', value: 10 } },
        FILED.items[1]
      ]
    },
    settings: SETTINGS
  },
  hugeTotal: {
    order: { ...FILED, total: 123456789.5, vatGroups: { A: '123456789.50' }, items: HUGE_ITEMS },
    settings: SETTINGS
  },
  longShopName: {
    order: FILED,
    settings: { ...SETTINGS, tradingName: 'Enjoy Haile Selassie Supermarket and Convenience Limited' }
  },
  oneLongWordShopName: {
    order: FILED,
    settings: { ...SETTINGS, tradingName: 'Supercalifragilisticexpialidocious-Mart-Nairobi' }
  }
}

const ENJOY_SCENARIOS: Record<string, ReceiptLayoutOrder> = {
  cash: { ...FILED, paymentMethod: 'cash', tenderedAmount: 2000, changeDue: 350 },
  mpesa: FILED,
  duplicate: { ...FILED, isDuplicate: true },
  hugeTotal: { ...FILED, total: 123456789.5, items: HUGE_ITEMS }
}

const lines = (entries: ReceiptLayoutEntry[]): ReceiptLayoutLine[] =>
  entries.filter((entry): entry is ReceiptLayoutLine => !isReceiptLayoutQr(entry))

const doubles = (entries: ReceiptLayoutEntry[]): ReceiptLayoutLine[] =>
  lines(entries).filter((entry) => entry.style === 'double')

describe('a double-size line is never longer than half the printer width', () => {
  describe.each(WIDTHS)('at %d columns', (width) => {
    it.each(Object.keys(RECEIPT_SCENARIOS))('the fiscal slip, scenario %s', (name) => {
      const { order, settings } = RECEIPT_SCENARIOS[name]
      const found = doubles(buildReceiptLayout(order, settings, { width, logger: QUIET }))

      expect(found.length).toBeGreaterThan(0)
      for (const entry of found) expect(entry.text.length).toBeLessThanOrEqual(halfOf(width))
    })

    it.each(Object.keys(RECEIPT_SCENARIOS))('the fiscal slip with the mock provider banner, scenario %s', (name) => {
      const { order, settings } = RECEIPT_SCENARIOS[name]
      const mock = new MockFiscalizationProvider()
      const entries = buildReceiptLayout(
        order,
        { ...settings, decorate: (all, options) => mock.decorateFiscalSlip(all, options) },
        { width, logger: QUIET }
      )

      for (const entry of doubles(entries)) expect(entry.text.length).toBeLessThanOrEqual(halfOf(width))
    })

    it.each(Object.keys(ENJOY_SCENARIOS))('the Enjoy slip, scenario %s', (name) => {
      const found = doubles(
        buildEnjoySlip(ENJOY_SCENARIOS[name], { locationName: 'Enjoy Westlands' }, { width, kraNote: 'printed' })
      )

      expect(found.length).toBeGreaterThan(0)
      for (const entry of found) expect(entry.text.length).toBeLessThanOrEqual(halfOf(width))
    })
  })

  const GOLDEN = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/receipt-class-a-golden.json'), 'utf8')) as {
    layouts: Record<string, ReceiptLayoutEntry[]>
  }

  it.each(Object.keys(GOLDEN.layouts))('the golden layout %s', (key) => {
    const width = Number(key.split('@')[1])
    const found = doubles(GOLDEN.layouts[key])

    expect(found.length).toBeGreaterThan(0)
    for (const entry of found) expect(entry.text.length).toBeLessThanOrEqual(halfOf(width))
  })
})

describe('the TOTAL KSH row', () => {
  const totalRows = (width: ReceiptWidth): ReceiptLayoutLine[] => {
    const all = lines(buildReceiptLayout(FILED, SETTINGS, { width }))
    const at = all.findIndex((entry) => entry.text.startsWith('TOTAL KSH'))
    return all.slice(at).filter((entry, i) => i < 2 && entry.style === 'double')
  }

  it('is one entry of 24 characters at 48, label left and amount at the right edge', () => {
    const rows = totalRows(48)

    expect(rows).toHaveLength(1)
    expect(rows[0].text).toBe('TOTAL KSH       1,650.00')
    expect(rows[0].text).toHaveLength(24)
  })

  it('is one entry of 21 characters at 42', () => {
    const rows = totalRows(42)

    expect(rows).toHaveLength(1)
    expect(rows[0].text).toBe('TOTAL KSH    1,650.00')
    expect(rows[0].text).toHaveLength(21)
  })

  it('is two entries at 32: the label first, then the amount padded to 16 and at the right edge', () => {
    const rows = totalRows(32)

    expect(rows.map((row) => row.text)).toEqual(['TOTAL KSH', '        1,650.00'])
    expect(rows[1].text).toHaveLength(16)
    expect(rows.every((row) => row.style === 'double' && row.align === 'left')).toBe(true)
  })
})

describe('keyValueLines at double size', () => {
  it('measures the line in double-size columns', () => {
    expect(columnsFor('double', 48)).toBe(24)
    expect(columnsFor('double', 42)).toBe(21)
    expect(columnsFor('double', 32)).toBe(16)
    expect(columnsFor('normal', 48)).toBe(48)
    expect(columnsFor('bold', 32)).toBe(32)
  })

  it('pads the fallback value line to half the width, never to the full width', () => {
    const [label, value] = keyValueLines('TOTAL KSH', '1,650.00', 32, 'double')

    expect(label.text).toBe('TOTAL KSH')
    expect(value.text).toBe('        1,650.00')
    expect(value.text).toHaveLength(16)
  })

  it('cuts a label longer than half the width to half the width, and still puts it first', () => {
    const [label, value] = keyValueLines('A VERY LONG LABEL INDEED', '5.00', 32, 'double')

    expect(label.text).toBe('A VERY LONG LABE')
    expect(value.text).toBe('            5.00')
  })

  it('cuts a value longer than half the width to half the width', () => {
    const [, value] = keyValueLines('TOTAL', '123,456,789,012,345.00', 32, 'double')

    expect(value.text).toHaveLength(16)
  })

  it('leaves a normal-size row at the full width, and its fallback padded to the full width', () => {
    const [row] = keyValueLines('TOTAL EXCL. VAT', '1,422.41', 48)
    const [label, value] = keyValueLines('A LABEL OF SOME LENGTH', 'A VALUE OF SOME LENGTH TOO', 40)

    expect(row.text).toHaveLength(48)
    expect(label.text).toBe('A LABEL OF SOME LENGTH')
    expect(value.text).toHaveLength(40)
  })
})

describe('a centred double-size heading is broken to half the width', () => {
  it('breaks a long shop name at a word, every line within half the width, no word lost', () => {
    const name = 'Enjoy Haile Selassie Supermarket and Convenience Limited'
    const out = wrappedLines(name, 48, 'centre', 'double')

    expect(out.map((entry) => entry.text)).toEqual([
      'Enjoy Haile Selassie',
      'Supermarket and',
      'Convenience Limited'
    ])
    for (const entry of out) expect(entry.text.length).toBeLessThanOrEqual(24)
    expect(out.map((entry) => entry.text).join(' ')).toBe(name)
  })

  it('cuts a single word longer than half the width into pieces of half the width', () => {
    const out = wrappedLines('Supercalifragilisticexpialidocious', 32, 'centre', 'double')

    expect(out.map((entry) => entry.text)).toEqual(['Supercalifragili', 'sticexpialidocio', 'us'])
  })

  it('leaves a normal-size line wrapping at the full width', () => {
    const out = wrappedLines('Enjoy Westlands, Waiyaki Way, Nairobi', 48)

    expect(out).toHaveLength(1)
  })
})

describe('the PDF fallback draws the TOTAL KSH row on one line', () => {
  const USABLE_PT = 72 * 2.83465

  const drawnHeight = (text: string, width: number): { height: number; oneLine: number } => {
    const doc = new PDFDocument({ size: [80 * 2.83465, 400], margin: 4 * 2.83465 })
    doc.font('Courier-Bold').fontSize(fontSizeForWidth(width) * 2)
    return { height: doc.heightOfString(text, { width: USABLE_PT }), oneLine: doc.currentLineHeight(true) }
  }

  it('fits the 24-character row on one line at 48, where the 48-character row wrapped to two', () => {
    const fitted = drawnHeight('TOTAL KSH       1,650.00', 48)
    const wrapped = drawnHeight('TOTAL KSH                               1,650.00', 48)

    expect(fitted.height).toBeCloseTo(fitted.oneLine, 5)
    expect(wrapped.height).toBeGreaterThan(wrapped.oneLine * 1.5)
  })

  it.each(WIDTHS)('fits every double line of the fiscal slip on one line at %d columns', (width) => {
    const entries = buildReceiptLayout(FILED, SETTINGS, { width })
    for (const entry of doubles(entries)) {
      const { height, oneLine } = drawnHeight(entry.text, width)
      expect(height).toBeCloseTo(oneLine, 5)
    }
  })

  it.each(WIDTHS)('still allots at least the height the double lines are drawn at (%d columns)', (width) => {
    const entries = buildReceiptLayout(FILED, SETTINGS, { width })
    const fontSize = fontSizeForWidth(width)
    const doc = new PDFDocument({ size: [80 * 2.83465, 400], margin: 4 * 2.83465 })
    doc.font('Courier-Bold').fontSize(fontSize * 2)
    const doubleLineHeight = doc.currentLineHeight(true)
    const allottedPerDouble = 2 * fontSize * 1.5

    expect(doubleLineHeight).toBeLessThanOrEqual(allottedPerDouble)
    expect(computeReceiptPdfHeight(entries, fontSize)).toBeGreaterThanOrEqual(
      (lines(entries).length + doubles(entries).length) * fontSize * 1.5
    )
  })
})
