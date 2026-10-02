/**
 * `titleCaseName` (docs/phase-198-2): staff names are displayed in title case,
 * and only displayed that way. The renderer's twin must agree with the main one.
 */

import { describe, it, expect } from 'vitest'
import { titleCaseName } from '../src/main/lib/text.js'
import { titleCaseName as rendererTitleCaseName } from '../src/renderer/src/lib/text.js'
import { buildReceiptLayout, isReceiptLayoutQr } from '../src/main/lib/receiptLayout.js'
import type { ReceiptLayoutEntry, ReceiptLayoutOrder } from '../src/main/lib/receiptLayout.js'
import { buildEnjoySlip } from '../src/main/lib/enjoySlip.js'

const CASES: Array<[string, string]> = [
  ['LILIAN ANYANGO', 'Lilian Anyango'],
  ["mary-anne o'neil", "Mary-Anne O'Neil"],
  ['mary', 'Mary'],
  ['MARY', 'Mary'],
  ['  mary    wanjiku  ', 'Mary Wanjiku'],
  ['mary   wanjiku', 'Mary Wanjiku'],
  ['cashier 2', 'Cashier 2'],
  ['till3 operator', 'Till3 Operator'],
  ['Mary W.', 'Mary W.'],
  ['kamau wa njoroge', 'Kamau Wa Njoroge'],
  ['JEAN-PAUL', 'Jean-Paul'],
  ['émile zola', 'Émile Zola'],
  ['', ''],
  ['   ', '']
]

describe('titleCaseName', () => {
  it.each(CASES)('%j becomes %j', (input, expected) => {
    expect(titleCaseName(input)).toBe(expected)
  })

  it('returns an empty string for empty input', () => {
    expect(titleCaseName('')).toBe('')
  })

  it('leaves digits where they are', () => {
    expect(titleCaseName('TILL 12')).toBe('Till 12')
    expect(titleCaseName('4th shift')).toBe('4th Shift')
  })

  it('is stable: applying it twice changes nothing more', () => {
    for (const [, expected] of CASES) expect(titleCaseName(expected)).toBe(expected)
  })

  it.each(CASES)('the renderer twin agrees on %j', (input, expected) => {
    expect(rendererTitleCaseName(input)).toBe(expected)
    expect(rendererTitleCaseName(input)).toBe(titleCaseName(input))
  })
})

describe('where the slips use it', () => {
  const lines = (entries: ReceiptLayoutEntry[]): string[] =>
    entries.map((entry) => (isReceiptLayoutQr(entry) ? '[qr]' : entry.text))

  const order: ReceiptLayoutOrder = {
    localId: 7,
    createdAt: new Date(2026, 9, 2, 10, 0).toISOString(),
    cashierName: 'LILIAN ANYANGO',
    paymentMethod: 'cash',
    tenderedAmount: 100,
    changeDue: 40,
    fiscalInvoiceNumber: '0123456789012345678',
    traderInvNum: 'INV-000000007',
    total: 60,
    vatGroups: { A: '51.72' },
    items: [{ title: 'Mug', variantTitle: '', quantity: 1, unitPrice: 60, vatClass: 'A' }]
  }

  it('prints the cashier in title case on the fiscal slip and leaves the order itself alone', () => {
    const out = lines(buildReceiptLayout(order, { taxRate: 0.16, tradingName: 'ENJOY' }, { width: 48 }))

    const cashier = out.find((l) => l.startsWith('Cashier:'))
    expect(cashier).toBe('Cashier:'.padEnd(48 - 'Lilian Anyango'.length) + 'Lilian Anyango')
    expect(cashier).toHaveLength(48)
    expect(order.cashierName).toBe('LILIAN ANYANGO')
  })

  it('prints the cashier in title case on the sale record too, since it is the same line', () => {
    const out = lines(
      buildReceiptLayout({ ...order, fiscalInvoiceNumber: undefined, fiscalPending: true }, { taxRate: 0.16, tradingName: 'ENJOY' }, { width: 48 })
    )

    expect(out.find((l) => l.startsWith('Cashier:'))).toContain('Lilian Anyango')
  })

  it('prints only the first name, in title case, on the Enjoy slip', () => {
    const out = lines(buildEnjoySlip(order, {}, { width: 48, kraNote: 'printed' }))

    expect(out.some((l) => l.endsWith('Served by: Lilian'))).toBe(true)
    expect(out.some((l) => l.includes('Anyango'))).toBe(false)
  })

  it('title-cases a hyphenated first name on the Enjoy slip', () => {
    const out = lines(buildEnjoySlip({ ...order, cashierName: 'MARY-ANNE WANJIKU' }, {}, { width: 48, kraNote: 'printed' }))

    expect(out.some((l) => l.endsWith('Served by: Mary-Anne'))).toBe(true)
  })
})
