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
import type {
  CreditNoteDetails,
  FiscalInvoiceRequest,
  FiscalInvoiceResult,
  FiscalizationProvider,
  FiscalSubmitOutcome
} from './etims.js'

/** Simulated processing delay for the mock provider, in milliseconds. */
export const MOCK_ETIMS_DELAY_MS = 1000

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

  /**
   * @param {number} [delayMs] — simulated round-trip time. Defaults to
   *   {@link MOCK_ETIMS_DELAY_MS}.
   */
  constructor(delayMs: number = MOCK_ETIMS_DELAY_MS) {
    this.delayMs = delayMs
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
    const result: FiscalInvoiceResult = {
      invoiceNumber,
      qrCode: Buffer.from(`[QR CODE]:${invoiceNumber}`).toString('base64'),
      fiscalizedAt: new Date().toISOString()
    }
    this.invoices.set(invoiceNumber, result)

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
