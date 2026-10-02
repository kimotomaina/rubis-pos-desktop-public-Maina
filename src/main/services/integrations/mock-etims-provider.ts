/**
 * Development-only stand-in for the eTIMS fiscalization backend.
 *
 * Kept in its own module so `etims.ts` holds only the contract and
 * `main/index.ts` can import this implementation from a dev-only branch —
 * see `fiscal-provider-factory.ts`. Nothing in a packaged build may
 * reference it: the invoice numbers it mints are synthetic, and printing
 * one on a receipt would present an unfiled sale as filed (Rule 2).
 * `scripts/verify-no-mock-provider.cjs` fails the build if this module's
 * output reaches `out/main/index.js`.
 */

import type { ServiceResult } from '../shopify-types.js'
import { ln } from '../../lib/receiptLayout.js'
import type { ReceiptLayoutEntry } from '../../lib/receiptLayout.js'
import type {
  CreditNoteDetails,
  DuplicatePrintGate,
  DuplicatePrintOutcome,
  FiscalInvoiceRequest,
  FiscalInvoiceResult,
  FiscalizationProvider,
  FiscalSubmitOutcome,
  TraderInvNumRecorder
} from './etims.js'

/** Simulated processing delay for the mock provider, in milliseconds. */
export const MOCK_ETIMS_DELAY_MS = 1000

/**
 * Printed in double width at the top and bottom of every fiscal slip a mock
 * sale produces (docs/phase-198), so a test slip can never pass for a tax
 * invoice. This is the only place the wording lives; the real path never
 * prints it, and the build check fails if it reaches `out/main`.
 */
export const MOCK_SLIP_BANNER = 'TEST. NOT A TAX INVOICE.'

/** A made-up control unit serial, so the dev slip shows the line a real one carries. */
export const MOCK_CU_SERIAL = 'MOCK-CU-0000001'

/** Options for {@link MockFiscalizationProvider}. */
export interface MockFiscalizationProviderOptions {
  /** Stores the trader invoice number a sale would have been sent with (docs/phase-198). */
  recordTraderInvNum?: TraderInvNumRecorder
}

/**
 * Simulates the eTIMS middleware without any network access: a fixed
 * delay then a dummy invoice number and placeholder QR code, so the
 * checkout flow and receipt template can be exercised without a device.
 * Invoice numbers are generated deterministically from `clientOrderUuid`
 * so repeated submissions of the same order are idempotent, matching how
 * a real store-and-forward queue would behave.
 */
export class MockFiscalizationProvider implements FiscalizationProvider {
  private readonly delayMs: number
  private readonly invoices = new Map<string, FiscalInvoiceResult>()
  private lastInvoiceNumber = ''
  private readonly recordTraderInvNum?: TraderInvNumRecorder

  /**
   * @param {number} [delayMs] — simulated round-trip time. Defaults to
   *   {@link MOCK_ETIMS_DELAY_MS}.
   * @param {MockFiscalizationProviderOptions} [options]
   */
  constructor(delayMs: number = MOCK_ETIMS_DELAY_MS, options: MockFiscalizationProviderOptions = {}) {
    this.delayMs = delayMs
    this.recordTraderInvNum = options.recordTraderInvNum
  }

  /**
   * Frames the whole fiscal slip with the test banner, a row of asterisks above
   * and below it, top and bottom (docs/phase-198). On a narrow printer, where the
   * banner will not fit on one line at double width, it prints bold instead.
   *
   * @param {ReceiptLayoutEntry[]} entries
   * @param {{ width: number }} options
   * @returns {ReceiptLayoutEntry[]}
   */
  decorateFiscalSlip(entries: ReceiptLayoutEntry[], options: { width: number }): ReceiptLayoutEntry[] {
    const stars = ln('*'.repeat(options.width))
    const style = MOCK_SLIP_BANNER.length * 2 <= options.width ? 'double' : 'bold'
    const banner = [stars, ln(MOCK_SLIP_BANNER, 'centre', style), stars]
    return [...banner, ...entries, ...banner]
  }

  /**
   * @param {FiscalInvoiceRequest} request
   * @returns {Promise<FiscalSubmitOutcome>}
   */
  async submitInvoice(request: FiscalInvoiceRequest): Promise<FiscalSubmitOutcome> {
    await delay(this.delayMs)

    if (!request.clientOrderUuid) {
      return {
        ok: false,
        reason: 'clientOrderUuid is required to fiscalize an invoice',
        kind: 'system',
        retryable: false
      }
    }
    if (!Array.isArray(request.items) || request.items.length === 0) {
      return {
        ok: false,
        reason: 'Invoice has no line items to fiscalize',
        kind: 'system',
        retryable: false
      }
    }

    const invoiceNumber = `KRA-MOCK-${request.clientOrderUuid.slice(0, 8).toUpperCase()}`
    if (typeof request.localId === 'number' && this.recordTraderInvNum) {
      // Same shape the real provider sends, so a dev slip shows the "Receipt" line.
      this.recordTraderInvNum(request.localId, `INV-${String(request.localId).padStart(9, '0')}`)
    }
    const result: FiscalInvoiceResult = {
      invoiceNumber,
      qrCode: Buffer.from(`[QR CODE]:${invoiceNumber}`).toString('base64'),
      fiscalizedAt: new Date().toISOString(),
      cuSerialNumber: MOCK_CU_SERIAL
    }
    this.invoices.set(invoiceNumber, result)
    this.lastInvoiceNumber = invoiceNumber

    return { ok: true, data: result }
  }

  /**
   * @param {string} invoiceNumber
   * @param {CreditNoteDetails} [_details] — accepted for interface parity; the mock ignores it.
   * @returns {Promise<ServiceResult<void>>}
   */
  async cancelInvoice(
    invoiceNumber: string,
    _details?: CreditNoteDetails
  ): Promise<ServiceResult<void>> {
    await delay(this.delayMs)

    if (!this.invoices.has(invoiceNumber)) {
      return { success: false, error: `Invoice ${invoiceNumber} not found` }
    }
    this.invoices.delete(invoiceNumber)
    return { success: true }
  }

  /**
   * @param {string} invoiceNumber
   * @returns {Promise<ServiceResult<FiscalInvoiceResult>>}
   */
  async getInvoiceDetails(invoiceNumber: string): Promise<ServiceResult<FiscalInvoiceResult>> {
    await delay(this.delayMs)

    const invoice = this.invoices.get(invoiceNumber)
    if (!invoice) {
      return { success: false, error: `Invoice ${invoiceNumber} not found` }
    }
    return { success: true, data: invoice }
  }

  /**
   * Stands in for the device: its "last receipt" is the last invoice this
   * mock issued, and nothing is printed.
   *
   * @param {DuplicatePrintGate} gate
   * @returns {Promise<DuplicatePrintOutcome>}
   */
  async printLastReceiptDuplicate(gate: DuplicatePrintGate): Promise<DuplicatePrintOutcome> {
    const verdict = gate({
      deviceLastCuInvoiceNumber: this.lastInvoiceNumber,
      receiptOpen: false,
      queueHasInFlight: false
    })
    if (!verdict.allowed) {
      return { status: 'refused', reason: verdict.reason, deviceLastBefore: this.lastInvoiceNumber || null }
    }
    console.log('mock: duplicate print')
    return { status: 'sent', deviceLastBefore: this.lastInvoiceNumber, deviceLastAfter: this.lastInvoiceNumber }
  }
}

/**
 * Resolves after `ms` milliseconds.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
