/**
 * The Enjoy customer slip (docs/phase-198) and the fiscal slip's "Invoice No"
 * rule: the slip's exact content, what it must never carry, and the stored
 * trader number being the only number on either that the shop issued.
 */

import { describe, it, expect } from 'vitest'
import { buildEnjoySlip, ENJOY_SLIP_TEXT } from '../src/main/lib/enjoySlip.js'
import type { EnjoySlipKraNote } from '../src/main/lib/enjoySlip.js'
import { buildReceiptLayout, isReceiptLayoutQr } from '../src/main/lib/receiptLayout.js'
import type { ReceiptLayoutEntry, ReceiptLayoutOrder, ReceiptWidth } from '../src/main/lib/receiptLayout.js'

const CU_INVOICE = '0123456789012345678'
const CU_SERIAL = 'KRAMW0XXXXXXXXXX'
const QR_URL = 'https://itax.kra.go.ke/verify/abc123'

const ORDER: ReceiptLayoutOrder = {
  localId: 42,
  createdAt: new Date(2026, 8, 27, 18, 58, 0).toISOString(),
  cashierName: 'Mary Wanjiku',
  paymentMethod: 'cash',
  tenderedAmount: 2000,
  changeDue: 350,
  fiscalInvoiceNumber: CU_INVOICE,
  traderInvNum: 'INV-000000042',
  fiscalQrCode: QR_URL,
  fiscalizedAt: '27-09-2026 18:58:41',
  fiscalizedAtSource: 'device',
  cuSerial: CU_SERIAL,
  total: 1650,
  vatGroups: { A: '1422.41' },
  items: [
    { title: 'Coca-Cola 500ml', variantTitle: '', quantity: 2, unitPrice: 100, vatClass: 'A' },
    { title: 'Bosch AeroTwin Wipers', variantTitle: 'Pair', quantity: 1, unitPrice: 1450, vatClass: 'A' }
  ]
}

const SHOP = { locationName: 'Enjoy Westlands', address: 'Waiyaki Way, Nairobi' }

const slip = (
  order: ReceiptLayoutOrder = ORDER,
  kraNote: EnjoySlipKraNote = 'printed',
  width: ReceiptWidth = 48,
  shop: { locationName?: string; address?: string } = SHOP
): ReceiptLayoutEntry[] => buildEnjoySlip(order, shop, { width, kraNote })

const texts = (entries: ReceiptLayoutEntry[]): string[] =>
  entries.map((entry) => (isReceiptLayoutQr(entry) ? `[QR ${entry.qr}]` : entry.text))

const RULE = '-'.repeat(48)

describe('buildEnjoySlip: the agreed layout', () => {
  it('prints a cash sale exactly as designed, with the KRA invoice printed separately', () => {
    expect(texts(slip())).toEqual([
      'E N J O Y',
      'Enjoy Westlands',
      'Waiyaki Way, Nairobi',
      RULE,
      '27 Sep 2026 18:58                Served by: Mary',
      'Receipt INV-000000042',
      RULE,
      'COCA-COLA 500ML              2 x 100.00   200.00',
      'BOSCH AEROTWIN WIPERS    1 x 1,450.00   1,450.00',
      RULE,
      'TOTAL                               KSh 1,650.00',
      'Paid by cash                        KSh 2,000.00',
      'Change                                KSh 350.00',
      RULE,
      'Thanks for stopping by!',
      'We hope you enjoyed your visit.',
      'See you again soon.',
      'Your KRA tax invoice is printed separately.'
    ])
  })

  it('heads the slip in double size and bolds the total', () => {
    const entries = slip() as Array<{ text: string; style: string; align: string }>

    expect(entries[0]).toMatchObject({ text: 'E N J O Y', style: 'double', align: 'centre' })
    expect(entries.find((e) => e.text.startsWith('TOTAL'))?.style).toBe('bold')
  })

  it('says the tax invoice will follow, and to keep the receipt, for a sale not yet filed', () => {
    const pending = {
      ...ORDER,
      fiscalInvoiceNumber: undefined,
      fiscalQrCode: undefined,
      cuSerial: undefined,
      paymentMethod: 'mpesa' as const
    }

    const lines = texts(slip(pending, 'pending'))

    expect(lines.slice(-3)).toEqual(['See you again soon.', 'Your KRA tax invoice will follow.', 'Please keep this receipt.'])
    expect(lines).not.toContain(ENJOY_SLIP_TEXT.kraPrinted)
  })

  it('prints no KRA line, and no keep-the-receipt line, when the fiscal slip did not reach paper', () => {
    const lines = texts(slip(ORDER, 'none'))

    expect(lines).not.toContain(ENJOY_SLIP_TEXT.kraPrinted)
    expect(lines).not.toContain('Your KRA tax invoice will follow.')
    expect(lines).not.toContain('Please keep this receipt.')
    expect(lines.at(-1)).toBe('See you again soon.')
  })

  it('says "Paid by M-Pesa" with no change row', () => {
    const lines = texts(slip({ ...ORDER, paymentMethod: 'mpesa', tenderedAmount: 0, changeDue: 0 }))

    expect(lines).toContain('Paid by M-Pesa                      KSh 1,650.00')
    expect(lines.some((l) => l.startsWith('Change'))).toBe(false)
  })

  it('says "Paid by card" with no change row', () => {
    const lines = texts(slip({ ...ORDER, paymentMethod: 'card', tenderedAmount: 0, changeDue: 0 }))

    expect(lines).toContain('Paid by card                        KSh 1,650.00')
    expect(lines.some((l) => l.startsWith('Change'))).toBe(false)
  })

  it('leaves out the Receipt line when no trader number was stored', () => {
    const lines = texts(slip({ ...ORDER, traderInvNum: undefined }))

    expect(lines.some((l) => l.startsWith('Receipt'))).toBe(false)
    expect(lines[4]).toContain('Served by: Mary')
  })

  it('leaves out the location and address lines when they are not set', () => {
    const lines = texts(slip(ORDER, 'printed', 48, {}))

    expect(lines.slice(0, 2)).toEqual(['E N J O Y', RULE])
  })

  it('shows a line discount in that line, and a cart discount as one row, so the page adds up', () => {
    const discounted: ReceiptLayoutOrder = {
      ...ORDER,
      total: 1490,
      items: [
        { title: 'Coca-Cola 500ml', variantTitle: '', quantity: 2, unitPrice: 100, discount: { type: 'percent', value: 10 } },
        { title: 'Bosch AeroTwin Wipers', variantTitle: '', quantity: 1, unitPrice: 1450 }
      ]
    }

    const lines = texts(slip(discounted))

    expect(lines).toContain('COCA-COLA 500ML              2 x 100.00   180.00')
    expect(lines.find((l) => l.startsWith('Discount'))).toBe('Discount                             -KSh 140.00')
    expect(lines.find((l) => l.startsWith('TOTAL'))).toContain('KSh 1,490.00')
  })

  it('stamps DUPLICATE at the top and the bottom of a reprint, and nowhere on an original', () => {
    const reprint = texts(slip({ ...ORDER, isDuplicate: true }))

    expect(reprint[0]).toBe('*** DUPLICATE ***')
    expect(reprint.at(-1)).toBe('*** DUPLICATE ***')
    expect(texts(slip()).some((l) => l.includes('DUPLICATE'))).toBe(false)
  })

  it.each([42, 32] as const)('never prints a line wider than the printer at %d characters', (width) => {
    const long: ReceiptLayoutOrder = {
      ...ORDER,
      items: [{ title: 'An extremely long product name that cannot share a row', variantTitle: '', quantity: 12, unitPrice: 1234.5 }]
    }

    for (const entry of slip(long, 'pending', width) as Array<{ text: string; style: string }>) {
      const columns = entry.style === 'double' ? entry.text.length * 2 : entry.text.length
      expect(columns).toBeLessThanOrEqual(width)
    }
  })
})

describe('buildEnjoySlip: what it must never carry', () => {
  const printed = (kraNote: EnjoySlipKraNote): string => texts(slip(ORDER, kraNote)).join('\n')

  it.each(['printed', 'pending', 'none'] as const)('has no control unit number, serial, QR or VAT table (%s)', (kraNote) => {
    const all = printed(kraNote)

    expect(all).not.toContain(CU_INVOICE)
    expect(all).not.toContain(CU_SERIAL)
    expect(all).not.toContain(QR_URL)
    expect(all).not.toMatch(/\bCU\b/)
    expect(all).not.toMatch(/serial/i)
    expect(all).not.toMatch(/\bQR\b/)
    expect(all).not.toMatch(/\bVAT\b/i)
    expect(slip(ORDER, kraNote).some(isReceiptLayoutQr)).toBe(false)
  })

  it('carries the trader number as its only number from the fiscal side', () => {
    const all = printed('printed')

    expect(all).toContain('Receipt INV-000000042')
    expect(all).not.toContain(ORDER.fiscalizedAt as string)
  })

  it('never prints a CU number on an order that has no trader number either', () => {
    const all = texts(slip({ ...ORDER, traderInvNum: undefined })).join('\n')

    expect(all).not.toContain(CU_INVOICE)
  })
})

describe('buildEnjoySlip: the wording lives in one object', () => {
  it('prints the thank-you lines from ENJOY_SLIP_TEXT, so changing one changes the slip', () => {
    const original = ENJOY_SLIP_TEXT.thanks[0]
    const mutable = ENJOY_SLIP_TEXT as unknown as { thanks: string[]; brand: string }
    try {
      mutable.thanks[0] = 'Come again!'
      mutable.brand = 'E N J O Y +'

      const lines = texts(slip())

      expect(lines[0]).toBe('E N J O Y +')
      expect(lines).toContain('Come again!')
      expect(lines).not.toContain(original)
    } finally {
      mutable.thanks[0] = original
      mutable.brand = 'E N J O Y'
    }
  })
})

describe('the fiscal slip: Invoice No is the stored trader number', () => {
  const SETTINGS = { taxRate: 0.16, tradingName: 'ENJOY' }
  const rows = (order: ReceiptLayoutOrder): string[] => texts(buildReceiptLayout(order, SETTINGS, { width: 48 }))

  it('prints Invoice No from traderInvNum and, separately, CU Invoice No from the control unit', () => {
    const lines = rows(ORDER)

    expect(lines.find((l) => l.startsWith('Invoice No:'))).toContain('INV-000000042')
    expect(lines.find((l) => l.startsWith('Invoice No:'))).not.toContain(CU_INVOICE)
    expect(lines.find((l) => l.startsWith('CU Invoice No:'))).toContain(CU_INVOICE)
  })

  it('omits the Invoice No row for an order with no stored value, and never rebuilds it from the CU number or the id', () => {
    const lines = rows({ ...ORDER, traderInvNum: undefined })

    expect(lines.some((l) => l.startsWith('Invoice No:'))).toBe(false)
    expect(lines.find((l) => l.startsWith('CU Invoice No:'))).toContain(CU_INVOICE)
    expect(lines.join('\n')).not.toContain('INV-')
  })

  it('still prints "Sale No" for a sale not yet filed', () => {
    const lines = rows({ ...ORDER, fiscalInvoiceNumber: undefined, fiscalPending: true })

    expect(lines.find((l) => l.startsWith('Sale No:'))).toContain('42')
    expect(lines.some((l) => l.startsWith('Invoice No:'))).toBe(false)
  })

  it('keeps the labels it always had', () => {
    expect(rows(ORDER)).toContain('FISCAL RECEIPT')
    expect(rows({ ...ORDER, isDuplicate: true })).toContain('*** DUPLICATE ***')
  })
})
