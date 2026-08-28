/**
 * Pure helpers for the Admin screen's eTIMS integration form — kept
 * framework-free (no React import) so they can be unit tested without
 * mounting the component tree.
 */

/** Local address the eTIMS fiscal device server (ZFPLabServer) listens on by default. */
export const DEFAULT_ETIMS_BASE_URL = 'http://localhost:4444'

/** VAT class applied when a line item has no product-level tax class configured. */
export const DEFAULT_ETIMS_VAT_CLASS = 'A'

/**
 * Default eTIMS endpoint paths — mirrors `DEFAULT_FISCAL_ENDPOINTS` in
 * `src/main/services/integrations/real-etims-provider.ts`. Duplicated
 * here (rather than imported) so this renderer bundle never pulls in
 * the main-process `axios`-based provider module.
 */
export const DEFAULT_ETIMS_ENDPOINTS = {
  openInvoice: '/OpenInvoiceWithFreeCustomerData',
  openInvoiceWithPin: '/OpenInvoiceWithCustomerData',
  sellPLU: '/SellPLUfromExtDB',
  closeReceipt: '/CloseReceipt',
  cancelReceipt: '/CancelReceipt',
  openCreditNote: '/OpenCreditNoteWithFreeCustomerData'
} as const

/** Result of {@link parseEtimsEndpointsInput}. */
export interface ParsedEtimsEndpoints {
  /** Present when `text` parsed to a valid endpoints object; omitted (not empty) when `text` was blank. */
  endpoints?: Record<string, unknown>
  /** Present when `text` was non-blank but not valid JSON, or not a JSON object. */
  error?: string
}

/**
 * Parses the Admin screen's endpoints textarea content into a config
 * object, or an error message when the JSON is malformed or not an
 * object. Blank input is valid — it means "use the provider's
 * defaults" — and yields neither `endpoints` nor `error`.
 *
 * @param {string} text
 * @returns {ParsedEtimsEndpoints}
 */
export function parseEtimsEndpointsInput(text: string): ParsedEtimsEndpoints {
  const trimmed = text.trim()
  if (!trimmed) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { error: 'Endpoints must be valid JSON (e.g. {"openInvoice": "/api/..."})' }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: 'Endpoints must be a JSON object (e.g. {"openInvoice": "/api/..."})' }
  }
  return { endpoints: parsed as Record<string, unknown> }
}
