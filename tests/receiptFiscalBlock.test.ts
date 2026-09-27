/**
 * `buildFiscalBlockLines` tests (docs/phase-164).
 *
 * Pure function, shared by `printer.ts`'s `renderReceipt` (ESC/POS,
 * plain-text assertable — see `printer.test.ts`) and `pdf-receipt.ts`'s
 * `generatePdfReceipt` (PDF output, not text-assertable — see
 * `pdfReceipt.test.ts`'s own note on why). Testing it directly here
 * proves the exact line content and wording once, for both callers,
 * rather than duplicating the same assertions in two places.
 */

import { describe, it, expect } from 'vitest'
import {
  buildFiscalBlockLines,
  FISCAL_PENDING_HEADER,
  NOT_A_TAX_INVOICE_LINE
} from '../src/main/lib/receiptFiscalBlock.js'

describe('buildFiscalBlockLines', () => {
  it('returns no lines at all for an unfiled order (no fiscalInvoiceNumber)', () => {
    expect(
      buildFiscalBlockLines({
        fiscalizedAt: '27-08-2026 09:15:00',
        fiscalizedAtSource: 'device',
        cuSerial: 'CU-SERIAL-0001'
      })
    ).toEqual([])
  })

  it('prints only the invoice number when nothing else is present', () => {
    expect(buildFiscalBlockLines({ fiscalInvoiceNumber: 'KRA-0001' })).toEqual([
      'CU Invoice No: KRA-0001'
    ])
  })

  it('labels a device-sourced timestamp as "CU Date/Time"', () => {
    expect(
      buildFiscalBlockLines({
        fiscalInvoiceNumber: 'KRA-0002',
        fiscalizedAt: '27-08-2026 09:15:00',
        fiscalizedAtSource: 'device'
      })
    ).toEqual(['CU Invoice No: KRA-0002', 'CU Date/Time: 27-08-2026 09:15:00'])
  })

  it('labels a local-fallback timestamp as till time, not a device time', () => {
    expect(
      buildFiscalBlockLines({
        fiscalInvoiceNumber: 'KRA-0003',
        fiscalizedAt: '2026-08-27T09:15:00.000Z',
        fiscalizedAtSource: 'local-fallback'
      })
    ).toEqual([
      'CU Invoice No: KRA-0003',
      'Till time (device time unavailable): 2026-08-27T09:15:00.000Z'
    ])
  })

  it('labels an unknown/missing source (an order fiscalized before this phase) as till time too', () => {
    expect(
      buildFiscalBlockLines({
        fiscalInvoiceNumber: 'KRA-0004',
        fiscalizedAt: '2026-08-27T09:15:00.000Z'
      })
    ).toEqual([
      'CU Invoice No: KRA-0004',
      'Till time (device time unavailable): 2026-08-27T09:15:00.000Z'
    ])
  })

  it('omits the date/time line entirely when there is no fiscalizedAt to print', () => {
    expect(buildFiscalBlockLines({ fiscalInvoiceNumber: 'KRA-0005' })).toEqual([
      'CU Invoice No: KRA-0005'
    ])
  })

  it('prints the serial number when present', () => {
    expect(
      buildFiscalBlockLines({ fiscalInvoiceNumber: 'KRA-0006', cuSerial: 'CU-SERIAL-0006' })
    ).toEqual(['CU Invoice No: KRA-0006', 'CU Serial No: CU-SERIAL-0006'])
  })

  it('omits the serial line entirely when absent, rather than printing it blank', () => {
    const lines = buildFiscalBlockLines({ fiscalInvoiceNumber: 'KRA-0007' })
    expect(lines.some((line) => line.startsWith('CU Serial No:'))).toBe(false)
  })

  it('prints all three lines together, in order, for a full device-sourced fiscalization', () => {
    expect(
      buildFiscalBlockLines({
        fiscalInvoiceNumber: 'KRA-0008',
        fiscalizedAt: '27-08-2026 09:15:00',
        fiscalizedAtSource: 'device',
        cuSerial: 'CU-SERIAL-0008'
      })
    ).toEqual([
      'CU Invoice No: KRA-0008',
      'CU Date/Time: 27-08-2026 09:15:00',
      'CU Serial No: CU-SERIAL-0008'
    ])
  })
})

describe('buildFiscalBlockLines — not-yet-filed slip (docs/phase-165)', () => {
  it('prints the "not a tax invoice" line when fiscalPending is set and the order has no invoice number', () => {
    expect(buildFiscalBlockLines({ fiscalPending: true })).toEqual([NOT_A_TAX_INVOICE_LINE])
  })

  it('still prints nothing when fiscalPending is false and there is no invoice number', () => {
    expect(buildFiscalBlockLines({ fiscalPending: false })).toEqual([])
  })

  it('ignores fiscalPending once the order is fiscalised — the real CU block always wins', () => {
    expect(
      buildFiscalBlockLines({
        fiscalInvoiceNumber: 'KRA-0009',
        fiscalPending: true
      })
    ).toEqual(['CU Invoice No: KRA-0009'])
  })
})

describe('FISCAL_PENDING_HEADER / NOT_A_TAX_INVOICE_LINE wording (docs/phase-165)', () => {
  it('are the exact strings the brief specifies', () => {
    expect(FISCAL_PENDING_HEADER).toBe('SALE RECORD - TAX INVOICE TO FOLLOW')
    expect(NOT_A_TAX_INVOICE_LINE).toBe('Not a tax invoice')
  })
})
