/**
 * Chunk 1 — ground-truth wire fixtures (docs/phase-audit.md).
 *
 * These fixtures are AUTHORED, not captured live — each file's own
 * header comment says so and cites the source it was built from
 * (tremol-contract.json's field names/order/types, the protocol PDF's
 * documented semantics, and fp_core.js's confirmed ENVELOPE_A skin +
 * error-nesting shape). They exist because a live capture for every
 * command isn't reachable yet (Code 31/19 block the device session),
 * but per this project's anti-circularity rule (brief §0 rule 3) they
 * must still trace to a primary source rather than to this codebase's
 * own parser — so every field name below is cross-checked against
 * `tremol-contract.json` directly, not against what `parseXmlResponse`
 * happens to produce.
 *
 * `parseXmlResponse` itself is exercised here as the actual production
 * parser (`xml-utils.ts`) — this proves the fixtures are well-formed
 * and that our parser reads the confirmed field names correctly, not
 * that our parser is "correct" in some circular sense.
 *
 * Note on the vendor JS client's scalar-vs-object behavior (brief
 * §4.2): the vendor's `fp_core.js#analyzeResponse` returns a bare
 * scalar for a single-child response (e.g. ReadDateTime) and an object
 * otherwise. This codebase's own `parseXmlResponse` (`xml-utils.ts`)
 * does NOT replicate that rule — it always returns a flat
 * `Record<string, string>`, by design (phase 60 explicitly did not
 * adopt the vendor JS runtime). So no test here asserts scalar output;
 * that distinction only matters if a future phase adopts the vendor
 * client itself.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseXmlResponse } from '../src/main/services/integrations/xml-utils.js'

const WIRE_DIR = join(__dirname, 'fixtures', 'wire')

function readWireFixture(name: string): string {
  return readFileSync(join(WIRE_DIR, name), 'utf8')
}

describe('success-ack.xml', () => {
  it('parses as bare Code 0 with no data fields', () => {
    const parsed = parseXmlResponse(readWireFixture('success-ack.xml'))
    expect(parsed.code).toBe('0')
    expect(Object.keys(parsed)).toEqual(['code'])
  })
})

describe('readstatus-fiscalized-full.xml', () => {
  const parsed = parseXmlResponse(readWireFixture('readstatus-fiscalized-full.xml'))

  it('parses as Code 0', () => {
    expect(parsed.code).toBe('0')
  })

  it('carries all 22 named status flags from the contract', () => {
    const ALL_22_FLAGS = [
      'Power_down_in_opened_fiscal_receipt',
      'DateTime_not_set',
      'DateTime_wrong',
      'RAM_reset',
      'Hardware_clock_error',
      'Reports_registers_Overflow',
      'Opened_Fiscal_Receipt',
      'Receipt_Invoice_Type',
      'SD_card_near_full',
      'SD_card_full',
      'CU_fiscalized',
      'CU_produced',
      'Paired_with_TIMS',
      'Unsent_receipts',
      'Service_contract_nearly_expired',
      'No_Sec_IC',
      'No_certificates',
      'Service_jumper',
      'Expired_service_contract',
      'Missing_SD_card',
      'Wrong_SD_card',
      'Update_is_available'
    ]
    for (const flag of ALL_22_FLAGS) {
      expect(parsed[flag], `missing flag ${flag}`).toBeDefined()
    }
  })

  it('sets exactly CU_fiscalized, CU_produced, Paired_with_TIMS to 1', () => {
    expect(parsed.CU_fiscalized).toBe('1')
    expect(parsed.CU_produced).toBe('1')
    expect(parsed.Paired_with_TIMS).toBe('1')

    const oneValuedFlags = Object.entries(parsed).filter(
      ([key, value]) => key !== 'code' && value === '1'
    )
    expect(oneValuedFlags.map(([key]) => key).sort()).toEqual(
      ['CU_fiscalized', 'CU_produced', 'Paired_with_TIMS'].sort()
    )
  })
})

describe('readcurrentreceiptinfo-ok.xml', () => {
  const parsed = parseXmlResponse(readWireFixture('readcurrentreceiptinfo-ok.xml'))

  it('parses as Code 0 with an open receipt (OptionIsReceiptOpened, the contract name)', () => {
    expect(parsed.code).toBe('0')
    expect(parsed.OptionIsReceiptOpened).toBe('1')
  })

  it('sums the five VAT-group subtotals to 120.00', () => {
    const subtotal =
      Number(parsed.SubtotalAmountVATGA) +
      Number(parsed.SubtotalAmountVATGB) +
      Number(parsed.SubtotalAmountVATGC) +
      Number(parsed.SubtotalAmountVATGD) +
      Number(parsed.SubtotalAmountVATGE)
    expect(subtotal).toBeCloseTo(120.0)
  })
})

describe('closereceipt-ok.xml', () => {
  const parsed = parseXmlResponse(readWireFixture('closereceipt-ok.xml'))

  it('parses as Code 0 with a 19-digit InvoiceNum and a 128-char QRcode', () => {
    expect(parsed.code).toBe('0')
    expect(parsed.InvoiceNum).toMatch(/^\d{19}$/)
    expect(parsed.QRcode).toHaveLength(128)
  })
})

describe('readdatetime-ok.xml', () => {
  it('parses as Code 0 with a dd-MM-yyyy HH:mm:ss DateTime', () => {
    const parsed = parseXmlResponse(readWireFixture('readdatetime-ok.xml'))
    expect(parsed.code).toBe('0')
    expect(parsed.DateTime).toMatch(/^\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2}$/)
  })
})

describe('readcuinvoicenumber-ok.xml', () => {
  it('parses as Code 0 with a 19-digit CU_InvoiceNumber (Option is hardcoded, present but unused)', () => {
    const parsed = parseXmlResponse(readWireFixture('readcuinvoicenumber-ok.xml'))
    expect(parsed.code).toBe('0')
    expect(parsed.CU_InvoiceNumber).toMatch(/^\d{19}$/)
  })
})

describe('readcunumbers-ok.xml', () => {
  it('parses as Code 0 with SerialNumber (≤20 chars) and PINnumber (≤11 chars) — finding #3, phase-67', () => {
    const parsed = parseXmlResponse(readWireFixture('readcunumbers-ok.xml'))
    expect(parsed.code).toBe('0')
    expect(parsed.SerialNumber).toBeTruthy()
    expect(parsed.SerialNumber.length).toBeLessThanOrEqual(20)
    expect(parsed.PINnumber).toBeTruthy()
    expect(parsed.PINnumber.length).toBeLessThanOrEqual(11)
  })
})

describe('code53-settingsmissing.xml', () => {
  it('parses as a Server-sourced Code 53', () => {
    const parsed = parseXmlResponse(readWireFixture('code53-settingsmissing.xml'))
    expect(parsed.code).toBe('53')
    expect(parsed.errSource).toBe('Server')
    expect(parsed.Message).toMatch(/settings/i)
  })
})

describe('code40-invoicenotfound.xml', () => {
  it('parses as Code 40 with STE1/STE2/FPLibErrorCode extracted as raw hex (phase-69, finding 4.1b)', () => {
    const parsed = parseXmlResponse(readWireFixture('code40-invoicenotfound.xml'))
    expect(parsed.code).toBe('40')
    // `STE1`/`STE2`/`FPLibErrorCode` are attributes on <Err …>, e.g.
    // `<Err … STE1="30" STE2="3a" FPLibErrorCode="00">` — xml-utils.ts's
    // dedicated Err-attribute extraction pass (added phase-69) now reads
    // them, as the raw hex strings the wire sends (no radix conversion
    // here — that's `real-etims-provider.ts#checkDeviceResponse`'s job,
    // per fp_core.js:71-75's own `parseInt(x, 16)`).
    expect(parsed.STE1).toBe('30')
    expect(parsed.STE2).toBe('3a')
    expect(parsed.FPLibErrorCode).toBe('00')
  })
})

describe('code19-opensocket.xml', () => {
  it('parses as a Server-sourced Code 19 in the canonical (non-anomalous) shape', () => {
    const parsed = parseXmlResponse(readWireFixture('code19-opensocket.xml'))
    expect(parsed.code).toBe('19')
    expect(parsed.errSource).toBe('Server')
    expect(parsed.Message).toMatch(/open socket/i)
  })

  it('differs in shape from the real, anomalous live capture (VERIFY-ON-DEVICE, phase-audit.md 4.6)', () => {
    const liveCapture = parseXmlResponse(readWireFixture('readstatus-live-captured-code19.xml'))
    // The real capture carries errSource directly as a <Res> attribute
    // with no <Err> element at all — our parser's errSource regex only
    // looks for Source= on <Err>, so it does NOT populate errSource here.
    expect(liveCapture.code).toBe('19')
    expect(liveCapture.errSource).toBeUndefined()
  })
})
