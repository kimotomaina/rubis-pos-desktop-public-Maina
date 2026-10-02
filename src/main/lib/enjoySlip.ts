/**
 * The Enjoy customer slip (docs/phase-198): the friendly receipt a shopper
 * keeps, printed after the KRA fiscal slip. It is not a tax document, so it
 * carries no fiscal numbers (none of the control unit's), no VAT table and no
 * QR code. The one number on it is the trader invoice number the till sent to
 * the device ("Receipt"), which the shop's own system issued.
 *
 * Built beside {@link buildReceiptLayout} and returning the same entry shape,
 * so the thermal renderer and the PDF renderer walk it unchanged.
 */

import type { ReceiptLayoutEntry, ReceiptLayoutOrder, ReceiptWidth } from './receiptLayout.js'
import { formatAmount, keyValueLines, ln, rule, wrappedLines } from './receiptLayout.js'
import { discountAmount } from './receiptTotals.js'

/**
 * Every string the slip prints, in one place so the shop can change the
 * wording without touching the layout code below.
 */
export const ENJOY_SLIP_TEXT = {
  brand: 'E N J O Y',
  servedBy: 'Served by:',
  receipt: 'Receipt',
  discount: 'Discount',
  total: 'TOTAL',
  currency: 'KSh',
  paidBy: 'Paid by',
  change: 'Change',
  tender: { cash: 'cash', mpesa: 'M-Pesa', card: 'card' },
  thanks: ['Thanks for stopping by!', 'We hope you enjoyed your visit.', 'See you again soon.'],
  kraPrinted: 'Your KRA tax invoice is printed separately.',
  kraPending: ['Your KRA tax invoice will follow.', 'Please keep this receipt.'],
  duplicate: '*** DUPLICATE ***'
} as const

/** Where the shopper's KRA tax invoice stands, decided by the caller from what actually happened. */
export type EnjoySlipKraNote = 'printed' | 'pending' | 'none'

/** The shop identity the slip prints under its heading. */
export interface EnjoySlipSettings {
  /** The shop's location name, e.g. its branch. Omitted when unset. */
  locationName?: string
  /** The shop's street address. Omitted when unset. */
  address?: string
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Formats an ISO timestamp as `dd Mon yyyy HH:mm`, in local time. */
export function formatEnjoyDateTime(iso: string): string {
  const date = new Date(iso)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getDate())} ${MONTHS[date.getMonth()]} ${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function money(value: number): string {
  return `${ENJOY_SLIP_TEXT.currency} ${formatAmount(value)}`
}

/** The cashier's first name; the whole text when it has no space. */
function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? ''
}

/**
 * One item: name on the left, `qty x unit   line total` on the right. A name
 * too long to share the row goes on its own (up to two) lines above it.
 *
 * @param {string} name
 * @param {string} figures
 * @param {number} width
 */
function itemLines(name: string, figures: string, width: number): ReceiptLayoutEntry[] {
  if (name.length + 1 + figures.length <= width) return keyValueLines(name, figures, width)
  return [...wrappedLines(name, width, 'left').slice(0, 2), ln(figures, 'right')]
}

/**
 * Builds the Enjoy slip for one sale.
 *
 * Takes the same order object the fiscal slip is built from, but reads only the
 * sale's own fields: never `fiscalInvoiceNumber`, `cuSerial`, `fiscalQrCode` or
 * the VAT groups. The line totals come from each line's own price and discount;
 * the TOTAL is the order's stored total, and any difference between the two (a
 * cart-level discount) is shown as one Discount row so the page adds up.
 *
 * @param {ReceiptLayoutOrder} order
 * @param {EnjoySlipSettings} settings
 * @param {object} options
 * @param {ReceiptWidth} options.width characters per line
 * @param {EnjoySlipKraNote} options.kraNote which KRA line to print
 * @returns {ReceiptLayoutEntry[]}
 */
export function buildEnjoySlip(
  order: ReceiptLayoutOrder,
  settings: EnjoySlipSettings,
  options: { width: ReceiptWidth; kraNote: EnjoySlipKraNote }
): ReceiptLayoutEntry[] {
  const { width, kraNote } = options
  const text = ENJOY_SLIP_TEXT
  const entries: ReceiptLayoutEntry[] = []
  const push = (...lines: ReceiptLayoutEntry[]): void => {
    entries.push(...lines)
  }

  if (order.isDuplicate) push(...wrappedLines(text.duplicate, width, 'centre', 'bold'))

  push(...wrappedLines(text.brand, width, 'centre', 'double'))
  if (settings.locationName) push(...wrappedLines(settings.locationName, width))
  if (settings.address) push(...wrappedLines(settings.address, width))
  push(rule(width))

  push(...keyValueLines(formatEnjoyDateTime(order.createdAt), `${text.servedBy} ${firstName(order.cashierName)}`, width))
  if (order.traderInvNum) push(ln(`${text.receipt} ${order.traderInvNum}`))
  push(rule(width))

  let linesTotal = 0
  for (const item of order.items) {
    const base = item.unitPrice * item.quantity
    const net = round2(base - discountAmount(base, item.discount))
    linesTotal += net
    const figures = `${item.quantity} x ${formatAmount(item.unitPrice)}   ${formatAmount(net)}`
    push(...itemLines(item.title.toUpperCase(), figures, width))
  }
  push(rule(width))

  const cartReduction = round2(linesTotal - order.total)
  if (cartReduction > 0.005) push(...keyValueLines(text.discount, `-${money(cartReduction)}`, width))
  push(...keyValueLines(text.total, money(order.total), width, 'bold'))

  const paid = order.paymentMethod === 'cash' && order.tenderedAmount > 0 ? order.tenderedAmount : order.total
  push(...keyValueLines(`${text.paidBy} ${text.tender[order.paymentMethod]}`, money(paid), width))
  if (order.paymentMethod === 'cash' && order.changeDue > 0) {
    push(...keyValueLines(text.change, money(order.changeDue), width))
  }
  push(rule(width))

  for (const line of text.thanks) push(...wrappedLines(line, width))
  if (kraNote === 'printed') push(...wrappedLines(text.kraPrinted, width))
  if (kraNote === 'pending') for (const line of text.kraPending) push(...wrappedLines(line, width))

  if (order.isDuplicate) push(...wrappedLines(text.duplicate, width, 'centre', 'bold'))

  return entries
}
