/**
 * Shared receipt layout builder (docs/phase-171).
 *
 * Both `printer.ts` (thermal/ESC-POS) and `pdf-receipt.ts` (PDF fallback)
 * render the exact same array this module produces — neither one decides
 * content, wording or field order any more. This is what makes the two
 * outputs impossible to drift apart, the same problem `receiptTotals.ts`
 * and `receiptFiscalBlock.ts` already solved for the figures and the CU
 * block; this module reuses both rather than recomputing anything they
 * already own.
 *
 * Every entry is either a printed line ({@link ReceiptLayoutLine} — text,
 * alignment, style) or a QR entry ({@link ReceiptLayoutQrEntry}) carrying
 * the device's own verification text. A renderer walks the array once and
 * turns each entry into whatever its medium needs; it never inspects the
 * order or settings directly.
 *
 * Text is ASCII-only throughout (`toAscii`) — a thermal printer's code
 * page may not have a curly quote or an em dash, and a receipt that
 * prints as "?" boxes is worse than one that was plainly rewritten.
 *
 * The two-column rows (Details, Totals, Payment, VAT table, CU block) are
 * built as one already-padded string with `align: 'left'` — a single
 * `align` field cannot pin a label to the left edge and a value to the
 * right edge of the same line at once, so those rows compose their own
 * padding. Single-anchor rows (an item's qty/price/amount line, a
 * centred heading) use `align` directly instead.
 */

import type { Discount } from '../services/shopify-types.js'
import type { SalePayment } from './paymentLegs.js'
import type { AppliedAutoDiscount } from './autoDiscounts.js'
import { computeReceiptTotals } from './receiptTotals.js'
import { VAT_CLASSES, VAT_CLASS_RATES, expectedGroupTotals, grossToVat, resolveVatClass, type VatClass } from './vatClass.js'
import { reconcileVatGroups } from './vatReconcile.js'
import type { ReceiptTotalsLineItem } from './receiptTotals.js'
import {
  buildFiscalBlockLines,
  FISCAL_RECEIPT_END_MARKER,
  FISCAL_RECEIPT_START_MARKER,
  NOT_A_TAX_INVOICE_LINE
} from './receiptFiscalBlock.js'
import { titleCaseName } from './text.js'

/** Where a printed line sits within the receipt's width. */
export type ReceiptLineAlign = 'left' | 'centre' | 'right'

/** How a printed line is weighted/sized. */
export type ReceiptLineStyle = 'normal' | 'bold' | 'double'

/** One printed line. */
export interface ReceiptLayoutLine {
  text: string
  align: ReceiptLineAlign
  style: ReceiptLineStyle
}

/** A QR code entry, carrying the exact text to encode — never an image. */
export interface ReceiptLayoutQrEntry {
  qr: string
}

/** One entry in a receipt layout, in print order. */
export type ReceiptLayoutEntry = ReceiptLayoutLine | ReceiptLayoutQrEntry

/** True when `entry` is a QR entry rather than a printed line. */
export function isReceiptLayoutQr(entry: ReceiptLayoutEntry): entry is ReceiptLayoutQrEntry {
  return 'qr' in entry
}

/** Seller/store identity fields printed in the header and footer. */
export interface ReceiptLayoutSettings {
  /** Fractional VAT rate applied to the order total (0.16 = 16%). */
  taxRate: number
  /** The big, double-size name at the very top. */
  tradingName: string
  /** The registered company name, when set — omitted otherwise. */
  legalName?: string
  /** Branch/shop name and street address, one line — omitted when unset. */
  address?: string
  /** Phone number, printed as "Tel <phone>" — omitted when unset. */
  phone?: string
  /** The seller's own KRA PIN — omitted when unset. */
  sellerPin?: string
  /** Printed centred above the VAT key at the very bottom. */
  footerMessage?: string
  /**
   * Rewrites the finished layout (docs/phase-198). Set only by a development
   * stand-in that marks its slips as tests; the real path never sets it.
   */
  decorate?: (entries: ReceiptLayoutEntry[], options: { width: number }) => ReceiptLayoutEntry[]
}

/** One printed line item. */
export interface ReceiptLayoutLineItem {
  title: string
  variantTitle: string
  quantity: number
  unitPrice: number
  discount?: Discount
  /**
   * KRA VAT class letter (A-E). Defaults to `'A'` when absent — the same
   * default `checkout.ts`'s `buildFiscalInvoiceRequest` already applies,
   * and the only option for a sale that has never been fiscalised (so no
   * device-confirmed class exists yet).
   */
  vatClass?: string
  /** The automatic discount this line was sold under, at `unitPrice` (docs/phase-253-2). */
  autoDiscount?: AppliedAutoDiscount
}

/** The device's five per-VAT-group taxable (ex-VAT) subtotals, as stored. */
export interface ReceiptLayoutVatGroups {
  A?: string
  B?: string
  C?: string
  D?: string
  E?: string
}

/** The order fields the layout builder needs. */
export interface ReceiptLayoutOrder {
  localId: number
  createdAt: string
  cashierName: string
  paymentMethod: 'cash' | 'mpesa' | 'card' | 'split'
  tenderedAmount: number
  changeDue: number
  referenceNumber?: string
  /** A split sale's payments, from its order payload (docs/phase-252). Read only when `paymentMethod` is `split`. */
  payments?: SalePayment[]
  customerPin?: string
  /** Buyer's company/trading name, from `fiscal_request_json` — only ever known once a fiscal request was sent. */
  buyerName?: string
  fiscalInvoiceNumber?: string
  /**
   * The trader invoice number sent to the device, as stored when it was sent
   * (docs/phase-198). Printed as "Invoice No" on a fiscal slip and as "Receipt" on
   * the Enjoy slip; never recomputed, so an order with none stored prints neither.
   */
  traderInvNum?: string
  /** The device's own QR verification text (a URL, up to 128 characters) — never an image. */
  fiscalQrCode?: string
  fiscalizedAt?: string
  fiscalizedAtSource?: 'device' | 'local-fallback'
  cuSerial?: string
  /** Set only for a not-yet-filed sale on the real provider — see `buildFiscalBlockLines`. */
  fiscalPending?: boolean
  isDuplicate?: boolean
  total: number
  cartDiscount?: Discount
  items: ReceiptLayoutLineItem[]
  vatGroups?: ReceiptLayoutVatGroups
}

/** Printer widths this builder supports, in characters per line. */
export type ReceiptWidth = 48 | 42 | 32

/** The payment label each method prints after `PAID BY`. */
const PAYMENT_LABELS: Record<SalePayment['method'], string> = { cash: 'CASH', mpesa: 'M-PESA', card: 'CARD' }

const DEFAULT_WIDTH: ReceiptWidth = 48

/** Narrows a stored/plain number to a {@link ReceiptWidth}, or `undefined` for anything else (including absent). */
export function asReceiptWidth(value: number | null | undefined): ReceiptWidth | undefined {
  return value === 48 || value === 42 || value === 32 ? value : undefined
}

/** The footer key entry for each class, printed only for the classes a receipt holds (docs/phase-194, D5). */
const VAT_CLASS_KEYS: Record<VatClass, string> = {
  A: 'A = VAT 16%',
  B: 'B = VAT 8%',
  C: 'C = Zero rated',
  D: 'D = Other rate',
  E: 'E = Exempt'
}

const AMOUNT_FORMAT = new Intl.NumberFormat('en-KE', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
})

/** Formats a plain amount with thousands separators, no currency symbol — e.g. `1,650.00`. */
export function formatAmount(value: number): string {
  return AMOUNT_FORMAT.format(value)
}

/** Formats an ISO/device timestamp as `dd/mm/yyyy HH:mm`, in local time. */
export function formatReceiptDateTime(iso: string): string {
  const date = new Date(iso)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Replaces characters a thermal printer's code page may not have with
 * plain ASCII equivalents, then strips anything else outside the
 * printable ASCII range — a receipt is never allowed to depend on the
 * printer's font having a given glyph.
 *
 * @param {string} text
 * @returns {string}
 */
export function toAscii(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7E]/g, '')
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

export function ln(text: string, align: ReceiptLineAlign = 'left', style: ReceiptLineStyle = 'normal'): ReceiptLayoutLine {
  return { text: toAscii(text), align, style }
}

export function rule(width: number): ReceiptLayoutLine {
  return ln('-'.repeat(width))
}

/**
 * Wraps `text` to `width`-character lines, breaking on spaces where
 * possible; a single word longer than `width` is hard-cut rather than
 * left overflowing the line. Capped at `maxLines` — remaining words are
 * still cut off rather than overflowing the last line.
 *
 * @param {string} text
 * @param {number} width
 * @param {number} [maxLines]
 * @returns {string[]}
 */
export function wrapText(text: string, width: number, maxLines = Infinity): string[] {
  const words = toAscii(text).trim().split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''

  for (const word of words) {
    if (lines.length >= maxLines) break
    const candidate = current ? `${current} ${word}` : word
    if (candidate.length <= width) {
      current = candidate
      continue
    }
    if (current) lines.push(current)
    // A single word longer than the width is hard-cut across as many
    // lines as remain, rather than left to overflow one line.
    let remainder = word
    current = ''
    while (remainder.length > width && lines.length < maxLines) {
      lines.push(remainder.slice(0, width))
      remainder = remainder.slice(width)
    }
    current = remainder
  }
  if (current && lines.length < maxLines) lines.push(current)
  if (lines.length === 0) lines.push('')
  if (lines.length > maxLines) lines.length = maxLines
  return lines.map((line) => line.slice(0, width))
}

/**
 * The characters one printed line holds at `style`. A `'double'` line is twice
 * as wide per character, so it holds half as many; a longer one wraps on the
 * printer (docs/phase-216).
 *
 * @param {ReceiptLineStyle} style
 * @param {number} width characters per normal-size line
 * @returns {number}
 */
export function columnsFor(style: ReceiptLineStyle, width: number): number {
  return style === 'double' ? Math.floor(width / 2) : width
}

/**
 * Builds a two-anchor row — a label pinned to the left edge and a value
 * pinned to the right edge of the same line, which holds `columnsFor(style, width)`
 * characters. Falls back to two lines (label, then the value right-aligned
 * beneath it) when both together would overflow the line; each is cut or
 * padded to the same line length, so neither wraps again.
 *
 * @param {string} label
 * @param {string} value
 * @param {number} width
 * @param {ReceiptLineStyle} [style]
 * @returns {ReceiptLayoutLine[]}
 */
export function keyValueLines(
  label: string,
  value: string,
  width: number,
  style: ReceiptLineStyle = 'normal'
): ReceiptLayoutLine[] {
  const columns = columnsFor(style, width)
  const plainLabel = toAscii(label)
  const plainValue = toAscii(value)
  const gap = columns - plainLabel.length - plainValue.length
  if (gap >= 1) {
    return [ln(plainLabel + ' '.repeat(gap) + plainValue, 'left', style)]
  }
  const valueLine = plainValue.length <= columns ? plainValue.padStart(columns) : plainValue.slice(0, columns)
  return [ln(plainLabel.slice(0, columns), 'left', style), ln(valueLine, 'left', style)]
}

/** Splits a `"Label: value"` string (as `buildFiscalBlockLines` returns) into its two halves. */
function splitLabelValue(text: string): { label: string; value: string } {
  const index = text.indexOf(': ')
  if (index === -1) return { label: text, value: '' }
  return { label: text.slice(0, index + 1), value: text.slice(index + 2) }
}

/**
 * Wraps free text (a setting or a fixed label) to the line length of `style`
 * (`columnsFor`), breaking at a space where it can, applying one align/style to
 * every resulting line.
 */
export function wrappedLines(
  text: string,
  width: number,
  align: ReceiptLineAlign = 'centre',
  style: ReceiptLineStyle = 'normal'
): ReceiptLayoutLine[] {
  return wrapText(text, columnsFor(style, width)).map((line) => ln(line, align, style))
}

/**
 * The line under a line sold at an automatic discount (docs/phase-253-2): the discount's title and what the line saved,
 * e.g. `Probakery Bread 2 @99/= saved 31.00`. When that does not fit the width, the title wraps and the saving goes on
 * its own line, right-aligned, so neither is cut. Nothing for any other line.
 *
 * @param {ReceiptLayoutLineItem} item
 * @param {number} width
 * @returns {ReceiptLayoutLine[]}
 */
export function autoDiscountLines(item: ReceiptLayoutLineItem, width: number): ReceiptLayoutLine[] {
  if (!item.autoDiscount) return []
  const saved = `saved ${formatAmount(round2(item.autoDiscount.amountOffEach * item.quantity))}`
  const oneLine = toAscii(`${item.autoDiscount.title} ${saved}`)
  if (oneLine.length <= width) return [ln(oneLine)]
  return [...wrapText(item.autoDiscount.title, width).map((text) => ln(text)), ln(saved, 'right')]
}

/** One item's printed name — variant appended only for a real variant, wrapped to at most 2 lines. */
function itemNameLines(item: ReceiptLayoutLineItem, width: number): ReceiptLayoutLine[] {
  const hasRealVariant = item.variantTitle && item.variantTitle !== 'Default Title'
  const label = hasRealVariant ? `${item.title} (${item.variantTitle})` : item.title
  return wrapText(label, width, 2).map((text) => ln(text))
}

/** One item's qty/price/amount/class line, right-aligned as a whole. */
function itemAmountLine(item: ReceiptLayoutLineItem, width: number): ReceiptLayoutLine {
  const amount = item.unitPrice * item.quantity
  const vatClass = resolveVatClass(item.vatClass) ?? String(item.vatClass).trim()
  const text = `${item.quantity} x ${formatAmount(item.unitPrice)} ${formatAmount(amount)} ${vatClass}`
  return ln(text.length <= width ? text : text.slice(text.length - width), 'right')
}

/**
 * A VAT-class table row's rate, taxable amount and VAT, from its stored gross (VAT-inclusive)
 * subtotal. The device's group amounts are gross (docs/phase-214), so the taxable amount is the
 * gross less the VAT inside it, and the gross is shown as stored. A class with no fixed rate
 * shows its amount as both taxable and gross, with no VAT figure.
 */
function vatClassFigures(
  letter: string,
  gross: number
): { rateLabel: string; vatLabel: string; taxable: number } {
  const rate = VAT_CLASS_RATES[letter as VatClass] ?? null
  if (rate === null) {
    return { rateLabel: 'n/a', vatLabel: 'n/a', taxable: gross }
  }
  const vat = grossToVat(letter as VatClass, gross)
  return { rateLabel: `${Math.round(rate * 100)}%`, vatLabel: formatAmount(vat), taxable: round2(gross - vat) }
}

/** The key entries for the classes the receipt's lines hold, in class order; class A alone for a receipt with none. */
function vatClassKeys(items: ReceiptLayoutLineItem[]): string[] {
  const present = VAT_CLASSES.filter((letter) => items.some((item) => resolveVatClass(item.vatClass) === letter))
  return (present.length > 0 ? present : (['A'] as VatClass[])).map((letter) => VAT_CLASS_KEYS[letter])
}

/**
 * The VAT-table amounts for a filed sale that has no stored device groups
 * (the already-filed recovery never re-reads the receipt): the lines' own
 * VAT-inclusive amounts per class, not the whole sale as class A. These are
 * gross, the same reading as the device's own groups (docs/phase-214); the
 * whole-receipt fallback likewise.
 *
 * @param {ReceiptLayoutLineItem[]} items
 * @param {string} fallbackA the whole-receipt gross amount, used when no line resolves to a class
 * @returns {ReceiptLayoutVatGroups}
 */
function groupsFromItems(items: ReceiptLayoutLineItem[], fallbackA: string): ReceiptLayoutVatGroups {
  const totals = expectedGroupTotals(items)
  const groups: ReceiptLayoutVatGroups = {}
  for (const letter of VAT_CLASSES) {
    if (items.some((item) => resolveVatClass(item.vatClass) === letter)) groups[letter] = String(totals[letter])
  }
  return Object.keys(groups).length > 0 ? groups : { A: fallbackA }
}

/**
 * Builds the printed layout for one receipt — the fiscal original, a
 * reprint, or a not-yet-filed sale slip, decided entirely from `order`'s
 * own fields (never guessed from context).
 *
 * @param {ReceiptLayoutOrder} order
 * @param {ReceiptLayoutSettings} settings
 * @param {object} options
 * @param {ReceiptWidth} [options.width]
 * @param {{ warn(message: string): void }} [options.logger] defaults to `console`; told when stored device VAT figures disagree with the till's
 * @returns {ReceiptLayoutEntry[]}
 */
export function buildReceiptLayout(
  order: ReceiptLayoutOrder,
  settings: ReceiptLayoutSettings,
  options: { width?: ReceiptWidth; logger?: { warn(message: string): void } } = {}
): ReceiptLayoutEntry[] {
  const width = options.width ?? DEFAULT_WIDTH
  const isFiscalised = Boolean(order.fiscalInvoiceNumber)
  const isSlip = !isFiscalised && Boolean(order.fiscalPending)
  const lineItems: ReceiptTotalsLineItem[] = order.items.map((item) => ({
    unitPrice: item.unitPrice,
    quantity: item.quantity,
    discount: item.discount,
    vatClass: item.vatClass
  }))
  const totals = computeReceiptTotals(
    { localId: order.localId, lineItems, cartDiscount: order.cartDiscount, total: order.total },
    settings.taxRate
  )

  const entries: ReceiptLayoutEntry[] = []
  const push = (...lines: ReceiptLayoutLine[]): void => {
    entries.push(...lines)
  }

  // --- top duplicate stamp (kept regardless of fiscal status) ---
  if (order.isDuplicate) {
    push(...wrappedLines('*** DUPLICATE ***', width, 'centre', 'bold'))
  }

  // --- (a) Header ---
  push(...wrappedLines(settings.tradingName, width, 'centre', 'double'))
  if (settings.legalName) push(...wrappedLines(settings.legalName, width))
  if (settings.address) push(...wrappedLines(settings.address, width))
  if (settings.phone) push(...wrappedLines(`Tel ${settings.phone}`, width))
  if (settings.sellerPin) push(...wrappedLines(`PIN: ${settings.sellerPin}`, width, 'centre', 'bold'))
  push(rule(width))

  // --- (b) Label ---
  if (isFiscalised) {
    // Marks where the fiscal document begins; the mock's test banner and a duplicate's
    // top stamp sit outside it. The sale record and the Enjoy slip never carry it.
    push(...wrappedLines(FISCAL_RECEIPT_START_MARKER, width))
    push(...wrappedLines('FISCAL RECEIPT', width, 'centre', 'double'))
    push(
      ...wrappedLines(
        order.isDuplicate ? '*** DUPLICATE ***' : 'ORIGINAL',
        width,
        'centre',
        order.isDuplicate ? 'bold' : 'normal'
      )
    )
    push(rule(width))
  } else if (isSlip) {
    push(...wrappedLines('SALE RECORD', width, 'centre', 'double'))
    push(...wrappedLines(NOT_A_TAX_INVOICE_LINE.toUpperCase(), width, 'centre', 'bold'))
    push(...wrappedLines('Tax invoice to follow', width))
    push(rule(width))
  }

  // --- (c) Details ---
  const dateTime = formatReceiptDateTime(order.createdAt)
  if (!isFiscalised) {
    push(...keyValueLines('Sale No:', String(order.localId), width))
  } else if (order.traderInvNum) {
    // The number the till sent to the device, stored at send time; an older
    // order with none stored omits the row rather than rebuild it.
    push(...keyValueLines('Invoice No:', order.traderInvNum, width))
  }
  push(...keyValueLines('Date:', dateTime, width))
  push(...keyValueLines('Cashier:', titleCaseName(order.cashierName), width))
  if (order.customerPin) push(...keyValueLines('Buyer PIN:', order.customerPin, width))
  if (order.buyerName) {
    const buyerLines = wrapText(order.buyerName, width - 'Buyer: '.length, 2)
    push(...keyValueLines('Buyer:', buyerLines[0], width))
    for (const extra of buyerLines.slice(1)) push(ln(extra.padStart(width)))
  }
  push(rule(width))

  // --- (d) Items ---
  push(...keyValueLines('ITEM', 'QTY   PRICE   AMOUNT', width, 'bold'))
  push(rule(width))
  for (const item of order.items) {
    push(...itemNameLines(item, width))
    push(itemAmountLine(item, width))
    push(...autoDiscountLines(item, width))
    const lineDiscount = item.discount
    if (lineDiscount && lineDiscount.value > 0) {
      const base = item.unitPrice * item.quantity
      const reduction =
        lineDiscount.type === 'percent' ? base * (lineDiscount.value / 100) : Math.min(lineDiscount.value, base)
      push(ln(`Discount: -${formatAmount(round2(reduction))}`, 'right'))
    }
  }
  push(rule(width))

  // --- (e) Totals ---
  push(...keyValueLines('TOTAL EXCL. VAT', formatAmount(round2(totals.total - totals.vatIncluded)), width))
  push(...keyValueLines('VAT', formatAmount(totals.vatIncluded), width))
  push(...keyValueLines('TOTAL KSH', formatAmount(totals.total), width, 'double'))
  push(rule(width))

  // --- (f) Payment ---
  if (order.paymentMethod === 'split') {
    // docs/phase-252 (D6): each payment as its own block, two lines for M-Pesa and card (label and amount, then the
    // reference) so a 32-column printer does not wrap; Tendered and Change only under the cash payment.
    for (const payment of order.payments ?? []) {
      push(...keyValueLines(`PAID BY ${PAYMENT_LABELS[payment.method]}`, formatAmount(payment.amount), width))
      if (payment.method === 'cash') {
        push(...keyValueLines('Tendered:', formatAmount(payment.tendered ?? payment.amount), width))
        push(...keyValueLines('Change:', formatAmount(payment.changeDue ?? 0), width))
      } else if (payment.reference) {
        push(...keyValueLines(payment.method === 'mpesa' ? 'M-Pesa ref:' : 'Ref:', payment.reference, width))
      }
    }
  } else {
    const paymentLabel = order.paymentMethod === 'mpesa' ? 'M-PESA' : order.paymentMethod === 'card' ? 'CARD' : 'CASH'
    push(...keyValueLines(`PAID BY ${paymentLabel}`, formatAmount(totals.total), width))
    if (order.paymentMethod === 'cash') {
      push(...keyValueLines('Tendered:', formatAmount(order.tenderedAmount), width))
      push(...keyValueLines('Change:', formatAmount(order.changeDue), width))
    } else if (order.referenceNumber) {
      const refLabel = order.paymentMethod === 'mpesa' ? 'M-Pesa ref:' : 'Ref:'
      push(...keyValueLines(refLabel, order.referenceNumber, width))
    }
  }
  push(rule(width))

  // --- (g) VAT table (fiscalised only) ---
  if (isFiscalised) {
    const hasDeviceGroups = Boolean(order.vatGroups && Object.keys(order.vatGroups).length > 0)
    const groups: ReceiptLayoutVatGroups = hasDeviceGroups
      ? order.vatGroups!
      : groupsFromItems(order.items, String(totals.rawSubtotal))
    wrapText('VAT RATE TAXABLE VAT GROSS', width).forEach((text) => push(ln(text, 'left', 'bold')))
    push(rule(width))
    for (const letter of ['A', 'B', 'C', 'D', 'E'] as const) {
      const raw = groups[letter]
      if (raw === undefined) continue
      const parsed = Number(raw)
      const gross = Number.isFinite(parsed) ? parsed : 0
      const figures = vatClassFigures(letter, gross)
      const row = `${letter} ${figures.rateLabel} ${formatAmount(figures.taxable)} ${figures.vatLabel} ${formatAmount(gross)}`
      wrapText(row, width).forEach((text) => push(ln(text)))
    }
    // Only the device's own figures are checked: a table built from the lines is the till's
    // arithmetic, so it agrees by construction. A mismatch is shown, never hidden.
    if (hasDeviceGroups) {
      const check = reconcileVatGroups(groups, totals)
      if (!check.consistent) {
        push(...wrappedLines(`Device figures. Till VAT: ${formatAmount(check.tillVat)}.`, width, 'left'))
        const logger = options.logger ?? console
        logger.warn(
          `[rubis-pos] Order ${order.localId}: the device's VAT groups add up to VAT ${check.groupVat} but the till's VAT is ${check.tillVat} (difference ${check.diff}). Printed the device figures with a note.`
        )
      }
    }
    push(rule(width))
  }

  // --- (h) CONTROL UNIT INFO (fiscalised only) ---
  if (isFiscalised) {
    push(...wrappedLines('CONTROL UNIT INFO', width))
    const fiscalLines = buildFiscalBlockLines(order)
    const byLabel = new Map(fiscalLines.map((text) => {
      const { label, value } = splitLabelValue(text)
      return [label, value] as const
    }))
    const dateLabel = [...byLabel.keys()].find((label) => label.startsWith('CU Date/Time') || label.startsWith('Till time'))
    if (dateLabel) push(...keyValueLines(dateLabel, byLabel.get(dateLabel)!, width))
    if (byLabel.has('CU Serial No:')) push(...keyValueLines('CU Serial No:', byLabel.get('CU Serial No:')!, width))
    if (byLabel.has('CU Invoice No:')) push(...keyValueLines('CU Invoice No:', byLabel.get('CU Invoice No:')!, width))
    if (order.fiscalQrCode) {
      entries.push({ qr: order.fiscalQrCode })
      push(...wrappedLines('Scan to verify this receipt with KRA', width))
    }
    push(rule(width))
    push(...wrappedLines(FISCAL_RECEIPT_END_MARKER, width))
  }

  // --- (i) Footer ---
  push(...wrappedLines(settings.footerMessage || 'Thank you for shopping at Enjoy!', width, 'centre', 'bold'))
  push(...wrappedLines(`${vatClassKeys(order.items).join('. ')}. Prices include VAT.`, width))

  // --- bottom duplicate stamp ---
  if (order.isDuplicate) {
    push(...wrappedLines('*** DUPLICATE ***', width, 'centre', 'bold'))
  }

  return settings.decorate ? settings.decorate(entries, { width }) : entries
}
