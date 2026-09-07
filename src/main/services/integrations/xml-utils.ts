/**
 * Lightweight XML serialization/parsing for the local ZFPLabServer,
 * which speaks XML bodies over a `Content-Type: text/plain` header —
 * the literal, if surprising, value the vendor client sends
 * rather than JSON. Custom rather than a dependency (e.g. `xml2js`)
 * since the command envelope is a single fixed shape, confirmed by
 * decompiling the vendor's `FPcore.jar`:
 *
 *   - no arguments:  `<Command Name="ReadStatus"/>`
 *   - with args:     `<Command Name="X"><Args><Arg Name="k" Value="v"/>…</Args></Command>`
 *
 * The `<Args>` element is emitted only when there is at least one
 * argument, and argument values are XML *attribute* values (escaped
 * accordingly). The vendor client sets `omit-xml-declaration`, so no
 * `<?xml …?>` prolog is emitted either.
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
 * Serializes one command argument to an `<Arg Name="…" Value="…"/>`
 * element, matching what the vendor's `fillXmlWithParamVals` builds
 * (`createElement("Arg")` + `setAttribute("Name"/"Value")`).
 *
 * @param {string} name
 * @param {unknown} value
 * @returns {string}
 */
function serializeArg(name: string, value: unknown): string {
  return `<Arg Name="${escapeXml(name)}" Value="${escapeXml(String(value))}"/>`
}

/**
 * Serializes `args` into the ZFPLabServer's `<Command Name="…">`
 * envelope. Arguments are emitted in insertion order inside a single
 * `<Args>` element; a command with no arguments collapses to a
 * self-closing `<Command Name="…"/>` with no `<Args>` child at all,
 * exactly as the vendor client does (it only creates `Args` when its
 * parameter map is non-empty).
 *
 * `undefined` argument values are dropped — that is how an optional
 * argument (e.g. `DiscAddP`) is omitted. A deliberately blank argument
 * is passed as `''` and keeps its `<Arg>` element with an empty value.
 *
 * @example
 * serializeToXml({}, 'ReadStatus')
 * // '<Command Name="ReadStatus"/>'
 * serializeToXml({ CompanyName: 'Acme', ClientPINnum: '' }, 'OpenInvoiceWithFreeCustomerData')
 * // '<Command Name="OpenInvoiceWithFreeCustomerData"><Args><Arg Name="CompanyName" Value="Acme"/><Arg Name="ClientPINnum" Value=""/></Args></Command>'
 *
 * @param {object} args
 * @param {string} commandName
 * @returns {string}
 */
export function serializeToXml(args: object, commandName: string): string {
  const entries = Object.entries(args as Record<string, unknown>).filter(
    ([, value]) => value !== undefined
  )
  const name = escapeXml(commandName)
  if (entries.length === 0) {
    return `<Command Name="${name}"/>`
  }
  const argXml = entries.map(([key, value]) => serializeArg(key, value)).join('')
  return `<Command Name="${name}"><Args>${argXml}</Args></Command>`
}

/**
 * Element names checked, in order, when extracting the fiscal invoice
 * number from a parsed response. `InvoiceNum` is the name the vendor
 * `CloseReceipt` definition declares (`<Res Name="InvoiceNum" …>`); the
 * rest are legacy casings kept so an already-stored response shape
 * still reads back.
 */
const INVOICE_NUMBER_KEYS = [
  'InvoiceNum',
  'invoiceNum',
  'invoiceNumber',
  'InvoiceNumber',
  'receiptNumber',
  'ReceiptNumber'
]

/** Element names checked, in order, when extracting the fiscal QR code. `QRcode` is the vendor's declared name. */
const QR_CODE_KEYS = ['QRcode', 'QRCode', 'qrCode', 'QrCode', 'qr_code']

/**
 * Parses a ZFPLabServer XML response into a flat
 * `Record<string, string>` — enough for `real-etims-provider.ts` to
 * look up the confirmed response field names without a full DOM parser.
 * Three things are pulled out:
 *
 *   1. the root `<Res Code="…">` attribute, exposed as `code` (`'0'` is
 *      success; anything else is a server- or device-level error);
 *   2. the `Source` attribute of an `<Err …>` element, exposed as
 *      `errSource` — the server tags its own transport/session failures
 *      as `Source="Server"`, distinguishing them from device business
 *      errors;
 *   3. on a Code-40 ("command error") response, the `STE1`/`STE2`/
 *      `FPLibErrorCode` attributes of the same `<Err …>` element, exposed
 *      under those same names as **raw hex strings** (e.g. `"3a"`) — the
 *      vendor's own client (`fp_core.js:71-75`) only ever reads these
 *      three when `Res Code === 40`, then `parseInt(x, 16)`s them; this
 *      parser does the same raw extraction (no radix conversion — that's
 *      the caller's job, see `real-etims-provider.ts`'s `checkDeviceResponse`)
 *      so the STE1 (device/FD condition) and STE2 (command/business
 *      condition) bytes documented in protocol PDF §1.2.1's two-column
 *      "Table Errors" are actually readable, not silently dropped;
 *   4. every leaf element's text content keyed by tag name (e.g.
 *      `<Message>`, `<clientID>`), *and* every `Name="…" Value="…"`
 *      attribute pair keyed by its `Name` — the vendor's own result
 *      reader (`CreateRes`) walks `<Res Name="X" Value="Y"/>` children,
 *      so both shapes are accepted rather than guessing which one a
 *      given command returns.
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

  const errSourceMatch = xml.match(/<Err\b[^>]*\bSource="([^"]*)"/)
  if (errSourceMatch) {
    result.errSource = errSourceMatch[1]
  }

  const ste1Match = xml.match(/<Err\b[^>]*\bSTE1="([^"]*)"/)
  if (ste1Match) {
    result.STE1 = ste1Match[1]
  }

  const ste2Match = xml.match(/<Err\b[^>]*\bSTE2="([^"]*)"/)
  if (ste2Match) {
    result.STE2 = ste2Match[1]
  }

  const fpLibErrorCodeMatch = xml.match(/<Err\b[^>]*\bFPLibErrorCode="([^"]*)"/)
  if (fpLibErrorCodeMatch) {
    result.FPLibErrorCode = fpLibErrorCodeMatch[1]
  }

  const namedValuePattern = /\bName="([^"]*)"\s+Value="([^"]*)"/g
  let namedMatch: RegExpExecArray | null
  while ((namedMatch = namedValuePattern.exec(xml)) !== null) {
    const [, name, value] = namedMatch
    if (name) result[name] = unescapeXml(value)
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
