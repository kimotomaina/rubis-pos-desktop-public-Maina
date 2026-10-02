/**
 * Pre-send validation for the fiscal device — one small, pure module
 * (SRP/ISP), separate from `fiscal-sanitize.ts` (which cleans values) and
 * from the provider (which sends them). Per the VIL "TSL G03 Integration
 * Programming Manual" (setup step 3 + post-implementation checklist item
 * 14): "All item fields required must be included. That is, Item
 * description, VAT code, Quantity and Unit Price"; "Items without 16% VAT
 * code should have a HS code and HS Description. Correct HS code format
 * must be entered and validated"; and its checklist question "What if you
 * send a PIN without the correct number of digits?".
 *
 * These checks exist so a malformed request fails fast, before any device
 * round-trip, with a clear cashier/operator-facing message — rather than
 * reaching `OpenInvoiceWithFreeCustomerData`/`SellPLUfromExtDB(_HS)` and
 * being rejected by the device (or worse, silently mis-fiscalized) partway
 * through the 7-step sequence, which would then also need a rollback.
 */

import type { FiscalInvoiceLine, FiscalInvoiceRequest } from './etims.js'
import { DEFAULT_VAT_CLASS, resolveVatClass } from '../../lib/vatClass.js'

/**
 * KRA PIN shape: one leading letter, nine digits, one trailing letter (11
 * characters total) — e.g. `P051234567Z`. Mirrors
 * `src/renderer/src/lib/kraPin.ts`'s `isValidKraPinFormat`, duplicated
 * rather than imported: that module lives in the renderer bundle and this
 * one runs in the main process (same rationale `etimsConfig.ts`'s doc
 * comment gives for not importing the main-process provider into the
 * renderer, in reverse — a one-line regex costs less than a cross-process
 * dependency).
 */
const KRA_PIN_PATTERN = /^[PA]\d{9}[A-Z]$/i

/**
 * Validates one line item against the manual's required-field list.
 *
 * @param {FiscalInvoiceLine} item
 * @param {number} index
 * @returns {string | undefined} an error message, or `undefined` when valid
 */
function validateLine(item: FiscalInvoiceLine, index: number): string | undefined {
  const label = `Item ${index + 1}`

  if (!item.description || !item.description.trim()) {
    return `${label}: description is required`
  }
  if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
    return `${label}: quantity must be greater than zero`
  }
  if (!Number.isFinite(item.unitPrice) || item.unitPrice < 0) {
    return `${label}: unit price is required and cannot be negative`
  }

  const vatClass = resolveVatClass(item.vatClass)
  if (vatClass === null) {
    return `${label}: VAT class "${String(item.vatClass)}" is not one of A/B/C/D/E`
  }
  if (vatClass !== DEFAULT_VAT_CLASS) {
    if (!item.hsCode || !item.hsCode.trim()) {
      return `${label}: HS code is required for VAT class ${vatClass} items (non-16%/exempt)`
    }
    if (!item.hsName || !item.hsName.trim()) {
      return `${label}: HS name is required for VAT class ${vatClass} items (non-16%/exempt)`
    }
  }

  return undefined
}

/**
 * Validates a fiscal invoice request before any device call — the
 * required-item-fields, HS-code-for-non-A, and PIN-digit-count checks the
 * VIL manual's workflow and checklist both call for. Returns the first
 * validation failure found (line items are checked in order), or
 * `undefined` when the request is well-formed.
 *
 * Deliberately does **not** duplicate `submitInvoice`'s existing
 * `clientOrderUuid`/empty-`items` guards — those already run first and
 * report their own clear messages.
 *
 * @param {FiscalInvoiceRequest} request
 * @returns {string | undefined}
 */
export function validateFiscalInvoiceRequest(request: FiscalInvoiceRequest): string | undefined {
  for (const [index, item] of request.items.entries()) {
    const lineError = validateLine(item, index)
    if (lineError) return lineError
  }

  const buyerPin = request.buyerPin?.trim()
  if (buyerPin && !KRA_PIN_PATTERN.test(buyerPin)) {
    return `Buyer PIN "${buyerPin}" must be 11 characters in the format <letter><9 digits><letter> (e.g. P051234567Z)`
  }

  return undefined
}
