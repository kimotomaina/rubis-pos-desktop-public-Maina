/**
 * `buildReceiptLayout` tests (docs/phase-171).
 *
 * The single source of truth for every receipt's content, wording and
 * field order — both `printer.ts` (thermal, plain-text assertable) and
 * `pdf-receipt.ts` (PDF, not text-assertable) render this array without
 * adding or reinterpreting anything, so testing it here proves the exact
 * content once for both.
 */

import { describe, it, expect } from 'vitest'
import {
  buildReceiptLayout,
  isReceiptLayoutQr,
  formatAmount,
  formatReceiptDateTime,
  wrapText,
  toAscii
} from '../src/main/lib/receiptLayout.js'
import type {
  ReceiptLayoutOrder,
  ReceiptLayoutSettings,
  ReceiptLayoutEntry,
  ReceiptWidth
} from '../src/main/lib/receiptLayout.js'

const SETTINGS: ReceiptLayoutSettings = {
  taxRate: 0.16,
  tradingName: 'ENJOY',
  legalName: 'Rubis Energy Kenya PLC',
  address: 'Enjoy Westlands, Waiyaki Way, Nairobi',
  phone: '0700 000 000',
  sellerPin: 'P051XXXXXXXX',
  footerMessage: 'Thank you for shopping at Enjoy!'
}

/**
 * Built from local date/time components (not a UTC ISO literal) so
 * `formatReceiptDateTime`'s local-time formatting produces `18:58`
 * whatever timezone the test runner itself is in.
 */
const SALE_CREATED_AT = new Date(2026, 8, 27, 18, 58, 0).toISOString()

const BASE_ORDER: ReceiptLayoutOrder = {
  localId: 42,
  createdAt: SALE_CREATED_AT,
  cashierName: 'Mary W.',
  paymentMethod: 'mpesa',
  tenderedAmount: 0,
  changeDue: 0,
  referenceNumber: 'SJK4XYZ123',
  customerPin: 'P000123456Z',
  buyerName: 'ACME TRADERS LTD',
  fiscalInvoiceNumber: 'INV-000000042',
  fiscalQrCode: 'https://itax.kra.go.ke/verify/abc123',
  fiscalizedAt: '27-09-2026 18:58:41',
  fiscalizedAtSource: 'device',
  cuSerial: 'KRAMW0XXXXXXXXXX',
  total: 1650,
  vatGroups: { A: '1422.41' },
  items: [
    { title: 'Coca-Cola 500ml', variantTitle: '', quantity: 2, unitPrice: 100, vatClass: 'A' },
    { title: 'Bosch AeroTwin Wipers', variantTitle: 'Pair', quantity: 1, unitPrice: 1450, vatClass: 'A' }
  ]
}

function textLines(entries: ReceiptLayoutEntry[]): string[] {
  return entries.filter((e): e is Extract<ReceiptLayoutEntry, { text: string }> => !isReceiptLayoutQr(e)).map((e) => e.text)
}

function findIndex(lines: string[], predicate: (line: string) => boolean): number {
  return lines.findIndex(predicate)
}

describe('buildReceiptLayout — width fit and ASCII (docs/phase-171)', () => {
  const widths: ReceiptWidth[] = [48, 42, 32]

  it.each(widths)('every printed line fits within a %d-character width', (width) => {
    const scenarios: ReceiptLayoutOrder[] = [
      BASE_ORDER,
      { ...BASE_ORDER, isDuplicate: true },
      {
        ...BASE_ORDER,
        fiscalInvoiceNumber: undefined,
        fiscalQrCode: undefined,
        fiscalizedAt: undefined,
        fiscalizedAtSource: undefined,
        cuSerial: undefined,
        fiscalPending: true,
        buyerName: undefined,
        customerPin: undefined,
        paymentMethod: 'cash',
        tenderedAmount: 500,
        changeDue: 300,
        total: 200,
        items: [{ title: 'Coca-Cola 500ml', variantTitle: '', quantity: 2, unitPrice: 100, vatClass: 'A' }]
      }
    ]

    for (const order of scenarios) {
      const entries = buildReceiptLayout(order, SETTINGS, { width })
      for (const line of textLines(entries)) {
        expect(line.length).toBeLessThanOrEqual(width)
      }
    }
  })

  it.each(widths)('every printed line is ASCII only at width %d', (width) => {
    const order: ReceiptLayoutOrder = {
      ...BASE_ORDER,
      buyerName: 'ACME “Traders” Ltd — East Africa',
      items: [{ title: 'Café Latte Mug', variantTitle: '', quantity: 1, unitPrice: 500, vatClass: 'A' }]
    }
    const entries = buildReceiptLayout(order, SETTINGS, { width })

    for (const line of textLines(entries)) {
      expect(line).toMatch(/^[\x20-\x7E]*$/)
    }
  })
})

describe('buildReceiptLayout — fiscal original', () => {
  const entries = buildReceiptLayout(BASE_ORDER, SETTINGS, { width: 48 })
  const lines = textLines(entries)

  it('prints every field from sections (a)-(i), in order', () => {
    const order: Array<(line: string) => boolean> = [
      (l) => l === 'ENJOY',
      (l) => l === 'Rubis Energy Kenya PLC',
      (l) => l.includes('Enjoy Westlands'),
      (l) => l.includes('Tel 0700 000 000'),
      (l) => l.includes('PIN: P051XXXXXXXX'),
      (l) => l === 'FISCAL RECEIPT',
      (l) => l.trim() === 'ORIGINAL',
      (l) => l.includes('Invoice No:') && l.includes('INV-000000042'),
      (l) => l.includes('Date:') && l.includes('27/09/2026 18:58'),
      (l) => l.includes('Cashier:') && l.includes('Mary W.'),
      (l) => l.includes('Buyer PIN:') && l.includes('P000123456Z'),
      (l) => l.includes('Buyer:') && l.includes('ACME TRADERS LTD'),
      (l) => l.includes('ITEM') && l.includes('QTY'),
      (l) => l.includes('Coca-Cola 500ml'),
      (l) => l.includes('Bosch AeroTwin Wipers'),
      (l) => l.includes('TOTAL EXCL. VAT'),
      (l) => l.trim().startsWith('VAT') && l.includes(formatAmount(227.59)),
      (l) => l.includes('TOTAL KSH') && l.includes('1,650.00'),
      (l) => l.includes('PAID BY M-PESA'),
      (l) => l.includes('M-Pesa ref:') && l.includes('SJK4XYZ123'),
      (l) => l.includes('VAT') && l.includes('RATE') && l.includes('TAXABLE'),
      (l) => l.startsWith('A ') && l.includes('16%'),
      (l) => l === 'CONTROL UNIT INFO',
      (l) => l.includes('CU Date/Time:') && l.includes('27-09-2026 18:58:41'),
      (l) => l.includes('CU Serial No:') && l.includes('KRAMW0XXXXXXXXXX'),
      (l) => l.includes('CU Invoice No:') && l.includes('INV-000000042'),
      (l) => l.includes('Scan to verify this receipt with KRA'),
      (l) => l.includes('Thank you for shopping at Enjoy!'),
      (l) => l.includes('A = VAT 16%')
    ]

    let cursor = -1
    for (const predicate of order) {
      const found = findIndex(lines.slice(cursor + 1), predicate)
      expect(found).toBeGreaterThanOrEqual(0)
      cursor = cursor + 1 + found
    }
  })

  it('carries a QR entry with the device\'s exact stored text', () => {
    const qrEntries = entries.filter(isReceiptLayoutQr)
    expect(qrEntries).toHaveLength(1)
    expect(qrEntries[0].qr).toBe('https://itax.kra.go.ke/verify/abc123')
  })

  it('never says ORIGINAL and DUPLICATE together', () => {
    expect(lines.some((l) => l.includes('DUPLICATE'))).toBe(false)
  })
})

describe('buildReceiptLayout — reprint (docs/phase-171)', () => {
  const entries = buildReceiptLayout({ ...BASE_ORDER, isDuplicate: true }, SETTINGS, { width: 48 })
  const lines = textLines(entries)

  it('stamps DUPLICATE at the top and bottom, and in place of ORIGINAL', () => {
    const stampIndexes = lines.map((l, i) => (l === '*** DUPLICATE ***' ? i : -1)).filter((i) => i >= 0)
    expect(stampIndexes).toHaveLength(3)
    expect(lines).not.toContain('ORIGINAL')
    expect(lines).toContain('FISCAL RECEIPT')
  })

  it('the first stamp is before the trading name; the last is after the footer', () => {
    const stampIndexes = lines.map((l, i) => (l === '*** DUPLICATE ***' ? i : -1)).filter((i) => i >= 0)
    expect(stampIndexes[0]).toBeLessThan(lines.indexOf('ENJOY'))
    expect(stampIndexes[stampIndexes.length - 1]).toBeGreaterThan(
      lines.findIndex((l) => l.includes('Thank you'))
    )
  })
})

describe('buildReceiptLayout — sale not yet filed (docs/phase-171)', () => {
  const slipOrder: ReceiptLayoutOrder = {
    ...BASE_ORDER,
    fiscalInvoiceNumber: undefined,
    fiscalQrCode: undefined,
    fiscalizedAt: undefined,
    fiscalizedAtSource: undefined,
    cuSerial: undefined,
    fiscalPending: true,
    localId: 43,
    paymentMethod: 'cash',
    tenderedAmount: 500,
    changeDue: 300,
    total: 200,
    items: [{ title: 'Coca-Cola 500ml', variantTitle: '', quantity: 2, unitPrice: 100, vatClass: 'A' }]
  }
  const entries = buildReceiptLayout(slipOrder, SETTINGS, { width: 48 })
  const lines = textLines(entries)

  it('prints SALE RECORD / NOT A TAX INVOICE / Tax invoice to follow, and "Sale No:" instead of "Invoice No:"', () => {
    expect(lines).toContain('SALE RECORD')
    expect(lines).toContain('NOT A TAX INVOICE')
    expect(lines).toContain('Tax invoice to follow')
    expect(lines.some((l) => l.includes('Sale No:') && l.includes('43'))).toBe(true)
    expect(lines.some((l) => l.includes('Invoice No:'))).toBe(false)
  })

  it('never prints FISCAL RECEIPT, ORIGINAL, a CU block, or a VAT table', () => {
    expect(lines).not.toContain('FISCAL RECEIPT')
    expect(lines).not.toContain('ORIGINAL')
    expect(lines.some((l) => l.includes('CU Invoice No:'))).toBe(false)
    expect(lines.some((l) => l.includes('CU Serial No:'))).toBe(false)
    expect(lines.some((l) => l.includes('CONTROL UNIT INFO'))).toBe(false)
    expect(lines.some((l) => l.includes('TAXABLE'))).toBe(false)
    expect(entries.some(isReceiptLayoutQr)).toBe(false)
  })

  it('still prints the plain totals/payment sections', () => {
    expect(lines.some((l) => l.includes('TOTAL KSH') && l.includes('200.00'))).toBe(true)
    expect(lines.some((l) => l.includes('PAID BY CASH'))).toBe(true)
    expect(lines.some((l) => l.includes('Tendered:') && l.includes('500.00'))).toBe(true)
    expect(lines.some((l) => l.includes('Change:') && l.includes('300.00'))).toBe(true)
  })
})

describe('buildReceiptLayout — mock/non-eTIMS provider: no slip wording (docs/phase-171)', () => {
  const mockOrder: ReceiptLayoutOrder = {
    ...BASE_ORDER,
    fiscalInvoiceNumber: undefined,
    fiscalQrCode: undefined,
    fiscalizedAt: undefined,
    fiscalizedAtSource: undefined,
    cuSerial: undefined,
    fiscalPending: false
  }
  const lines = textLines(buildReceiptLayout(mockOrder, SETTINGS, { width: 48 }))

  it('prints neither FISCAL RECEIPT nor SALE RECORD wording', () => {
    expect(lines).not.toContain('FISCAL RECEIPT')
    expect(lines).not.toContain('ORIGINAL')
    expect(lines).not.toContain('SALE RECORD')
    expect(lines).not.toContain('NOT A TAX INVOICE')
    expect(lines).not.toContain('Tax invoice to follow')
  })

  it('still prints the header, items and totals', () => {
    expect(lines).toContain('ENJOY')
    expect(lines.some((l) => l.includes('Coca-Cola'))).toBe(true)
    expect(lines.some((l) => l.includes('TOTAL KSH'))).toBe(true)
  })
})

describe('buildReceiptLayout — buyer lines', () => {
  it('omits Buyer PIN and Buyer entirely when neither is present', () => {
    const order: ReceiptLayoutOrder = { ...BASE_ORDER, customerPin: undefined, buyerName: undefined }
    const lines = textLines(buildReceiptLayout(order, SETTINGS, { width: 48 }))

    expect(lines.some((l) => l.includes('Buyer PIN:'))).toBe(false)
    expect(lines.some((l) => l.includes('Buyer:'))).toBe(false)
  })

  it('prints Buyer PIN without Buyer when only the PIN is present', () => {
    const order: ReceiptLayoutOrder = { ...BASE_ORDER, buyerName: undefined }
    const lines = textLines(buildReceiptLayout(order, SETTINGS, { width: 48 }))

    expect(lines.some((l) => l.includes('Buyer PIN:'))).toBe(true)
    expect(lines.some((l) => l.includes('Buyer:'))).toBe(false)
  })

  it('wraps a long buyer name to at most 2 lines', () => {
    const order: ReceiptLayoutOrder = {
      ...BASE_ORDER,
      buyerName: 'A Very Long Registered Company Trading Name Limited International Holdings'
    }
    const entries = buildReceiptLayout(order, SETTINGS, { width: 32 })
    const lines = textLines(entries)
    const buyerLineIndex = lines.findIndex((l) => l.includes('Buyer:'))
    expect(buyerLineIndex).toBeGreaterThanOrEqual(0)

    // At most 2 lines belong to the buyer name (the labelled line plus one continuation).
    const nextRuleIndex = lines.findIndex((l, i) => i > buyerLineIndex && /^-+$/.test(l))
    expect(nextRuleIndex - buyerLineIndex).toBeLessThanOrEqual(2)
  })
})

describe('buildReceiptLayout — items', () => {
  it('drops "Default Title" from the printed name', () => {
    const order: ReceiptLayoutOrder = {
      ...BASE_ORDER,
      items: [{ title: 'RUBIS Mug', variantTitle: 'Default Title', quantity: 1, unitPrice: 500 }]
    }
    const lines = textLines(buildReceiptLayout(order, SETTINGS, { width: 48 }))

    expect(lines).toContain('RUBIS Mug')
    expect(lines.some((l) => l.includes('Default Title'))).toBe(false)
  })

  it('appends a real variant title in parentheses', () => {
    const order: ReceiptLayoutOrder = {
      ...BASE_ORDER,
      items: [{ title: 'RUBIS Mug', variantTitle: 'Small', quantity: 1, unitPrice: 500 }]
    }
    const lines = textLines(buildReceiptLayout(order, SETTINGS, { width: 48 }))

    expect(lines).toContain('RUBIS Mug (Small)')
  })

  it('wraps a long item name to at most 2 lines', () => {
    const order: ReceiptLayoutOrder = {
      ...BASE_ORDER,
      items: [
        {
          title: 'An Extremely Long Product Name That Cannot Possibly Fit On One Printed Line At All',
          variantTitle: '',
          quantity: 1,
          unitPrice: 500
        }
      ]
    }
    const entries = buildReceiptLayout(order, SETTINGS, { width: 32 })
    const lines = textLines(entries)
    const headingIndex = lines.findIndex((l) => l.includes('ITEM') && l.includes('QTY'))
    const amountIndex = lines.findIndex((l) => /x\s/.test(l) && l.trim().endsWith('A'))
    // Between the heading, its rule, and the amount line, only the item's
    // own (wrapped) name lines appear — at most 2 of them.
    expect(amountIndex - headingIndex).toBeLessThanOrEqual(4)
  })

  it('prints a discount line only when the item has one', () => {
    const discounted: ReceiptLayoutOrder = {
      ...BASE_ORDER,
      total: 1600,
      items: [
        {
          title: 'Coca-Cola 500ml',
          variantTitle: '',
          quantity: 2,
          unitPrice: 100,
          discount: { type: 'fixed', value: 50 }
        }
      ]
    }
    const lines = textLines(buildReceiptLayout(discounted, SETTINGS, { width: 48 }))
    expect(lines.some((l) => l.includes('Discount: -'))).toBe(true)

    const undiscounted = textLines(buildReceiptLayout(BASE_ORDER, SETTINGS, { width: 48 }))
    expect(undiscounted.some((l) => l.includes('Discount: -'))).toBe(false)
  })
})

describe('buildReceiptLayout — totals reconcile to the cent', () => {
  it('TOTAL EXCL. VAT + VAT always equals TOTAL KSH', () => {
    for (const total of [1650, 199.99, 0.5, 12345.67]) {
      const order: ReceiptLayoutOrder = { ...BASE_ORDER, total }
      const lines = textLines(buildReceiptLayout(order, SETTINGS, { width: 48 }))
      const exclLine = lines.find((l) => l.includes('TOTAL EXCL. VAT'))!
      const vatLine = lines.find((l) => l.trim().startsWith('VAT') && !l.includes('RATE'))!
      const totalLine = lines.find((l) => l.includes('TOTAL KSH'))!

      const parseAmount = (line: string): number => Number(line.trim().split(/\s+/).pop()!.replace(/,/g, ''))
      const excl = parseAmount(exclLine)
      const vat = parseAmount(vatLine)
      const printedTotal = parseAmount(totalLine)

      expect(Math.round((excl + vat) * 100) / 100).toBeCloseTo(printedTotal, 2)
      expect(printedTotal).toBeCloseTo(total, 2)
    }
  })
})

describe('buildReceiptLayout — VAT table (fiscalised only, docs/phase-171)', () => {
  it('prints one row per stored VAT group, from the device\'s own taxable subtotal', () => {
    const order: ReceiptLayoutOrder = {
      ...BASE_ORDER,
      total: 1740,
      vatGroups: { A: '1422.41', B: '100.00' }
    }
    const lines = textLines(buildReceiptLayout(order, SETTINGS, { width: 48 }))

    expect(lines.some((l) => l.startsWith('A ') && l.includes('16%') && l.includes('1,422.41'))).toBe(true)
    expect(lines.some((l) => l.startsWith('B ') && l.includes('8%') && l.includes('100.00'))).toBe(true)
  })

  it('shows "n/a" for class D\'s VAT figure', () => {
    const order: ReceiptLayoutOrder = { ...BASE_ORDER, vatGroups: { D: '500.00' } }
    const lines = textLines(buildReceiptLayout(order, SETTINGS, { width: 48 }))

    expect(lines.some((l) => l.startsWith('D ') && l.includes('n/a'))).toBe(true)
  })

  it('falls back to computing class A from the lines when the stored groups are missing', () => {
    const order: ReceiptLayoutOrder = { ...BASE_ORDER, vatGroups: undefined }
    const lines = textLines(buildReceiptLayout(order, SETTINGS, { width: 48 }))

    // rawSubtotal for the base order's two items is 200 + 1450 = 1650.
    expect(lines.some((l) => l.startsWith('A ') && l.includes('1,650.00'))).toBe(true)
  })

  it('never prints a VAT table for an unfiled sale', () => {
    const order: ReceiptLayoutOrder = {
      ...BASE_ORDER,
      fiscalInvoiceNumber: undefined,
      fiscalQrCode: undefined,
      vatGroups: { A: '1422.41' }
    }
    const lines = textLines(buildReceiptLayout(order, SETTINGS, { width: 48 }))

    expect(lines.some((l) => l.includes('TAXABLE'))).toBe(false)
  })
})

describe('formatAmount', () => {
  it('formats with thousands separators and two decimals, no currency symbol', () => {
    expect(formatAmount(1650)).toBe('1,650.00')
    expect(formatAmount(0.5)).toBe('0.50')
    expect(formatAmount(1234567.891)).toBe('1,234,567.89')
  })
})

describe('formatReceiptDateTime', () => {
  it('formats as dd/mm/yyyy HH:mm in local time', () => {
    const iso = new Date(2026, 8, 27, 18, 58, 0).toISOString()
    expect(formatReceiptDateTime(iso)).toBe('27/09/2026 18:58')
  })

  it('pads single-digit day/month/hour/minute', () => {
    const iso = new Date(2026, 0, 5, 9, 5, 0).toISOString()
    expect(formatReceiptDateTime(iso)).toBe('05/01/2026 09:05')
  })
})

describe('wrapText', () => {
  it('returns the text unchanged when it already fits', () => {
    expect(wrapText('Coca-Cola 500ml', 32)).toEqual(['Coca-Cola 500ml'])
  })

  it('wraps on word boundaries', () => {
    expect(wrapText('Bosch AeroTwin Wipers Pair', 15)).toEqual(['Bosch AeroTwin', 'Wipers Pair'])
  })

  it('caps at maxLines, dropping the rest rather than overflowing', () => {
    const result = wrapText('one two three four five six seven eight', 5, 2)
    expect(result).toHaveLength(2)
    for (const line of result) expect(line.length).toBeLessThanOrEqual(5)
  })

  it('hard-cuts a single word longer than the width, across multiple lines, losing no characters', () => {
    const word = 'Supercalifragilisticexpialidocious'
    const result = wrapText(word, 10, 4)
    expect(result.length).toBeGreaterThan(1)
    for (const line of result) expect(line.length).toBeLessThanOrEqual(10)
    expect(result.join('')).toBe(word)
  })
})

describe('toAscii', () => {
  it('replaces curly quotes, em/en dashes and ellipsis with ASCII equivalents', () => {
    expect(toAscii('‘hi’ “there” — wait…')).toBe("'hi' \"there\" - wait...")
  })

  it('strips any other non-ASCII character', () => {
    expect(toAscii('Café Ltd')).toBe('Caf Ltd')
  })
})
