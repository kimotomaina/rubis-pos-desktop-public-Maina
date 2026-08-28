/**
 * eTIMS (KRA) fiscalization integration.
 *
 * KRA's eTIMS requires every invoice to be fiscalized (assigned a KRA
 * invoice number and QR code) — but a store-floor till cannot block a
 * sale on a government API being reachable. The intended production
 * shape is a local middleware that queues invoices for submission
 * (store-and-forward, mirroring the existing Shopify `sync_queue`
 * pattern in `database.ts`) and generates a provisional local invoice
 * immediately. {@link MockFiscalizationProvider} stands in for that
 * middleware here — a real `EtimsMiddlewareProvider` implementing the
 * same {@link FiscalizationProvider} interface is planned.
 */

import type { ServiceResult } from '../shopify-types.js'

/** Simulated processing delay for the mock provider, in milliseconds. */
export const MOCK_ETIMS_DELAY_MS = 1000

/** One taxable line item on the invoice submitted for fiscalization. */
export interface FiscalInvoiceLine {
  description: string
  quantity: number
  unitPrice: number
  /** Fractional tax rate applied to this line (0.16 = 16% VAT). */
  taxRate: number
  /** Stable product identifier the fiscal device can key its PLU registry on — a variant id or generated hash. */
  pluCode?: string
  /** Device VAT class code (e.g. `'A'` for 16%). Providers default this when omitted. */
  vatClass?: string
}

/** Request to fiscalize one completed sale. */
export interface FiscalInvoiceRequest {
  /** Local order UUID — ties the KRA invoice back to the POS sale. */
  clientOrderUuid: string
  items: FiscalInvoiceLine[]
  /** Grand total including tax, in KES. */
  total: number
  /** Total tax portion of `total`. */
  taxAmount: number
  /** Buyer's KRA PIN, when captured (optional for walk-in retail sales). */
  buyerPin?: string
  /** Buyer's display name, when captured. */
  customerName?: string
  /** ISO 4217 currency code. Providers default this (e.g. to `'KES'`) when omitted. */
  currency?: string
  /** Till payment method (e.g. `'cash'`, `'mpesa'`, `'card'`). */
  paymentMethod?: string
  /** Amount tendered by the customer. */
  amountTendered?: number
}

/** Result of a successful (or previously successful) fiscalization. */
export interface FiscalInvoiceResult {
  /** KRA-assigned invoice number, or a local placeholder while queued. */
  invoiceNumber: string
  /**
   * Base64-encoded placeholder for the KRA-mandated QR code. Real QR
   * generation (the `qrcode` package, encoding the KRA verification
   * URL) is planned for the production integration.
   */
  qrCode: string
  fiscalizedAt: string
}

/**
 * Narrow surface every fiscalization backend (mock or real eTIMS
 * middleware) must implement.
 */
export interface FiscalizationProvider {
  /** Submits a completed sale for fiscalization. */
  submitInvoice(request: FiscalInvoiceRequest): Promise<ServiceResult<FiscalInvoiceResult>>

  /** Cancels a previously submitted invoice (e.g. on a full refund). */
  cancelInvoice(invoiceNumber: string): Promise<ServiceResult<void>>

  /** Reads back the current status of a previously submitted invoice. */
  getInvoiceDetails(invoiceNumber: string): Promise<ServiceResult<FiscalInvoiceResult>>
}

/**
 * Simulates the eTIMS middleware without any network access: a fixed
 * delay then a dummy invoice number and placeholder QR code, so the
 * checkout flow and receipt template can be built against a stable
 * contract now. Invoice numbers are generated deterministically from
 * `clientOrderUuid` so repeated submissions of the same order are
 * idempotent, matching how a real store-and-forward queue would behave.
 */
export class MockFiscalizationProvider implements FiscalizationProvider {
  private readonly delayMs: number
  private readonly invoices = new Map<string, FiscalInvoiceResult>()

  constructor(delayMs: number = MOCK_ETIMS_DELAY_MS) {
    this.delayMs = delayMs
  }

  async submitInvoice(
    request: FiscalInvoiceRequest
  ): Promise<ServiceResult<FiscalInvoiceResult>> {
    await delay(this.delayMs)

    if (!request.clientOrderUuid) {
      return { success: false, error: 'clientOrderUuid is required to fiscalize an invoice' }
    }
    if (!Array.isArray(request.items) || request.items.length === 0) {
      return { success: false, error: 'Invoice has no line items to fiscalize' }
    }

    const invoiceNumber = `KRA-MOCK-${request.clientOrderUuid.slice(0, 8).toUpperCase()}`
    const result: FiscalInvoiceResult = {
      invoiceNumber,
      qrCode: Buffer.from(`[QR CODE]:${invoiceNumber}`).toString('base64'),
      fiscalizedAt: new Date().toISOString()
    }
    this.invoices.set(invoiceNumber, result)

    return { success: true, data: result }
  }

  async cancelInvoice(invoiceNumber: string): Promise<ServiceResult<void>> {
    await delay(this.delayMs)

    if (!this.invoices.has(invoiceNumber)) {
      return { success: false, error: `Invoice ${invoiceNumber} not found` }
    }
    this.invoices.delete(invoiceNumber)
    return { success: true }
  }

  async getInvoiceDetails(
    invoiceNumber: string
  ): Promise<ServiceResult<FiscalInvoiceResult>> {
    await delay(this.delayMs)

    const invoice = this.invoices.get(invoiceNumber)
    if (!invoice) {
      return { success: false, error: `Invoice ${invoiceNumber} not found` }
    }
    return { success: true, data: invoice }
  }
}

/** Resolves after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
