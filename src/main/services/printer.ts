/**
 * Thermal receipt printer service with multi-printer routing.
 *
 * Wraps `node-thermal-printer` behind a narrow, injectable interface
 * ({@link ThermalPrinterLike}) so unit tests can assert the exact
 * ESC/POS call sequence with a recording fake, following the same
 * dependency-injection pattern used by the Shopify and database
 * services elsewhere in this codebase.
 *
 * The printer interface targets TCP/IP (`tcp://<ip>:<port>`) rather
 * than a named Windows printer share — the latter requires the
 * `printer` native driver module, which would add a second fragile
 * native build to the project alongside `better-sqlite3`.
 *
 * A {@link PrinterRegistry} lets a store register a secondary
 * kitchen/label printer alongside the original receipt printer,
 * resolved by `PrinterType` rather than always targeting one hardcoded
 * interface — see {@link resolvePrinterSettings} and
 * {@link printReceiptToType}.
 */

import { ThermalPrinter, PrinterTypes } from 'node-thermal-printer'
import type { ServiceResult, Discount } from './shopify-types.js'
import type { ZReport } from './reports.js'
import { formatVatRateLabel } from './reports.js'
import type { PrinterConfig, PrinterType } from './database.js'
import { formatCurrency } from './currency.js'
import { generatePdfReceipt } from './pdf-receipt.js'
import { computeReceiptTotals } from '../lib/receiptTotals.js'
import type { ReceiptTotalsLineItem } from '../lib/receiptTotals.js'

/** Store-level configuration resolved once at startup from env vars / settings. */
export interface PrinterSettings {
  /** `tcp://<ip>:<port>` address of the ESC/POS printer. */
  interfaceName: string
  /** Printed centered/bold at the top of every receipt. */
  storeName: string
  /**
   * The store's own KRA PIN, printed under the store name so a customer
   * can identify who issued the receipt. Distinct from a sale's
   * `customerPin`, which is the *buyer's* PIN on a B2B invoice. Omitted
   * when the branch has not set one.
   */
  storeKraPin?: string
  /** Fractional tax rate applied to the subtotal (0.08 = 8%). */
  taxRate: number
  /** When true, skips hardware entirely and logs the receipt text. */
  mock?: boolean
}

/** The per-transaction fields a receipt needs — real data captured at checkout. */
export interface ReceiptOrder {
  localId: number
  createdAt: string
  cashierName: string
  paymentMethod: 'cash' | 'mpesa' | 'card'
  tenderedAmount: number
  changeDue: number
  referenceNumber?: string
  /** Customer's KRA PIN, when captured for a B2B eTIMS invoice — omitted for a walk-in B2C sale. */
  customerPin?: string
  /** KRA/eTIMS invoice number, when the sale was fiscalized. */
  fiscalInvoiceNumber?: string
  /** Base64 QR code payload returned (or generated) at fiscalization time. */
  fiscalQrCode?: string
  /** The amount actually charged (docs/phase-161) - printed verbatim, never recomputed. See {@link computeReceiptTotals}. */
  total: number
  /** Cart-level discount applied at checkout, when any (docs/phase-161). */
  cartDiscount?: Discount
}

/** One printed line item. */
export interface ReceiptLineItem {
  title: string
  variantTitle: string
  quantity: number
  unitPrice: number
  /** Line-level discount applied at checkout, when any (docs/phase-161). */
  discount?: Discount
}

/** Result data on a successful print. */
export interface ReceiptPrintResult {
  printed: boolean
  mock: boolean
  /** Set to `'pdf'` when the thermal printer was unreachable and a PDF receipt was saved instead. */
  mode?: 'pdf'
  /** Absolute path of the fallback PDF, present when `mode` is `'pdf'`. */
  filePath?: string
}

/**
 * Narrow surface of `node-thermal-printer`'s client this service
 * depends on. Real instances satisfy it structurally; tests substitute
 * a recording fake.
 */
export interface ThermalPrinterLike {
  isPrinterConnected(): Promise<boolean>
  alignCenter(): void
  alignLeft(): void
  bold(enabled: boolean): void
  println(text: string): void
  drawLine(): void
  cut(): void
  execute(): Promise<unknown>
  /** Prints a raster image from a decoded PNG buffer. Optional — absent on the mock sink. */
  printImageBuffer?(buffer: Buffer): Promise<unknown>
}

/** Builds a {@link ThermalPrinterLike} client for a given interface address. */
export type PrinterFactory = (interfaceName: string) => ThermalPrinterLike

/** Generates a PDF fallback receipt and returns its saved file path. */
export type PdfReceiptGenerator = (
  order: ReceiptOrder,
  items: ReceiptLineItem[],
  settings: PrinterSettings
) => Promise<string>

/**
 * Connect/socket timeout (ms) for the TCP/IP printer transport.
 * Bounds both `isPrinterConnected()`'s probe and
 * `execute()`'s data transmission — see `node-thermal-printer`'s
 * `Network` interface, which applies this same value to both. Without
 * it, a routable-but-dead printer IP can hang checkout for 20+ seconds
 * on the OS's default TCP timeout instead of failing fast.
 */
export const PRINTER_CONNECT_TIMEOUT_MS = 3000

/** Default factory backed by the real ESC/POS (EPSON dialect) client. */
export const defaultPrinterFactory: PrinterFactory = (interfaceName) =>
  new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface: interfaceName,
    options: { timeout: PRINTER_CONNECT_TIMEOUT_MS }
  }) as unknown as ThermalPrinterLike

/**
 * In-memory lookup of configured printers, keyed by {@link PrinterConfig.id}.
 * Built once at startup from
 * `RubisDatabase.getPrinters()` and rebuilt after any Admin-screen
 * add/edit/delete, so a lookup never re-reads the database mid-print.
 *
 * A `Map` rather than a held-open `Map<string, ThermalPrinterLike>` of
 * live client connections — this codebase already connects fresh per
 * print (`sendToPrinter` below) and bounds that connection with
 * {@link PRINTER_CONNECT_TIMEOUT_MS}; keeping a TCP socket to a thermal
 * printer open indefinitely between prints, with no reconnect logic,
 * would trade a solved problem (fast, bounded failure) for an
 * unsolved one (a socket gone stale hours into a shift). The registry
 * only needs to remember *where* each printer is, not hold a
 * connection to it.
 */
export type PrinterRegistry = Map<string, PrinterConfig>

/**
 * Builds a {@link PrinterRegistry} from the rows `RubisDatabase.getPrinters()`
 * returns.
 *
 * @param {PrinterConfig[]} configs
 * @returns {PrinterRegistry}
 */
export function buildPrinterRegistry(configs: PrinterConfig[]): PrinterRegistry {
  return new Map(configs.map((config) => [config.id, config]))
}

/**
 * Resolves the {@link PrinterSettings} to print a `type` document to:
 * the first enabled registry entry of that type, otherwise
 * `defaultSettings` unchanged.
 *
 * This is the backward-compatibility seam — a till with no
 * rows in the `printers` table (i.e. any store that never opens the
 * Peripherals tab) resolves every
 * lookup to `defaultSettings`, the same single env-configured printer
 * `receipt:print` always used before multi-printer support existed.
 *
 * @param {PrinterRegistry} registry
 * @param {PrinterType} type
 * @param {PrinterSettings} defaultSettings — the original single configured printer
 * @returns {PrinterSettings}
 */
export function resolvePrinterSettings(
  registry: PrinterRegistry,
  type: PrinterType,
  defaultSettings: PrinterSettings
): PrinterSettings {
  for (const config of registry.values()) {
    if (config.type === type && config.enabled) {
      return { ...defaultSettings, interfaceName: config.interfaceName }
    }
  }
  return defaultSettings
}

/**
 * Issues the ESC/POS formatting calls for one receipt onto a
 * {@link ThermalPrinterLike} sink. Exported so tests can verify the
 * exact print sequence independent of hardware/mock branching.
 *
 * Layout: store name (centered, bold) → order # → date/time → cashier
 * → customer KRA PIN, for a B2B sale → dashed line → items
 * (name/variant, qty, price) → dashed line → subtotal → discount (only
 * if any) → total (bold) → VAT included → payment method → "Thank
 * you!" → fiscal invoice number/QR code, when the sale was fiscalized.
 *
 * Subtotal/discount/total/VAT all come from {@link computeReceiptTotals}
 * (docs/phase-161 Commit 2) — `total` is always `order.total`, the
 * amount actually charged, never recomputed from `items` here.
 *
 * @param {ThermalPrinterLike} client
 * @param {ReceiptOrder} order
 * @param {ReceiptLineItem[]} items
 * @param {PrinterSettings} settings
 * @returns {Promise<void>}
 */
export async function renderReceipt(
  client: ThermalPrinterLike,
  order: ReceiptOrder,
  items: ReceiptLineItem[],
  settings: PrinterSettings
): Promise<void> {
  const lineItems: ReceiptTotalsLineItem[] = items.map((item) => ({
    unitPrice: item.unitPrice,
    quantity: item.quantity,
    discount: item.discount
  }))
  const totals = computeReceiptTotals(
    { localId: order.localId, lineItems, cartDiscount: order.cartDiscount, total: order.total },
    settings.taxRate
  )

  client.alignCenter()
  client.bold(true)
  client.println(settings.storeName)
  client.bold(false)
  if (settings.storeKraPin) {
    client.println(`PIN: ${settings.storeKraPin}`)
  }
  client.println(`Order #${order.localId}`)
  client.println(new Date(order.createdAt).toLocaleString())
  client.println(`Cashier: ${order.cashierName}`)
  if (order.customerPin) {
    client.println(`Customer PIN: ${order.customerPin}`)
  }
  client.drawLine()

  client.alignLeft()
  for (const item of items) {
    const label = item.variantTitle
      ? `${item.title} (${item.variantTitle})`
      : item.title
    client.println(`${label} x${item.quantity}`)
    client.println(`  ${formatCurrency(item.unitPrice * item.quantity)}`)
  }
  client.drawLine()

  client.println(`Subtotal: ${formatCurrency(totals.rawSubtotal)}`)
  if (totals.discountTotal > 0) {
    client.println(`Discount: -${formatCurrency(totals.discountTotal)}`)
  }
  client.bold(true)
  client.println(`Total: ${formatCurrency(totals.total)}`)
  client.bold(false)
  client.println(`${formatVatRateLabel(settings.taxRate)}: ${formatCurrency(totals.vatIncluded)}`)
  client.println(`Payment: ${order.paymentMethod}`)
  if (order.paymentMethod === 'cash') {
    client.println(`Tendered: ${formatCurrency(order.tenderedAmount)}`)
    client.println(`Change: ${formatCurrency(order.changeDue)}`)
  } else if (order.referenceNumber) {
    client.println(`Ref: ${order.referenceNumber}`)
  }

  client.alignCenter()
  client.println('Thank you!')

  if (order.fiscalInvoiceNumber || order.fiscalQrCode) {
    client.drawLine()
    if (order.fiscalInvoiceNumber) {
      client.println(`Fiscal Inv: ${order.fiscalInvoiceNumber}`)
    }
    if (order.fiscalQrCode) {
      await printFiscalQrCode(client, order.fiscalQrCode, order.fiscalInvoiceNumber)
    }
  }

  client.cut()
}

/**
 * Prints the eTIMS QR code as a raster image via
 * {@link ThermalPrinterLike.printImageBuffer}. Falls back to a plain-text
 * placeholder — rather than breaking the receipt layout — when the
 * client has no image support, or the buffer isn't a decodable PNG
 * (the fiscal device may return an opaque payload rather than image
 * bytes; see the module doc for the QR code roadmap).
 *
 * @param {ThermalPrinterLike} client
 * @param {string} qrCodeBase64
 * @param {string} [invoiceNumber]
 */
async function printFiscalQrCode(
  client: ThermalPrinterLike,
  qrCodeBase64: string,
  invoiceNumber?: string
): Promise<void> {
  if (client.printImageBuffer) {
    try {
      await client.printImageBuffer(Buffer.from(qrCodeBase64, 'base64'))
      return
    } catch {
      // Not a decodable image — fall through to the text placeholder.
    }
  }
  client.println(`[QR CODE: ${invoiceNumber ?? qrCodeBase64.slice(0, 12)}]`)
}

/**
 * Issues the ESC/POS formatting calls for a Z-report onto a
 * {@link ThermalPrinterLike} sink — no line items, just shift totals.
 *
 * Layout: store name + "Z-REPORT" (centered, bold) → shift #/opened/
 * closed/cashier → dashed line → starting cash + per-method sales →
 * dashed line → total revenue (bold) + tax → dashed line → expected
 * cash, counted cash, discrepancy (bold).
 *
 * @param {ThermalPrinterLike} client
 * @param {ZReport} report
 * @param {PrinterSettings} settings
 */
export function renderZReport(
  client: ThermalPrinterLike,
  report: ZReport,
  settings: PrinterSettings
): void {
  client.alignCenter()
  client.bold(true)
  client.println(settings.storeName)
  client.println('Z-REPORT')
  client.bold(false)
  client.println(`Shift #${report.shiftId}`)
  client.println(`Opened: ${new Date(report.openedAt).toLocaleString()}`)
  client.println(
    `Closed: ${report.closedAt ? new Date(report.closedAt).toLocaleString() : 'In progress'}`
  )
  client.println(`Cashier: ${report.staffName}`)
  client.drawLine()

  client.alignLeft()
  client.println(`Starting Cash: ${formatCurrency(report.startingCash)}`)
  client.println(`Cash Sales: ${formatCurrency(report.totalsByMethod.cash)}`)
  client.println(`M-Pesa Sales: ${formatCurrency(report.totalsByMethod.mpesa)}`)
  client.println(`Card Sales: ${formatCurrency(report.totalsByMethod.card)}`)
  client.println(`Orders: ${report.orderCount}`)
  client.drawLine()

  client.bold(true)
  client.println(`Total Revenue: ${formatCurrency(report.totalRevenue)}`)
  client.bold(false)
  client.println(`${formatVatRateLabel(report.vatRate)}: ${formatCurrency(report.vatIncluded)}`)
  client.drawLine()

  client.println(`Expected Cash: ${formatCurrency(report.expectedCash)}`)
  client.println(
    `Counted Cash: ${report.endingCash !== null ? formatCurrency(report.endingCash) : 'Pending'}`
  )
  client.bold(true)
  client.println(
    `Discrepancy: ${report.discrepancy !== null ? formatCurrency(report.discrepancy) : 'Pending'}`
  )
  client.bold(false)

  client.cut()
}

/**
 * Builds an in-memory {@link ThermalPrinterLike} that records printed
 * lines instead of talking to hardware, used for `settings.mock`.
 *
 * @returns the sink client plus the accumulated plain-text lines
 */
function createMockSink(): { client: ThermalPrinterLike; lines: string[] } {
  const lines: string[] = []
  const client: ThermalPrinterLike = {
    isPrinterConnected: async () => true,
    alignCenter: () => {},
    alignLeft: () => {},
    bold: () => {},
    println: (text) => lines.push(text),
    drawLine: () => lines.push('--------------------------------'),
    cut: () => {},
    execute: async () => undefined
  }
  return { client, lines }
}

/**
 * True when `err` carries one of the TCP failure codes that mean the
 * printer itself is offline or unreachable, as opposed to a hardware
 * fault (out of paper, etc.) on an otherwise-connected printer. Used
 * to decide whether {@link printReceipt} should fall back to a PDF
 * receipt.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isPrinterOfflineError(err: unknown): boolean {
  if (!err || typeof err !== 'object' || !('code' in err)) return false
  const code = (err as { code?: string }).code
  return code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ETIMEDOUT'
}

/**
 * Translates a printer/transport failure into a POS-safe message.
 *
 * @param {unknown} err
 * @returns {string}
 */
function translatePrinterError(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: string }).code
    if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH') {
      return 'Printer unreachable — check the network connection and printer power'
    }
    if (code === 'ETIMEDOUT') {
      return 'Printer connection timed out'
    }
  }
  const message = err instanceof Error ? err.message : String(err)
  if (/paper/i.test(message)) {
    return 'Printer error — check paper and try again'
  }
  if (/timeout/i.test(message)) {
    return 'Printer connection timed out'
  }
  return `Printer error — ${message}`
}

/**
 * Shared connect/render/execute/mock-logging flow for both receipts
 * and Z-reports — the only difference between the two is which
 * `render*` function draws onto the client.
 *
 * When `onOfflineFallback` is given and the printer turns out to be
 * offline or unreachable (connection probe fails, or `execute()`
 * throws a network error), its result is returned instead of a
 * failure — used by {@link printReceipt} to fall back to a PDF
 * receipt. Callers with no meaningful fallback (Z-reports, test
 * pages) omit it and keep failing as before.
 *
 * @param {(client: ThermalPrinterLike) => void | Promise<void>} render
 * @param {PrinterSettings} settings
 * @param {PrinterFactory} factory
 * @param {string} mockLogLabel — identifies the document in the mock-mode console log
 * @param {() => Promise<ServiceResult<ReceiptPrintResult>>} [onOfflineFallback]
 * @returns {Promise<ServiceResult<ReceiptPrintResult>>}
 */
async function sendToPrinter(
  render: (client: ThermalPrinterLike) => void | Promise<void>,
  settings: PrinterSettings,
  factory: PrinterFactory,
  mockLogLabel: string,
  onOfflineFallback?: () => Promise<ServiceResult<ReceiptPrintResult>>
): Promise<ServiceResult<ReceiptPrintResult>> {
  const usingMock = settings.mock === true
  const sink = usingMock ? createMockSink() : null
  const client = sink ? sink.client : factory(settings.interfaceName)

  try {
    if (!usingMock) {
      const connected = await client.isPrinterConnected()
      if (!connected) {
        if (onOfflineFallback) return onOfflineFallback()
        return {
          success: false,
          error: 'Printer offline or unreachable — check the connection and try again'
        }
      }
    }

    await render(client)
    await client.execute()

    if (sink) {
      console.log(`[rubis-pos] MOCK PRINT — ${mockLogLabel}\n${sink.lines.join('\n')}`)
    }

    return { success: true, data: { printed: true, mock: usingMock } }
  } catch (err) {
    if (onOfflineFallback && isPrinterOfflineError(err)) {
      return onOfflineFallback()
    }
    return { success: false, error: translatePrinterError(err) }
  }
}

/**
 * Builds a {@link ReceiptPrintResult} for a receipt saved as a PDF
 * fallback, or a failure result if PDF generation itself throws.
 *
 * @param {ReceiptOrder} order
 * @param {ReceiptLineItem[]} items
 * @param {PrinterSettings} settings
 * @param {PdfReceiptGenerator} pdfGenerator
 * @returns {Promise<ServiceResult<ReceiptPrintResult>>}
 */
async function fallBackToPdf(
  order: ReceiptOrder,
  items: ReceiptLineItem[],
  settings: PrinterSettings,
  pdfGenerator: PdfReceiptGenerator
): Promise<ServiceResult<ReceiptPrintResult>> {
  try {
    const filePath = await pdfGenerator(order, items, settings)
    return { success: true, data: { printed: false, mock: false, mode: 'pdf', filePath } }
  } catch (err) {
    return { success: false, error: translatePrinterError(err) }
  }
}

/**
 * Formats and sends a receipt to the configured thermal printer.
 *
 * When `settings.mock` is set, no hardware is contacted — the
 * formatted receipt is logged to the console instead so a demo can
 * proceed without a physical printer. When the printer is offline or
 * unreachable, a PDF receipt is generated and saved instead of
 * failing the print outright — see {@link fallBackToPdf}.
 *
 * @param {ReceiptOrder} order
 * @param {ReceiptLineItem[]} items
 * @param {PrinterSettings} settings
 * @param {PrinterFactory} [factory] — injected client factory for testing
 * @param {PdfReceiptGenerator} [pdfGenerator] — injected PDF fallback generator for testing
 * @returns {Promise<ServiceResult<ReceiptPrintResult>>}
 */
export async function printReceipt(
  order: ReceiptOrder,
  items: ReceiptLineItem[],
  settings: PrinterSettings,
  factory: PrinterFactory = defaultPrinterFactory,
  pdfGenerator: PdfReceiptGenerator = generatePdfReceipt
): Promise<ServiceResult<ReceiptPrintResult>> {
  return sendToPrinter(
    (client) => renderReceipt(client, order, items, settings),
    settings,
    factory,
    `Order #${order.localId}`,
    () => fallBackToPdf(order, items, settings, pdfGenerator)
  )
}

/**
 * Formats and sends a Z-report to the configured thermal printer.
 *
 * @param {ZReport} report
 * @param {PrinterSettings} settings
 * @param {PrinterFactory} [factory] — injected client factory for testing
 * @returns {Promise<ServiceResult<ReceiptPrintResult>>}
 */
export async function printZReport(
  report: ZReport,
  settings: PrinterSettings,
  factory: PrinterFactory = defaultPrinterFactory
): Promise<ServiceResult<ReceiptPrintResult>> {
  return sendToPrinter(
    (client) => renderZReport(client, report, settings),
    settings,
    factory,
    `Z-Report Shift #${report.shiftId}`
  )
}

/**
 * Formats and sends a receipt to whichever printer `registry` has
 * registered for `printerType`, falling back to `defaultSettings`
 * when none is configured (see {@link resolvePrinterSettings}
 * for the backward-compatibility rule this relies on).
 *
 * @param {ReceiptOrder} order
 * @param {ReceiptLineItem[]} items
 * @param {PrinterRegistry} registry
 * @param {PrinterSettings} defaultSettings
 * @param {PrinterType} [printerType] — defaults to `'receipt'`
 * @param {PrinterFactory} [factory] — injected client factory for testing
 * @param {PdfReceiptGenerator} [pdfGenerator] — injected PDF fallback generator for testing
 * @returns {Promise<ServiceResult<ReceiptPrintResult>>}
 */
export async function printReceiptToType(
  order: ReceiptOrder,
  items: ReceiptLineItem[],
  registry: PrinterRegistry,
  defaultSettings: PrinterSettings,
  printerType: PrinterType = 'receipt',
  factory: PrinterFactory = defaultPrinterFactory,
  pdfGenerator: PdfReceiptGenerator = generatePdfReceipt
): Promise<ServiceResult<ReceiptPrintResult>> {
  const settings = resolvePrinterSettings(registry, printerType, defaultSettings)
  return printReceipt(order, items, settings, factory, pdfGenerator)
}

/**
 * Sends a short, self-describing test page to `interfaceName` —
 * bypasses the registry entirely so the Admin screen's Peripherals
 * tab can verify connectivity for a printer before (or instead of)
 * saving it. Never runs in mock mode — a test page exists specifically
 * to exercise the real hardware connection.
 *
 * @param {string} interfaceName — `tcp://<ip>:<port>`
 * @param {PrinterFactory} [factory] — injected client factory for testing
 * @returns {Promise<ServiceResult<ReceiptPrintResult>>}
 */
export async function printTestPage(
  interfaceName: string,
  factory: PrinterFactory = defaultPrinterFactory
): Promise<ServiceResult<ReceiptPrintResult>> {
  return sendToPrinter(
    (client) => {
      client.alignCenter()
      client.bold(true)
      client.println('RUBIS POS')
      client.println('TEST PAGE')
      client.bold(false)
      client.println(new Date().toLocaleString())
      client.drawLine()
      client.println('If you can read this, the printer')
      client.println('is connected and working.')
      client.cut()
    },
    { interfaceName, storeName: 'RUBIS POS', taxRate: 0 },
    factory,
    `Test Page (${interfaceName})`
  )
}
