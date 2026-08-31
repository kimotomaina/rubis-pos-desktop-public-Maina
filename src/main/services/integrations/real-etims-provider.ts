/**
 * Real eTIMS fiscalization provider — talks to a local fiscal device
 * server (ZFPLabServer) over HTTP, driving its stateful
 * `OpenInvoice` → `SellPLU` (per line item) → `CloseReceipt` flow.
 *
 * A `Code 53: ClientSettingsNotInitialized`/"First use settings()
 * command to set connection parameters" response does not mean an
 * HTTP `settings` command exists to call — the official ZFP HTTP
 * command list has no `settings`/`Settings`/`_Settings` endpoint
 * (`settings`, `_Settings`, and `Settings` were each tried live and
 * rejected). That message refers to the device IP/port/password
 * needing to be configured in the ZFPLabServer desktop GUI itself,
 * outside this HTTP API's reach — an operational prerequisite, not
 * something this provider can satisfy over the wire.
 *
 * Endpoint paths default to the ZFPLabServer SDK's method names but
 * are fully configurable, since the actual local server
 * (ZFPLabServerWindows) may expose a different RESTful surface (e.g.
 * `/api/v1/receipt/open`) — see {@link FiscalEndpointPaths}.
 */

import type { AxiosInstance } from 'axios'
import type { ServiceResult } from '../shopify-types.js'
import type {
  FiscalInvoiceLine,
  FiscalInvoiceRequest,
  FiscalInvoiceResult,
  FiscalizationProvider
} from './etims.js'
import { createFiscalHttpClient, postXml } from './http-client.js'
import { extractInvoiceNumberFromXml, extractQrCodeFromXml } from './xml-utils.js'

/** VAT class applied to a line item with no product-level tax class configured (16% VAT in Kenya). */
const DEFAULT_VAT_CLASS = 'A'

/** Currency applied to an invoice with none specified. */
const DEFAULT_CURRENCY = 'KES'

/** Till payment method codes mapped to the device's expected uppercase strings. */
const PAYMENT_METHOD_CODES: Record<string, string> = {
  cash: 'CASH',
  mpesa: 'MPESA',
  card: 'CARD'
}

/** Fiscal device endpoint paths, overridable per deployment. */
export interface FiscalEndpointPaths {
  openInvoice: string
  /** B2B invoice open endpoint, used instead of `openInvoice` when `request.buyerPin` is present. */
  openInvoiceWithPin: string
  sellPLU: string
  closeReceipt: string
  cancelReceipt: string
  openCreditNote: string
}

/**
 * Default paths, matching the ZFPLabServer SDK's method names.
 * `openInvoiceWithPin`'s exact name is unconfirmed against the
 * vendor's Java demo (see `real-etims-provider.ts`'s file doc) —
 * tracked for future confirmation alongside the other endpoints.
 */
export const DEFAULT_FISCAL_ENDPOINTS: FiscalEndpointPaths = {
  openInvoice: '/OpenInvoiceWithFreeCustomerData',
  openInvoiceWithPin: '/OpenInvoiceWithCustomerData',
  sellPLU: '/SellPLUfromExtDB',
  closeReceipt: '/CloseReceipt',
  cancelReceipt: '/CancelReceipt',
  openCreditNote: '/OpenCreditNoteWithFreeCustomerData'
}

/**
 * Reads the device's `Code` attribute/`Message` element out of a
 * parsed XML response (see `xml-utils.ts`'s `parseXmlResponse`) and,
 * when the code indicates a device-level error (present and not
 * `'0'`), returns a failed {@link ServiceResult} describing it —
 * e.g. `<Res Code="63"><Err><Message>Data at the root level is
 * invalid</Message></Err></Res>` becomes "Fiscal device error (Code
 * 63): Data at the root level is invalid". A 2xx HTTP response can
 * still encode a device-level failure this way, so every device call
 * result is checked here before its fields are trusted.
 *
 * @param {ServiceResult<Record<string, string>>} result
 * @returns {ServiceResult<Record<string, string>>}
 */
function checkDeviceResponse(
  result: ServiceResult<Record<string, string>>
): ServiceResult<Record<string, string>> {
  if (!result.success) return result
  const code = result.data?.code
  if (code && code !== '0') {
    const message = result.data?.Message ?? 'Unknown fiscal device error'
    return { success: false, error: `Fiscal device error (Code ${code}): ${message}` }
  }
  return result
}

/** Looks up a previously fiscalized invoice by number in local storage (the POS's `orders` table). */
export type FiscalInvoiceLookupFn = (invoiceNumber: string) => FiscalInvoiceResult | undefined

/** Options accepted by {@link RealFiscalizationProvider}. */
export interface RealFiscalizationProviderOptions {
  /** Base URL of the local ZFPLabServer instance. Defaults to `http://localhost:4444`. */
  baseUrl?: string
  /** Injectable HTTP client, primarily for tests. Defaults to a client built from `baseUrl`/`password`. */
  httpClient?: AxiosInstance
  /** Overrides for one or more endpoint paths. Unset paths fall back to {@link DEFAULT_FISCAL_ENDPOINTS}. */
  endpoints?: Partial<FiscalEndpointPaths>
  /** VAT class applied to a line item with no `vatClass` of its own. Defaults to `'A'`. */
  defaultVatClass?: string
  /** TCP/device password required by some ZFP server configurations. */
  password?: string
  /**
   * Reads back a previously fiscalized invoice from local storage.
   * `getInvoiceDetails` reports "not found" when omitted, since
   * querying the device's Electronic Journal is slow and unreliable
   * compared to the POS's own order history.
   */
  lookupInvoice?: FiscalInvoiceLookupFn
}

/**
 * Drives the ZFPLabServer's stateful invoice flow over HTTP. If any
 * step after `OpenInvoice` fails, attempts a call to the configured
 * `cancelReceipt` endpoint to void the open receipt on the device so
 * it doesn't block future sales — that rollback call is best-effort;
 * a device left stuck after a crash between `OpenInvoice` and
 * `CloseReceipt` still requires operator intervention.
 *
 * `request.clientOrderUuid` is sent as part of the `OpenInvoice`
 * payload so a store-and-forward retry of the same request (see
 * `fiscal-engine.ts`) is recognizable by the device as a duplicate of
 * one that may have already succeeded without the POS receiving the
 * acknowledgement, rather than fiscalizing the same sale twice.
 *
 * A non-blank `request.buyerPin` (a customer's KRA PIN, captured at
 * checkout for a B2B sale) switches the open-invoice call from the
 * B2C `openInvoice` endpoint to the B2B `openInvoiceWithPin` endpoint,
 * sending the PIN as `taxpayerPin` — see
 * {@link RealFiscalizationProvider.resolveOpenInvoiceEndpoint} and
 * {@link RealFiscalizationProvider.buildOpenInvoicePayload}.
 */
export class RealFiscalizationProvider implements FiscalizationProvider {
  private readonly http: AxiosInstance
  private readonly endpoints: FiscalEndpointPaths
  private readonly defaultVatClass: string
  private readonly lookupInvoice?: FiscalInvoiceLookupFn

  constructor(options: RealFiscalizationProviderOptions = {}) {
    this.http =
      options.httpClient ??
      createFiscalHttpClient({ baseUrl: options.baseUrl, password: options.password })
    this.endpoints = { ...DEFAULT_FISCAL_ENDPOINTS, ...options.endpoints }
    this.defaultVatClass = options.defaultVatClass ?? DEFAULT_VAT_CLASS
    this.lookupInvoice = options.lookupInvoice
  }

  async submitInvoice(
    request: FiscalInvoiceRequest
  ): Promise<ServiceResult<FiscalInvoiceResult>> {
    if (!request.clientOrderUuid) {
      return { success: false, error: 'clientOrderUuid is required to fiscalize an invoice' }
    }
    if (!Array.isArray(request.items) || request.items.length === 0) {
      return { success: false, error: 'Invoice has no line items to fiscalize' }
    }

    console.log(
      `[DEBUG-ETIMS-PROVIDER] Step 1/3: OpenInvoice → ${this.resolveOpenInvoiceEndpoint(request)} (command=${this.resolveOpenInvoiceCommandName(request)})`
    )
    const openResult = checkDeviceResponse(
      await postXml(
        this.http,
        this.resolveOpenInvoiceEndpoint(request),
        this.resolveOpenInvoiceCommandName(request),
        this.buildOpenInvoicePayload(request)
      )
    )
    console.log('[DEBUG-ETIMS-PROVIDER] Step 1/3: OpenInvoice result:', openResult)
    if (!openResult.success) {
      return { success: false, error: openResult.error }
    }

    for (const [index, item] of request.items.entries()) {
      console.log(
        `[DEBUG-ETIMS-PROVIDER] Step 2/3: SellPLU ${index + 1}/${request.items.length} → ${this.endpoints.sellPLU}`,
        item
      )
      const sellResult = checkDeviceResponse(
        await postXml(this.http, this.endpoints.sellPLU, 'SellPLU', this.buildSellPluPayload(item))
      )
      console.log(`[DEBUG-ETIMS-PROVIDER] Step 2/3: SellPLU ${index + 1}/${request.items.length} result:`, sellResult)
      if (!sellResult.success) {
        await this.rollback()
        return { success: false, error: sellResult.error }
      }
    }

    console.log(`[DEBUG-ETIMS-PROVIDER] Step 3/3: CloseReceipt → ${this.endpoints.closeReceipt}`)
    const closeResult = checkDeviceResponse(
      await postXml(this.http, this.endpoints.closeReceipt, 'CloseReceipt', {
        paymentMethod: this.mapPaymentMethod(request.paymentMethod),
        amountTendered: request.amountTendered ?? request.total
      })
    )
    console.log('[DEBUG-ETIMS-PROVIDER] Step 3/3: CloseReceipt result:', closeResult)
    if (!closeResult.success) {
      await this.rollback()
      return { success: false, error: closeResult.error }
    }

    const invoiceNumber = extractInvoiceNumberFromXml(closeResult.data ?? {})
    if (!invoiceNumber) {
      console.warn(
        '[rubis-pos] ZFP CloseReceipt response missing expected invoiceNumber. Raw response:',
        JSON.stringify(closeResult.data, null, 2)
      )
      await this.rollback()
      return {
        success: false,
        error: 'Fiscal device closed the receipt without returning an invoice number'
      }
    }

    console.log('[DEBUG-ETIMS-PROVIDER] submitInvoice SUCCESS, invoiceNumber =', invoiceNumber)
    return {
      success: true,
      data: {
        invoiceNumber,
        qrCode: extractQrCodeFromXml(closeResult.data ?? {}) ?? '',
        fiscalizedAt: new Date().toISOString()
      }
    }
  }

  async getInvoiceDetails(invoiceNumber: string): Promise<ServiceResult<FiscalInvoiceResult>> {
    if (!this.lookupInvoice) {
      return {
        success: false,
        error: 'No local invoice lookup configured for the real eTIMS provider'
      }
    }

    const invoice = this.lookupInvoice(invoiceNumber)
    if (!invoice) {
      return { success: false, error: `Invoice ${invoiceNumber} not found in local order history` }
    }
    return { success: true, data: invoice }
  }

  async cancelInvoice(invoiceNumber: string): Promise<ServiceResult<void>> {
    const result = checkDeviceResponse(
      await postXml(this.http, this.endpoints.openCreditNote, 'OpenCreditNote', {
        referenceInvoiceNumber: invoiceNumber
      })
    )
    if (!result.success) {
      return {
        success: false,
        error:
          `Automatic credit note failed — issue a manual credit note on the fiscal device for ` +
          `invoice ${invoiceNumber}: ${result.error}`
      }
    }
    return { success: true }
  }

  /**
   * Picks the B2B (`openInvoiceWithPin`) endpoint when `request.buyerPin`
   * is a non-blank KRA PIN, otherwise the B2C (`openInvoice`) endpoint.
   */
  private resolveOpenInvoiceEndpoint(request: FiscalInvoiceRequest): string {
    return request.buyerPin?.trim() ? this.endpoints.openInvoiceWithPin : this.endpoints.openInvoice
  }

  /**
   * Picks the `Request` envelope's `Name` attribute. Per the SDK
   * profile, `OpenInvoiceWithCustomerData` is not a valid server
   * command — `OpenInvoiceWithFreeCustomerData` is used for both B2C
   * and B2B, with the device deriving B2B status solely from the
   * presence of `taxpayerPin` in the payload (see
   * {@link buildOpenInvoicePayload}).
   */
  private resolveOpenInvoiceCommandName(_request: FiscalInvoiceRequest): string {
    return 'OpenInvoiceWithFreeCustomerData'
  }

  /**
   * Builds the `OpenInvoice` payload. A B2B invoice sends the buyer's
   * KRA PIN as `taxpayerPin` — the field name the vendor's B2B
   * endpoint is expected to key its taxpayer lookup on — instead of
   * the always-blank `buyerPin` field the B2C endpoint expects.
   */
  private buildOpenInvoicePayload(request: FiscalInvoiceRequest): Record<string, unknown> {
    const base = {
      clientOrderUuid: request.clientOrderUuid,
      customerName: request.customerName ?? '',
      currency: request.currency ?? DEFAULT_CURRENCY,
      receiptType: 'INVOICE'
    }
    const buyerPin = request.buyerPin?.trim()
    return buyerPin ? { ...base, taxpayerPin: buyerPin } : { ...base, buyerPin: '' }
  }

  /** Maps a line item to the device's `SellPLU` payload shape. */
  private buildSellPluPayload(item: FiscalInvoiceLine): Record<string, unknown> {
    return {
      pluCode: item.pluCode ?? item.description,
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      vatClass: item.vatClass ?? this.defaultVatClass
    }
  }

  /** Maps a till payment method to the device's expected code, defaulting to `CASH`. */
  private mapPaymentMethod(paymentMethod?: string): string {
    if (!paymentMethod) return 'CASH'
    return PAYMENT_METHOD_CODES[paymentMethod.toLowerCase()] ?? paymentMethod.toUpperCase()
  }

  /** Best-effort void of an open receipt after a failed `SellPLU`/`CloseReceipt` call. */
  private async rollback(): Promise<void> {
    console.log(`[DEBUG-ETIMS-PROVIDER] Rollback: CancelReceipt → ${this.endpoints.cancelReceipt}`)
    const result = await postXml(this.http, this.endpoints.cancelReceipt, 'CancelReceipt', {})
    console.log('[DEBUG-ETIMS-PROVIDER] Rollback result:', result)
  }
}
