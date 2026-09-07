/**
 * Tremol conformance guard (Test-Hardening Phase T1, Item 3).
 *
 * This is the test that Phase 56's post-mortem says should have existed
 * from Phase 45 onward: it drives the *real* `RealFiscalizationProvider`
 * (no hand-rolled request), captures every command it actually posts to
 * the wire, and checks each one against `tests/fixtures/tremol-contract.json`
 * — the vendor's own protocol definition, extracted mechanically from
 * `FP.cs`, not retyped by a developer trying to remember field names.
 *
 * Two directions are checked:
 *
 *   (a) Outgoing: every `<Command Name="X">` the provider builds must
 *       name a real vendor command, and every `<Arg Name="k">` inside it
 *       must be a real argument of that command. This catches a typo'd
 *       or invented command/argument name before it reaches a device.
 *   (b) Incoming: every response field the provider's control flow
 *       actually branches on must be a real field the vendor's contract
 *       says that command returns. This is the direction that would
 *       have caught the `SubTotal` bug (`ReadCurrentReceiptInfo` never
 *       returns a field by that name) and the `Connected`/`Fiscalized`
 *       bug (`ReadStatus` never returns fields by those names) — both
 *       shipped for multiple phases because nothing checked the fields
 *       being read against anything but the tests' own invented mocks.
 *
 * If either check fails, that is a genuine finding about the current
 * provider, and the right response is to report it and stop for review
 * — not to loosen the contract or the assertions to make the failure go
 * away. `cancelInvoice`'s command name was exactly such a finding
 * (Phase 58 quarantined it as a known gap; Phase 60 closed it once the
 * authoritative vendor SDK gave the real 8-field
 * `OpenCreditNoteWithFreeCustomerData` shape — see the bottom of this
 * file).
 */

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AxiosInstance } from 'axios'
import { RealFiscalizationProvider } from '../src/main/services/integrations/real-etims-provider.js'
import type { FiscalInvoiceRequest } from '../src/main/services/integrations/etims.js'

/**
 * Device details every construction here supplies — the provider has no
 * defaults for ip/port/password by design, and without them
 * `submitInvoice` short-circuits before sending a single command.
 */
const TEST_DEVICE = {
  deviceIp: '192.168.1.50',
  devicePort: '8000',
  password: 'test-device-password'
} as const

interface TremolContractField {
  name: string
}

interface TremolCommandContract {
  args: TremolContractField[]
  response: TremolContractField[]
}

interface TremolContract {
  commands: Record<string, TremolCommandContract>
}

const contract: TremolContract = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'tremol-contract.json'), 'utf8')
)

/** One `<Command Name="X">…</Command>` body, decomposed for conformance checking. */
interface CapturedCommand {
  name: string
  argNames: string[]
}

/** Parses a posted `<Command Name="X">` body into its name and argument names, in order. */
function parseCommandBody(body: string): CapturedCommand {
  const name = /<Command\s+Name="([^"]*)"/.exec(body)?.[1] ?? ''
  const argNames = [...body.matchAll(/<Arg\s+Name="([^"]*)"/g)].map((m) => m[1])
  return { name, argNames }
}

/** Records every `<Command>` body posted to a mock `axios.post`, alongside its parsed response. */
function makeRecordingClient(
  responseFor: (command: string) => string
): { client: AxiosInstance; captured: CapturedCommand[] } {
  const captured: CapturedCommand[] = []
  const post = vi.fn().mockImplementation((_path: string, body: string) => {
    const parsed = parseCommandBody(body)
    captured.push(parsed)
    return Promise.resolve({ data: responseFor(parsed.name) })
  })
  const get = vi.fn().mockResolvedValue({ data: '<Res Code="0"/>' })
  const client = { post, get, defaults: { baseURL: 'http://localhost:4444/' } } as unknown as AxiosInstance
  return { client, captured }
}

/** A realistic response per command, healthy enough to drive `submitInvoice` end to end. */
function healthyResponseFor(command: string): string {
  switch (command) {
    case 'ReadStatus':
      return '<Res Code="0"><Res Name="CU_fiscalized" Value="1"/><Res Name="Paired_with_TIMS" Value="1"/></Res>'
    case 'ReadCurrentReceiptInfo':
      return '<Res Code="0"><OptionIsReceiptOpened>1</OptionIsReceiptOpened><SubtotalAmountVATGA>219.20</SubtotalAmountVATGA></Res>'
    case 'CloseReceipt':
      return '<Res Code="0"><InvoiceNum>KRA-0001</InvoiceNum><QRcode>base64qr</QRcode></Res>'
    case 'ReadDateTime':
      return '<Res Code="0"><DateTime>01-01-2026 09:30</DateTime></Res>'
    default:
      return '<Res Code="0"/>'
  }
}

const SAMPLE_REQUEST: FiscalInvoiceRequest = {
  clientOrderUuid: '11111111-2222-3333-4444-555555555555',
  items: [
    { description: 'Bread', quantity: 2, unitPrice: 60, taxRate: 0.16 },
    {
      description: 'Maize Flour',
      quantity: 1,
      unitPrice: 150,
      taxRate: 0,
      vatClass: 'C',
      hsCode: '1102.20.00',
      hsName: 'Maize flour'
    }
  ],
  total: 270,
  taxAmount: 19.2,
  paymentMethod: 'cash'
}

describe('Outgoing conformance — every posted <Command>/<Arg> is a real vendor name', () => {
  it('the happy-path submitInvoice run posts only contract-defined commands and args', async () => {
    const { client, captured } = makeRecordingClient(healthyResponseFor)
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: client })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(true)
    expect(captured.length).toBeGreaterThan(0)

    const offenses: string[] = []
    for (const { name, argNames } of captured) {
      const commandContract = contract.commands[name]
      if (!commandContract) {
        offenses.push(`Command "${name}" does not exist in the vendor contract`)
        continue
      }
      const allowedArgNames = new Set(commandContract.args.map((a) => a.name))
      for (const argName of argNames) {
        if (!allowedArgNames.has(argName)) {
          offenses.push(`Command "${name}" was sent an arg "${argName}" the contract doesn't declare`)
        }
      }
    }

    expect(offenses).toEqual([])
  })

  it('a rollback (CancelReceipt) is a real, argument-free vendor command', async () => {
    // Real wire shape (phase-69, finding 4.1b): business errors arrive as
    // Code 40 with STE1/STE2 hex attributes on <Err>, not the STE2 value
    // as the outer <Res Code> with STE1/STE2 as child elements.
    const { client, captured } = makeRecordingClient((command) =>
      command === 'SellPLUfromExtDB'
        ? '<Res Code="40"><Err Source="Device" Type="FPException" STE1="00" STE2="3e" FPLibErrorCode="00"><Message>Item amount too large</Message></Err></Res>'
        : healthyResponseFor(command)
    )
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: client })

    await provider.submitInvoice(SAMPLE_REQUEST)

    const cancelReceiptCalls = captured.filter((c) => c.name === 'CancelReceipt')
    expect(cancelReceiptCalls.length).toBeGreaterThan(0)
    expect(contract.commands.CancelReceipt).toBeDefined()
    expect(contract.commands.CancelReceipt.args).toEqual([])
  })

  /**
   * Phase 58 found and quarantined a real gap here: `cancelInvoice` used
   * to post `Name="OpenCreditNote"`, a command absent from the vendor
   * contract. Phase 60 closed it (see `tracker/SDK_RECON.md` §5 in the
   * `ZFP_SDK_KE_2509041522_ControlUnit` package) — `cancelInvoice` now
   * requires the original invoice's full customer block
   * (`CreditNoteDetails`) to actually reach the device, and posts the
   * real `OpenCreditNoteWithFreeCustomerData` command with its 8
   * caller-supplied fields when given one. Without that block, it
   * reports the manual-credit-note fallback immediately and posts
   * nothing — never a guessed, contract-invalid command. The
   * `docs/KNOWN_GAPS.md` entry for this was removed in the same change.
   */
  it('cancelInvoice posts a contract-valid OpenCreditNoteWithFreeCustomerData when given full details', async () => {
    const { client, captured } = makeRecordingClient(() => '<Res Code="0"/>')
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: client })

    await provider.cancelInvoice('KRA-0001', {
      companyName: 'Acme Traders Ltd',
      buyerPin: 'P051234567Z',
      relatedInvoiceNum: 'KRA-0001',
      traderSystemInvNum: 'INV-000000099'
    })

    expect(captured).toHaveLength(1)
    const [{ name, argNames }] = captured
    expect(name).toBe('OpenCreditNoteWithFreeCustomerData')
    const commandContract = contract.commands[name]
    expect(commandContract).toBeDefined()
    const allowedArgNames = new Set(commandContract.args.map((a) => a.name))
    for (const argName of argNames) {
      expect(allowedArgNames.has(argName)).toBe(true)
    }
  })

  it('cancelInvoice posts nothing at all without full details, rather than guessing a payload', async () => {
    const { client, captured } = makeRecordingClient(() => '<Res Code="0"/>')
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: client })

    const result = await provider.cancelInvoice('KRA-0001')

    expect(result.success).toBe(false)
    expect(captured).toHaveLength(0)
  })
})

describe('Incoming conformance — every response field the provider reads is a real vendor field', () => {
  /**
   * Field reads the provider's control flow actually branches on, per
   * command — hand-mapped from `real-etims-provider.ts` (grep for
   * `.data?.` / direct property access on a parsed response). Kept
   * separate from the generic `INVOICE_NUMBER_KEYS`/`QR_CODE_KEYS`
   * fallback-alias lists in `xml-utils.ts`, which deliberately also
   * accept non-vendor casings for other possible deployments and aren't
   * "the field the provider expects from this command" in the same
   * sense — see that file's doc comment.
   *
   * If a future change makes the provider read a new field, add it here
   * too: this table is intentionally not derived automatically, so
   * updating it is a conscious, reviewable act rather than something a
   * refactor can silently drift out from under.
   */
  const fieldsReadPerCommand: Record<string, string[]> = {
    ReadStatus: ['CU_fiscalized', 'Paired_with_TIMS'],
    ReadCurrentReceiptInfo: [
      'OptionIsReceiptOpened',
      'SubtotalAmountVATGA',
      'SubtotalAmountVATGB',
      'SubtotalAmountVATGC',
      'SubtotalAmountVATGD',
      'SubtotalAmountVATGE'
    ],
    CloseReceipt: ['InvoiceNum', 'QRcode'],
    ReadDateTime: ['DateTime']
  }

  it.each(Object.entries(fieldsReadPerCommand))(
    'every field the provider reads from %s exists in that command\'s contract response',
    (commandName, fieldNames) => {
      const commandContract = contract.commands[commandName]
      expect(commandContract).toBeDefined()
      const allowedFieldNames = new Set(commandContract.response.map((r) => r.name))

      const offenses = fieldNames.filter((field) => !allowedFieldNames.has(field))
      expect(offenses).toEqual([])
    }
  )

  it('documents that the provider never reads a "SubTotal"/"Connected"/"Fiscalized" field — the Phase 55 bug class', () => {
    const allReadFields = Object.values(fieldsReadPerCommand).flat()
    expect(allReadFields).not.toContain('SubTotal')
    expect(allReadFields).not.toContain('Subtotal')
    expect(allReadFields).not.toContain('Connected')
    expect(allReadFields).not.toContain('Fiscalized')
  })
})
