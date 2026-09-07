/**
 * Ground-truth fixture tests (Test-Hardening Phase T1, Items 1–2; Item 4
 * length-cap cross-checks added in Phase 60).
 *
 * `tests/fixtures/tremol-contract.json` is a machine-readable summary of
 * the vendor's own protocol definition — as of Phase 60, extracted
 * verbatim from the authoritative `ZFP_SDK_KE_2509041522_ControlUnit`
 * package's `Libs/JS/fp.js` (`var defs = '<Defs>…</Defs>'`, the shipping
 * JS client's own defs blob) by `scripts/extract-tremol-contract.mjs`,
 * not hand-typed. `tests/fixtures/tremol-defs.xml` is that same `<Defs>`
 * block, unescaped from its source-language string-literal form, so the
 * JSON can be regenerated and diffed against a future vendor SDK update
 * (the script also still supports the older `FP.cs`-style C# source, for
 * whichever file a future update actually ships).
 *
 * `tests/fixtures/wire/*.xml` are real responses captured against the
 * running ZFPLabServer + Control Unit (or, for the healthy-ReadStatus
 * case, the VIL G03 manual's own documented example) — not paraphrased,
 * not invented. Phase 56's post-mortem is explicit about why this
 * distinction matters: the "SubTotal" bug that broke every real invoice
 * for five phases survived because every test mocked a response shape
 * the test author invented to match the code, rather than a response
 * shape sourced from the vendor. Every test that needs a Tremol response
 * from here on must build it from one of these two fixture sources —
 * see `tremolConformance.test.ts` for the guard that enforces this going
 * forward.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseXmlResponse } from '../src/main/services/integrations/xml-utils.js'
import {
  MAX_ADDRESS_FIELD_LENGTH,
  MAX_CLIENT_PIN_LENGTH,
  MAX_COMPANY_NAME_LENGTH,
  MAX_HS_CODE_LENGTH,
  MAX_HS_NAME_LENGTH,
  MAX_MEASURE_UNIT_LENGTH,
  MAX_NAME_PLU_LENGTH,
  MAX_PRICE_LENGTH,
  MAX_RELATED_INVOICE_NUM_LENGTH,
  MAX_TRADER_SYSTEM_INV_NUM_LENGTH
} from '../src/main/services/integrations/real-etims-provider.js'

const FIXTURES_DIR = join(__dirname, 'fixtures')
const WIRE_DIR = join(FIXTURES_DIR, 'wire')

interface TremolContractField {
  name: string
  type: string
  maxLen?: number
  byte?: number
  bit?: number
}

interface TremolContractArg extends TremolContractField {
  value?: string
  compulsory: boolean
}

interface TremolCommandContract {
  cmdByte: string
  operation: string
  args: TremolContractArg[]
  response: TremolContractField[]
}

interface TremolContract {
  generatedFrom: string
  commandCount: number
  commands: Record<string, TremolCommandContract>
}

function loadContract(): TremolContract {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'tremol-contract.json'), 'utf8'))
}

function readWireFixture(name: string): string {
  return readFileSync(join(WIRE_DIR, name), 'utf8')
}

describe('tremol-contract.json (Item 1)', () => {
  const contract = loadContract()

  it('was generated from the vendor SDK, not hand-authored', () => {
    expect(contract.generatedFrom).toMatch(/Tremol vendor SDK/i)
  })

  it('reports a command count matching its own commands map', () => {
    expect(contract.commandCount).toBe(Object.keys(contract.commands).length)
    expect(contract.commandCount).toBeGreaterThan(50)
  })

  it.each([
    'ReadStatus',
    'OpenInvoiceWithFreeCustomerData',
    'SellPLUfromExtDB',
    'ReadCurrentReceiptInfo',
    'CloseReceipt',
    'CancelReceipt',
    'ReadDateTime'
  ])('includes a non-empty definition for %s', (commandName) => {
    const command = contract.commands[commandName]
    expect(command).toBeDefined()
    // A definition is "non-empty" when it carries a real CmdByte and a
    // real operation description. Args/response length alone can't
    // gate this: CancelReceipt legitimately declares neither (per the
    // vendor spec, it takes no arguments and returns nothing).
    expect(command.cmdByte.length).toBeGreaterThan(0)
    expect(command.operation.length).toBeGreaterThan(0)
  })

  it("captures OpenInvoiceWithFreeCustomerData's seven customer-data args, in the vendor's declared order", () => {
    const argNames = contract.commands.OpenInvoiceWithFreeCustomerData.args.map((a) => a.name)
    expect(argNames).toEqual([
      'reserved',
      'reserved',
      'reserved',
      'InvoiceType',
      'CompanyName',
      'ClientPINnum',
      'HeadQuarters',
      'Address',
      'PostalCodeAndCity',
      'ExemptionNum',
      'TraderSystemInvNum'
    ])
  })

  it('captures ReadCurrentReceiptInfo\'s per-VAT-group subtotal fields — never a single "SubTotal"', () => {
    const responseNames = contract.commands.ReadCurrentReceiptInfo.response.map((r) => r.name)
    expect(responseNames).toEqual(
      expect.arrayContaining([
        'OptionIsReceiptOpened',
        'SubtotalAmountVATGA',
        'SubtotalAmountVATGB',
        'SubtotalAmountVATGC',
        'SubtotalAmountVATGD',
        'SubtotalAmountVATGE'
      ])
    )
    expect(responseNames).not.toContain('SubTotal')
    expect(responseNames).not.toContain('Subtotal')
  })

  it('captures ReadStatus\'s named status bits — never a "Connected"/"Fiscalized" field', () => {
    const responseNames = contract.commands.ReadStatus.response.map((r) => r.name)
    expect(responseNames).toEqual(
      expect.arrayContaining(['CU_fiscalized', 'Paired_with_TIMS'])
    )
    expect(responseNames).not.toContain('Connected')
    expect(responseNames).not.toContain('Fiscalized')
    expect(responseNames).not.toContain('OptionIsReceiptOpened')
  })

  it('captures CloseReceipt\'s InvoiceNum/QRcode response fields', () => {
    expect(contract.commands.CloseReceipt.response.map((r) => r.name)).toEqual([
      'InvoiceNum',
      'QRcode'
    ])
  })

  it('does not include a plain "OpenCreditNote" command — only the *WithFreeCustomerData variant', () => {
    expect(contract.commands.OpenCreditNote).toBeUndefined()
    expect(contract.commands.OpenCreditNoteWithFreeCustomerData).toBeDefined()
  })
})

describe('tremol-defs.xml (Item 1)', () => {
  it('is well-formed enough to round-trip through the contract extraction', () => {
    const xml = readFileSync(join(FIXTURES_DIR, 'tremol-defs.xml'), 'utf8')
    expect(xml.startsWith('<Defs>')).toBe(true)
    expect(xml.trim().endsWith('</Defs>')).toBe(true)
    // The vendor's C# verbatim-string escaping doubles every literal
    // quote (`""1252""`), which unescapes to a normal, single-quoted
    // attribute (`"1252"`). A real *empty* attribute (`Value=""`) is
    // valid XML and must NOT be mistaken for a leftover escape — so the
    // check here is for a known escaped example surviving unescaped,
    // not for the mere absence of `""` anywhere in the file.
    expect(xml).toContain('CodePage="1252"')
    expect(xml).not.toContain('CodePage=""1252""')
  })
})

describe('wire fixtures (Item 2)', () => {
  it('settings-ok.xml parses as Code 0 with the settings echoed back', () => {
    const parsed = parseXmlResponse(readWireFixture('settings-ok.xml'))
    expect(parsed.code).toBe('0')
    expect(parsed.ip).toBe('154.79.253.236')
    expect(parsed.port).toBe('8000')
    expect(parsed.clientID).toBe('Localhost')
  })

  it('readstatus-code31-authfail.xml parses as a Server-sourced Code 31', () => {
    const parsed = parseXmlResponse(readWireFixture('readstatus-code31-authfail.xml'))
    expect(parsed.code).toBe('31')
    expect(parsed.errSource).toBe('Server')
    expect(parsed.Message).toMatch(/password authentication/i)
  })

  it('code30-socketfail.xml parses as a Server-sourced Code 30', () => {
    const parsed = parseXmlResponse(readWireFixture('code30-socketfail.xml'))
    expect(parsed.code).toBe('30')
    expect(parsed.errSource).toBe('Server')
    expect(parsed.Message).toMatch(/socket connect failed/i)
  })

  it('code63-invalidpost.xml parses as a Server-sourced Code 63', () => {
    const parsed = parseXmlResponse(readWireFixture('code63-invalidpost.xml'))
    expect(parsed.code).toBe('63')
    expect(parsed.errSource).toBe('Server')
    expect(parsed.Message).toMatch(/root element is missing/i)
  })

  it('readstatus-ok-healthy.xml parses as Code 0 with a fiscalized, TIMS-paired device', () => {
    const parsed = parseXmlResponse(readWireFixture('readstatus-ok-healthy.xml'))
    expect(parsed.code).toBe('0')
    expect(parsed.CU_fiscalized).toBe('1')
    expect(parsed.Paired_with_TIMS).toBe('1')
    expect(parsed.Power_down_in_opened_fiscal_receipt).toBe('0')
  })
})

/**
 * Item 4 cross-check: no length cap the provider applies may be
 * *shorter* than the official maxLen for that field — a cap can be
 * absent (as `Price`'s is, deliberately — see `MAX_PRICE_LENGTH`'s doc
 * comment) or longer, but never tighter than what the vendor's own
 * definition allows, or a legitimately long value would be silently
 * truncated before it ever reaches the wire.
 */
describe('provider length caps vs tremol-contract.json (Item 4)', () => {
  const contract = loadContract()

  function argMaxLen(commandName: string, argName: string): number {
    const arg = contract.commands[commandName]?.args.find((a) => a.name === argName)
    if (arg?.maxLen === undefined) {
      throw new Error(`No maxLen recorded for ${commandName}.${argName} in tremol-contract.json`)
    }
    return arg.maxLen
  }

  it.each([
    ['OpenInvoiceWithFreeCustomerData.CompanyName', 'OpenInvoiceWithFreeCustomerData', 'CompanyName', MAX_COMPANY_NAME_LENGTH],
    ['OpenInvoiceWithFreeCustomerData.ClientPINnum', 'OpenInvoiceWithFreeCustomerData', 'ClientPINnum', MAX_CLIENT_PIN_LENGTH],
    ['OpenInvoiceWithFreeCustomerData.HeadQuarters', 'OpenInvoiceWithFreeCustomerData', 'HeadQuarters', MAX_ADDRESS_FIELD_LENGTH],
    ['OpenInvoiceWithFreeCustomerData.Address', 'OpenInvoiceWithFreeCustomerData', 'Address', MAX_ADDRESS_FIELD_LENGTH],
    ['OpenInvoiceWithFreeCustomerData.PostalCodeAndCity', 'OpenInvoiceWithFreeCustomerData', 'PostalCodeAndCity', MAX_ADDRESS_FIELD_LENGTH],
    ['OpenInvoiceWithFreeCustomerData.ExemptionNum', 'OpenInvoiceWithFreeCustomerData', 'ExemptionNum', MAX_ADDRESS_FIELD_LENGTH],
    ['OpenInvoiceWithFreeCustomerData.TraderSystemInvNum', 'OpenInvoiceWithFreeCustomerData', 'TraderSystemInvNum', MAX_TRADER_SYSTEM_INV_NUM_LENGTH],
    ['SellPLUfromExtDB.NamePLU', 'SellPLUfromExtDB', 'NamePLU', MAX_NAME_PLU_LENGTH],
    ['SellPLUfromExtDB.MeasureUnit', 'SellPLUfromExtDB', 'MeasureUnit', MAX_MEASURE_UNIT_LENGTH],
    ['SellPLUfromExtDB.HSCode', 'SellPLUfromExtDB', 'HSCode', MAX_HS_CODE_LENGTH],
    ['SellPLUfromExtDB.HSName', 'SellPLUfromExtDB', 'HSName', MAX_HS_NAME_LENGTH],
    ['SellPLUfromExtDB.Price', 'SellPLUfromExtDB', 'Price', MAX_PRICE_LENGTH],
    ['SellPLUfromExtDB_HS.Price', 'SellPLUfromExtDB_HS', 'Price', MAX_PRICE_LENGTH],
    ['OpenCreditNoteWithFreeCustomerData.RelatedInvoiceNum', 'OpenCreditNoteWithFreeCustomerData', 'RelatedInvoiceNum', MAX_RELATED_INVOICE_NUM_LENGTH],
    ['OpenCreditNoteWithFreeCustomerData.TraderSystemInvNum', 'OpenCreditNoteWithFreeCustomerData', 'TraderSystemInvNum', MAX_TRADER_SYSTEM_INV_NUM_LENGTH]
  ] as const)('%s: provider cap is not shorter than the official maxLen', (_label, commandName, argName, providerCap) => {
    const officialMaxLen = argMaxLen(commandName, argName)
    expect(providerCap).toBeGreaterThanOrEqual(officialMaxLen)
  })

  it("SellPLUfromExtDB.Price's official maxLen is 15, matching MAX_PRICE_LENGTH exactly", () => {
    expect(argMaxLen('SellPLUfromExtDB', 'Price')).toBe(15)
    expect(MAX_PRICE_LENGTH).toBe(15)
  })

  it("ReadCurrentReceiptInfo's VAT-group subtotal fields are maxLen 13 in the official contract", () => {
    const response = contract.commands.ReadCurrentReceiptInfo.response
    for (const field of [
      'SubtotalAmountVATGA',
      'SubtotalAmountVATGB',
      'SubtotalAmountVATGC',
      'SubtotalAmountVATGD',
      'SubtotalAmountVATGE'
    ]) {
      const res = response.find((r) => r.name === field)
      expect(res?.maxLen).toBe(13)
    }
  })

  it("Subtotal's DiscAddV arg and SubtotalValue response field are maxLen 13 in the official contract", () => {
    const discAddV = contract.commands.Subtotal.args.find((a) => a.name === 'DiscAddV')
    const subtotalValue = contract.commands.Subtotal.response.find((r) => r.name === 'SubtotalValue')
    expect(discAddV?.maxLen).toBe(13)
    expect(subtotalValue?.maxLen).toBe(13)
  })
})
