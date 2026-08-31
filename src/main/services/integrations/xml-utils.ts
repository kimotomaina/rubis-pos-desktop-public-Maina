/**
 * Lightweight XML serialization/parsing for the ZFP Lab Server fiscal
 * device SDK, which requires request/response bodies as XML
 * (`Content-Type: text/xml`) rather than JSON. Custom rather than a
 * dependency (e.g. `xml2js`) since the payload shapes exchanged with
 * the device are simple, flat-ish, and fully known ahead of time.
 */

/** Characters requiring escaping inside XML text content. */
const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;'
}

/**
 * Escapes the XML special characters `&`, `<`, `>`, `"`, and `'` in
 * `value`.
 *
 * @param {string} value
 * @returns {string}
 */
export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => XML_ESCAPES[char])
}

/**
 * Serializes a JavaScript value to an XML fragment: objects become
 * nested elements keyed by property name, arrays repeat the singular
 * form of their parent tag (`items` → `<item>` per entry), and
 * primitives become escaped text content. Used by
 * {@link serializeToXml} for the payload's inner fields.
 *
 * @param {unknown} value
 * @param {string} tagName
 * @returns {string}
 */
function serializeValue(value: unknown, tagName: string): string {
  if (Array.isArray(value)) {
    const itemTag = singularize(tagName)
    return `<${tagName}>${value.map((item) => serializeValue(item, itemTag)).join('')}</${tagName}>`
  }
  if (value && typeof value === 'object') {
    return `<${tagName}>${serializeFields(value as Record<string, unknown>)}</${tagName}>`
  }
  return `<${tagName}>${escapeXml(String(value))}</${tagName}>`
}

/** Serializes each own property of `obj` as a sibling XML element. */
function serializeFields(obj: Record<string, unknown>): string {
  return Object.entries(obj)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => serializeValue(value, key))
    .join('')
}

/**
 * Derives the per-item tag name for an array property — strips a
 * trailing `s` (`items` → `item`) or falls back to `item` when the key
 * gives no better hint.
 *
 * @param {string} pluralTag
 * @returns {string}
 */
function singularize(pluralTag: string): string {
  if (pluralTag.endsWith('s') && pluralTag.length > 1) {
    return pluralTag.slice(0, -1)
  }
  return 'item'
}

/**
 * Serializes `payload` to an XML document string wrapped in a
 * `<Request Name="commandName">` envelope. The Tremol ZFP server's XML
 * schema is case-sensitive on this attribute: neither `name` nor
 * `command` (both tried against a live device) satisfied it, only the
 * capitalized `Name`.
 *
 * @example
 * serializeToXml({ taxpayerPin: 'P051234567Z', currency: 'KES' }, 'OpenInvoice')
 * // '<Request Name="OpenInvoice"><taxpayerPin>P051234567Z</taxpayerPin><currency>KES</currency></Request>'
 *
 * @param {object} payload
 * @param {string} commandName
 * @returns {string}
 */
export function serializeToXml(payload: object, commandName: string): string {
  return `<Request Name="${escapeXml(commandName)}">${serializeFields(payload as Record<string, unknown>)}</Request>`
}

/** Element/attribute names checked, in order, when extracting the fiscal invoice number from a parsed response. */
const INVOICE_NUMBER_KEYS = ['invoiceNumber', 'InvoiceNumber', 'receiptNumber', 'ReceiptNumber']

/** Element/attribute names checked, in order, when extracting the fiscal QR code from a parsed response. */
const QR_CODE_KEYS = ['qrCode', 'QrCode', 'qr_code']

/**
 * Parses an XML response from the ZFP Lab Server into a flat
 * `Record<string, string>` of every top-level (and one-level-nested)
 * element's text content, keyed by tag name — enough for
 * `real-etims-provider.ts` to look up `invoiceNumber`/`qrCode` by any
 * of their observed casings without a full DOM parser.
 *
 * A `<Res Code="...">` error response (e.g.
 * `<Res Code="63"><Err><Message>...</Message></Err></Res>`) is
 * flattened the same way, additionally exposing the root's `Code`
 * attribute as `code` and the nested `<Message>` element under its
 * own literal tag name.
 *
 * @param {string} xml
 * @returns {Record<string, string>}
 */
export function parseXmlResponse(xml: string): Record<string, string> {
  const result: Record<string, string> = {}

  const rootCodeMatch = xml.match(/<Res\s+Code="([^"]*)"/)
  if (rootCodeMatch) {
    result.code = rootCodeMatch[1]
  }

  const elementPattern = /<([A-Za-z_][\w.-]*)(?:\s+[^>]*)?>([\s\S]*?)<\/\1>/g
  let match: RegExpExecArray | null
  while ((match = elementPattern.exec(xml)) !== null) {
    const [, tagName, innerXml] = match
    if (/</.test(innerXml)) {
      elementPattern.lastIndex = match.index + 1
      continue
    }
    result[tagName] = unescapeXml(innerXml)
  }

  return result
}

/**
 * Reads the fiscal invoice number out of a {@link parseXmlResponse}
 * result, checking each casing variant in {@link INVOICE_NUMBER_KEYS}.
 *
 * @param {Record<string, string>} parsed
 * @returns {string | undefined}
 */
export function extractInvoiceNumberFromXml(parsed: Record<string, string>): string | undefined {
  for (const key of INVOICE_NUMBER_KEYS) {
    if (parsed[key]) return parsed[key]
  }
  return undefined
}

/**
 * Reads the fiscal QR code out of a {@link parseXmlResponse} result,
 * checking each casing variant in {@link QR_CODE_KEYS}.
 *
 * @param {Record<string, string>} parsed
 * @returns {string | undefined}
 */
export function extractQrCodeFromXml(parsed: Record<string, string>): string | undefined {
  for (const key of QR_CODE_KEYS) {
    if (parsed[key]) return parsed[key]
  }
  return undefined
}

/** Reverses {@link escapeXml}'s character substitutions. */
function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}
