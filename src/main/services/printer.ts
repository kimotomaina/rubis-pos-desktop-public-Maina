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
import type { PrinterConfig, PrinterType, PrinterConnectionType, FiscalStatus } from './database.js'
import { formatCurrency } from './currency.js'
import type { ConnectivityCheckResult } from './connectivityMonitor.js'
import type { SalePayment } from '../lib/paymentLegs.js'
import type { AppliedAutoDiscount } from '../lib/autoDiscounts.js'
import { zReportMpesaLines } from '../lib/zReportMpesa.js'
import { zReportCardLines } from '../lib/zReportCard.js'
import { zReportRetroLines } from '../lib/zReportRetro.js'
import { zReportChangeBlocks, zReportLabelledLine, zReportMergedLine, zReportSalesAtCloseLine } from '../lib/zReportAdjustments.js'
import { generatePdfReceipt } from './pdf-receipt.js'
import { buildReceiptLayout, isReceiptLayoutQr, asReceiptWidth } from '../lib/receiptLayout.js'
import { buildEnjoySlip } from '../lib/enjoySlip.js'
import type { EnjoySlipKraNote } from '../lib/enjoySlip.js'
import type {
  ReceiptLayoutEntry,
  ReceiptLayoutOrder,
  ReceiptLayoutLineItem,
  ReceiptLayoutVatGroups,
  ReceiptWidth
} from '../lib/receiptLayout.js'
import type { WindowsPrintSender } from './windowsPrinter.js'
import { sendRawToWindowsPrinter } from './windowsPrinter.js'

export type { ReceiptLayoutVatGroups, ReceiptWidth } from '../lib/receiptLayout.js'

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
  /** Registered company name (docs/phase-171) — omitted when unset. */
  legalName?: string
  /** Branch/shop name and street address, one line (docs/phase-171) — omitted when unset. */
  address?: string
  /** Phone number, printed as "Tel <phone>" (docs/phase-171) — omitted when unset. */
  phone?: string
  /** Printed centred above the VAT key at the very bottom (docs/phase-171). Defaults to "Thank you for shopping at Enjoy!". */
  footerMessage?: string
  /** Characters per printed line — 48 (80mm Font A, default), 42 or 32 (58mm) (docs/phase-171). */
  width?: ReceiptWidth
  /** Fractional tax rate applied to the subtotal (0.08 = 8%). */
  taxRate: number
  /** When true, skips hardware entirely and logs the receipt text. */
  mock?: boolean
  /**
   * Defaults to `'network'` when absent — every till configured before
   * docs/phase-174. `'windows'` sends RAW ESC/POS to a Windows printer
   * queue (USB or COM/serial) instead of over TCP/IP — see
   * `windowsPrinter.ts`. Either way `interfaceName` is the address:
   * `tcp://<ip>:<port>` for `'network'`, the queue's system name for
   * `'windows'`.
   */
  connectionType?: PrinterConnectionType
  /** The shop's location name, printed under the heading of the Enjoy customer slip (docs/phase-198) — omitted when unset. */
  locationName?: string
  /**
   * What a failure message calls this printer (docs/phase-228): the type of the registered printer it resolved to,
   * such as "Receipt". Absent on the default settings, which {@link describePrinter} calls "Receipt".
   */
  printerLabel?: string
  /**
   * Set only when a development stand-in provider is running: marks the fiscal
   * slip as a test (docs/phase-198). Never set with the real provider.
   */
  decorateFiscalSlip?: (entries: ReceiptLayoutEntry[], options: { width: number }) => ReceiptLayoutEntry[]
}

/** The per-transaction fields a receipt needs — real data captured at checkout. */
export interface ReceiptOrder {
  localId: number
  createdAt: string
  cashierName: string
  paymentMethod: 'cash' | 'mpesa' | 'card' | 'split'
  tenderedAmount: number
  changeDue: number
  referenceNumber?: string
  /** A split sale's payments, from its order payload (docs/phase-252). */
  payments?: SalePayment[]
  /** Customer's KRA PIN, when captured for a B2B eTIMS invoice — omitted for a walk-in B2C sale. */
  customerPin?: string
  /** Buyer's company/trading name, read from `fiscal_request_json` (docs/phase-171, docs/phase-157) — omitted otherwise. */
  buyerName?: string
  /** KRA/eTIMS invoice number, when the sale was fiscalized. */
  fiscalInvoiceNumber?: string
  /** The trader invoice number stored when the sale was sent to the device (docs/phase-198) — omitted for an older sale. */
  traderInvNum?: string
  /** The device's own QR verification text (a URL, up to 128 characters, per docs/phase-110) — never an image (docs/phase-171's audit). */
  fiscalQrCode?: string
  /** The device's five per-VAT-group taxable (ex-VAT) subtotals (docs/phase-171) — printed in the VAT table when present. */
  vatGroups?: ReceiptLayoutVatGroups
  /** The control unit's own date/time stamp, stored verbatim (docs/phase-164). See {@link buildFiscalBlockLines}. */
  fiscalizedAt?: string
  /** Where {@link fiscalizedAt} came from (docs/phase-164). */
  fiscalizedAtSource?: 'device' | 'local-fallback'
  /** The control unit's own serial number (docs/phase-164). */
  cuSerial?: string
  /**
   * Set only for the automatic end-of-sale print (docs/phase-165), on the
   * real provider, of a sale that hasn't fiscalized yet — prints
   * `FISCAL_PENDING_HEADER` at the top and `NOT_A_TAX_INVOICE_LINE` where
   * the CU block would be, instead of either. Decided by the caller
   * (`main/index.ts`'s `receipt:print` handler); ignored once
   * `fiscalInvoiceNumber` is present.
   */
  fiscalPending?: boolean
  /**
   * True when this is not the first successful print of this sale's
   * receipt (docs/phase-164) — stamps "DUPLICATE" at the top and bottom
   * so a reprint can never be mistaken for the original. Decided by the
   * caller (`main/index.ts`'s `receipt:print` handler), from whether
   * `orders.receipt_printed_at` was already set before this attempt —
   * never guessed here.
   */
  isDuplicate?: boolean
  /**
   * Whether the Enjoy customer slip is stamped "DUPLICATE" (docs/phase-198).
   * Decided by the caller from `orders.customer_slip_printed_at`: only a slip
   * that already reached paper once makes the next one a duplicate
   * (docs/phase-198-1). Falls back to {@link isDuplicate} when absent.
   */
  customerSlipIsDuplicate?: boolean
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
  /** KRA VAT class letter, from `fiscal_request_json` when known (docs/phase-171) — defaults to `'A'` otherwise. */
  vatClass?: string
  /** The automatic discount this line was sold under (docs/phase-253-2). */
  autoDiscount?: AppliedAutoDiscount
}

/** Result data on a successful print. */
export interface ReceiptPrintResult {
  printed: boolean
  mock: boolean
  /** Set to `'pdf'` when the thermal printer was unreachable and a PDF receipt was saved instead. */
  mode?: 'pdf'
  /** Absolute path of the fallback PDF, present when `mode` is `'pdf'`. */
  filePath?: string
  /**
   * How the separate Enjoy customer slip went (docs/phase-198): absent when it
   * was not asked for. It fails or succeeds independently of the fiscal slip.
   */
  customerSlip?: 'printed' | 'failed'
  /** Why the customer slip failed, when it did. */
  customerSlipError?: string
}

/**
 * Whether a `receipt:print` attempt's outcome should mark this sale's
 * receipt as physically printed (docs/phase-164-1) — true only when BOTH:
 * the print was a real physical print (`result.data.mode !== 'pdf'` —
 * mock-mode counts as physical, since it stands in for the real printer
 * rather than the PDF fallback), AND the order was fiscalised at print
 * time, so the page that came out actually carried the CU block.
 *
 * Extracted as its own pure function, rather than left inline in
 * `main/index.ts`'s `receipt:print` handler, specifically so this exact
 * gating is directly testable — that handler's IPC wiring itself is not
 * unit tested anywhere in this codebase (docs/phase-164-1's audit).
 *
 * @param {ServiceResult<ReceiptPrintResult>} result
 * @param {string | null | undefined} fiscalInvoiceNumber
 * @returns {boolean}
 */
export function shouldMarkReceiptPrinted(
  result: ServiceResult<ReceiptPrintResult>,
  fiscalInvoiceNumber: string | null | undefined
): boolean {
  return result.success && result.data?.mode !== 'pdf' && !!fiscalInvoiceNumber
}

/**
 * Whether a print should show the not-yet-filed slip wording
 * (docs/phase-165) — true only on the real fiscal provider, for an order
 * that hasn't fiscalized yet. Never on the mock/non-eTIMS provider, which
 * has no KRA filing to promise. Extracted as its own pure function for
 * the same reason as {@link shouldMarkReceiptPrinted} — directly
 * testable, since `main/index.ts`'s `receipt:print` handler itself is
 * not unit tested anywhere in this codebase.
 *
 * @param {boolean} isRealProvider
 * @param {FiscalStatus | null} fiscalStatus
 * @returns {boolean}
 */
export function shouldShowFiscalPendingSlip(
  isRealProvider: boolean,
  fiscalStatus: FiscalStatus | null
): boolean {
  return isRealProvider && fiscalStatus !== 'fiscalized'
}

/**
 * Whether a `receipt:print` result's PDF fallback should be opened in the
 * OS's default viewer immediately (docs/phase-165) — true for a manual
 * print (today's behaviour, unchanged), false for the automatic
 * end-of-sale print, which shows one toast instead of a pop-up window
 * (see `autoPrintToast.ts`'s `getAutoPrintOfflineMessage` on the renderer
 * side). Extracted for the same reason as {@link shouldMarkReceiptPrinted}.
 *
 * @param {boolean | undefined} auto
 * @returns {boolean}
 */
export function shouldOpenPdfFallbackViewer(auto: boolean | undefined): boolean {
  return !auto
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
  alignRight(): void
  bold(enabled: boolean): void
  setTextNormal(): void
  /** Sets double height and width together — used for the layout's `'double'` style. */
  setTextQuadArea(): void
  println(text: string): void
  drawLine(): void
  cut(): void
  execute(): Promise<unknown>
  /** Prints a QR code from its native command, from plain text — never an image (docs/phase-171). Optional — absent on the mock sink. */
  printQR?(text: string): void
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

/** What a failure message calls each type of printer (docs/phase-228). */
const PRINTER_TYPE_LABELS: Record<PrinterType, string> = { receipt: 'Receipt', kitchen: 'Kitchen', label: 'Label' }

/** What a failure message calls the default printer, which has no registered type. */
const DEFAULT_PRINTER_LABEL = 'Receipt'

/**
 * Says which printer a print was aimed at, for a failure message or a log line (docs/phase-228): a network printer
 * by its type and address, a Windows queue by its name. Nothing else.
 *
 * @param {Pick<PrinterSettings, 'interfaceName' | 'connectionType' | 'printerLabel'>} settings
 * @returns {string} for example `Printer "Receipt" (tcp://192.168.1.50:9100)` or `Printer "EPSON TM-T88"`
 */
export function describePrinter(
  settings: Pick<PrinterSettings, 'interfaceName' | 'connectionType' | 'printerLabel'>
): string {
  if (settings.connectionType === 'windows') return `Printer "${settings.interfaceName}"`
  return `Printer "${settings.printerLabel ?? DEFAULT_PRINTER_LABEL}" (${settings.interfaceName})`
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
      return {
        ...defaultSettings,
        interfaceName: config.interfaceName,
        width: asReceiptWidth(config.width) ?? defaultSettings.width,
        connectionType: config.connectionType,
        printerLabel: PRINTER_TYPE_LABELS[type]
      }
    }
  }
  return defaultSettings
}

/**
 * Renders one receipt onto a {@link ThermalPrinterLike} sink by walking
 * {@link buildReceiptLayout}'s output — the same array
 * {@link generatePdfReceipt} renders. This function owns no receipt
 * content or wording of its own any more (docs/phase-171); it only
 * translates each entry into ESC/POS calls:
 *
 *   - `align` picks `alignLeft`/`alignCenter`/`alignRight`.
 *   - `style: 'double'` wraps the line in `setTextQuadArea()` (bold);
 *     `'bold'` wraps it in `bold(true)`; `'normal'` prints it plain.
 *   - a `{ qr }` entry prints the device's own QR text with the
 *     printer's native `printQR` command when the client supports it
 *     (real hardware always does — see docs/phase-171's audit of
 *     `node-thermal-printer`'s API); otherwise a plain-text placeholder,
 *     since a receipt must never be left silently missing a whole entry.
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
  const layoutOrder: ReceiptLayoutOrder = {
    ...order,
    items: items.map(
      (item): ReceiptLayoutLineItem => ({
        title: item.title,
        variantTitle: item.variantTitle,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discount: item.discount,
        vatClass: item.vatClass,
        ...(item.autoDiscount ? { autoDiscount: item.autoDiscount } : {})
      })
    )
  }
  const entries = buildReceiptLayout(
    layoutOrder,
    {
      taxRate: settings.taxRate,
      tradingName: settings.storeName,
      legalName: settings.legalName,
      address: settings.address,
      phone: settings.phone,
      sellerPin: settings.storeKraPin,
      footerMessage: settings.footerMessage,
      decorate: settings.decorateFiscalSlip
    },
    { width: settings.width }
  )
  renderEntries(client, entries)
}

/**
 * Walks a layout's entries onto the printer and cuts — shared by the fiscal
 * slip and the Enjoy customer slip (docs/phase-198), so each is its own job
 * with its own cut.
 *
 * @param {ThermalPrinterLike} client
 * @param {ReceiptLayoutEntry[]} entries
 */
function renderEntries(client: ThermalPrinterLike, entries: ReceiptLayoutEntry[]): void {
  for (const entry of entries) {
    if (isReceiptLayoutQr(entry)) {
      if (client.printQR) {
        client.printQR(entry.qr)
      } else {
        client.println(`[QR: ${entry.qr}]`)
      }
      continue
    }

    if (entry.align === 'left') client.alignLeft()
    else if (entry.align === 'right') client.alignRight()
    else client.alignCenter()

    if (entry.style === 'double') {
      client.setTextQuadArea()
      client.bold(true)
      client.println(entry.text)
      client.bold(false)
      client.setTextNormal()
    } else if (entry.style === 'bold') {
      client.bold(true)
      client.println(entry.text)
      client.bold(false)
    } else {
      client.println(entry.text)
    }
  }

  client.cut()
}

/**
 * Issues the ESC/POS formatting calls for a Z-report onto a
 * {@link ThermalPrinterLike} sink — no line items, just shift totals.
 *
 * Layout: store name + "Z-REPORT" (centered, bold) → shift #/opened/
 * closed/cashier → dashed line → starting cash + per-method sales →
 * dashed line → total revenue (bold) + tax → dashed line → expected
 * cash, counted cash, discrepancy (bold) → dashed line → the M-Pesa
 * balances (docs/phase-222) → for each correction of the typed-in figures, a dashed
 * line, its heading (bold) and the figures it gives (docs/phase-224).
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
  if (report.shiftWindowLabel) {
    client.println(report.shiftWindowLabel)
  }
  const labelled = zReportLabelledLine(report)
  if (labelled) {
    client.println(labelled)
  }
  // docs/phase-239: a shift merged into another says so first; its figures below are history.
  const merged = zReportMergedLine(report, (iso) => new Date(iso).toLocaleString())
  if (merged) {
    client.bold(true)
    client.println(merged)
    client.bold(false)
  }
  client.println(`Opened: ${new Date(report.openedAt).toLocaleString()}`)
  client.println(
    `Closed: ${report.closedAt ? new Date(report.closedAt).toLocaleString() : 'In progress'}`
  )
  // docs/phase-223: a shift recorded afterwards says so, and who recorded it, instead of naming a cashier.
  const retroLines = zReportRetroLines(report, (iso) => new Date(iso).toLocaleString())
  if (retroLines.length > 0) {
    client.bold(true)
    for (const line of retroLines) client.println(line)
    client.bold(false)
  } else {
    client.println(`Opened by: ${report.staffName}`)
  }
  client.drawLine()

  client.alignLeft()
  // docs/phase-227: nobody counted the drawer, so there is no starting cash to print.
  if (!report.cashNotCounted) {
    client.println(`Starting Cash: ${formatCurrency(report.startingCash)}`)
  }
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

  if (report.cashNotCounted) {
    client.bold(true)
    client.println('Cash not counted')
    client.bold(false)
  } else {
    client.println(`Expected Cash: ${formatCurrency(report.expectedCash)}`)
    client.println(
      `Counted Cash: ${report.endingCash !== null ? formatCurrency(report.endingCash) : 'Pending'}`
    )
    client.bold(true)
    client.println(
      `Discrepancy: ${report.discrepancy !== null ? formatCurrency(report.discrepancy) : 'Pending'}`
    )
    client.bold(false)
  }

  // docs/phase-222: the M-Pesa balances, below the cash figures; "Not recorded" where none was entered.
  client.drawLine()
  for (const line of zReportMpesaLines(report, formatCurrency)) {
    client.println(`${line.label}: ${line.value}`)
  }
  // docs/phase-246, R5: the card settlement counted at close, "Not recorded" where none was entered.
  for (const line of zReportCardLines(report, formatCurrency)) {
    client.println(`${line.label}: ${line.value}`)
  }

  // docs/phase-224: every correction of the typed-in figures, under the originals, which are left as they were.
  const atClose = zReportSalesAtCloseLine(report, formatCurrency)
  if (atClose) {
    client.drawLine()
    client.println(atClose)
  }
  for (const block of zReportChangeBlocks(report, formatCurrency, (iso) => new Date(iso).toLocaleString())) {
    client.drawLine()
    client.bold(true)
    client.println(block.heading)
    client.bold(false)
    for (const line of block.details) client.println(line)
  }

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
    alignRight: () => {},
    bold: () => {},
    setTextNormal: () => {},
    setTextQuadArea: () => {},
    println: (text) => lines.push(text),
    drawLine: () => lines.push('--------------------------------'),
    printQR: (text) => lines.push(`[QR: ${text}]`),
    cut: () => {},
    execute: async () => undefined
  }
  return { client, lines }
}

/**
 * Builds a real `node-thermal-printer` client with no transport
 * interface at all — every ESC/POS formatting call (`println`, `bold`,
 * `cut`, …) still works, appending to its internal buffer, but nothing
 * is ever sent anywhere. `getBuffer()` then hands back those raw bytes
 * for {@link sendToWindowsPrinter} to send RAW to a Windows queue
 * instead of over TCP/IP (docs/phase-174) — the exact same renderer
 * (`renderReceipt`/`renderZReport`/the test-slip renderers) the network
 * route uses, so the two routes can never drift in what they print.
 *
 * @returns a {@link ThermalPrinterLike} that also exposes `getBuffer()`
 */
function createBufferClient(): ThermalPrinterLike & { getBuffer(): Buffer } {
  // `interface` is typed as required by node-thermal-printer's own .d.ts,
  // but core.js only wires one up when the value is truthy (`if
  // (initConfig.interface)`) — an empty string satisfies the type and
  // is falsy, so no transport is ever attached.
  return new ThermalPrinter({ type: PrinterTypes.EPSON, interface: '' }) as unknown as ThermalPrinterLike & {
    getBuffer(): Buffer
  }
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
 * Translates a printer/transport failure into a POS-safe message that names the printer (docs/phase-228).
 *
 * @param {unknown} err
 * @param {string} printer — {@link describePrinter}'s words for the printer that was tried
 * @returns {string}
 */
function translatePrinterError(err: unknown, printer: string): string {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: string }).code
    if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH') {
      return `${printer} is unreachable. Check the network connection and that it is switched on.`
    }
    if (code === 'ETIMEDOUT') {
      return `${printer} connection timed out.`
    }
  }
  const message = err instanceof Error ? err.message : String(err)
  if (/paper/i.test(message)) {
    return `${printer} reports a problem. Check the paper and try again.`
  }
  if (/timeout/i.test(message)) {
    return `${printer} connection timed out.`
  }
  return `${printer} error: ${message}`
}

/**
 * Renders onto a buffer-only client ({@link createBufferClient}) and
 * sends the resulting ESC/POS bytes RAW to `printerName` via
 * `windowsSender` (docs/phase-174) — the Windows-queue counterpart of
 * the network route's connect/execute in {@link sendToPrinter}.
 *
 * Any failure (missing queue, script error, the 15-second timeout) is
 * treated the same as an offline network printer: `onOfflineFallback`,
 * when given, wins over a bare failure result — never blocks the sale.
 *
 * @param {(client: ThermalPrinterLike) => void | Promise<void>} render
 * @param {string} printerName — the queue's system name (`PrinterConfig.interfaceName`)
 * @param {WindowsPrintSender} windowsSender
 * @param {() => Promise<ServiceResult<ReceiptPrintResult>>} [onOfflineFallback]
 * @returns {Promise<ServiceResult<ReceiptPrintResult>>}
 */
async function sendToWindowsPrinter(
  render: (client: ThermalPrinterLike) => void | Promise<void>,
  printerName: string,
  windowsSender: WindowsPrintSender,
  onOfflineFallback?: () => Promise<ServiceResult<ReceiptPrintResult>>
): Promise<ServiceResult<ReceiptPrintResult>> {
  try {
    const client = createBufferClient()
    await render(client)
    await windowsSender(printerName, client.getBuffer())
    return { success: true, data: { printed: true, mock: false } }
  } catch (err) {
    if (onOfflineFallback) return onOfflineFallback()
    return {
      success: false,
      error: translatePrinterError(err, describePrinter({ interfaceName: printerName, connectionType: 'windows' }))
    }
  }
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
 * `settings.connectionType === 'windows'` routes to
 * {@link sendToWindowsPrinter} instead — but only when not mocked:
 * `settings.mock` stands in for whichever route is otherwise
 * configured, exactly as it always has for the network route (see
 * `printReceipt`'s own doc comment).
 *
 * @param {(client: ThermalPrinterLike) => void | Promise<void>} render
 * @param {PrinterSettings} settings
 * @param {PrinterFactory} factory
 * @param {string} mockLogLabel — identifies the document in the mock-mode console log
 * @param {() => Promise<ServiceResult<ReceiptPrintResult>>} [onOfflineFallback]
 * @param {WindowsPrintSender} [windowsSender] — injected Windows-queue sender for testing
 * @returns {Promise<ServiceResult<ReceiptPrintResult>>}
 */
async function sendToPrinter(
  render: (client: ThermalPrinterLike) => void | Promise<void>,
  settings: PrinterSettings,
  factory: PrinterFactory,
  mockLogLabel: string,
  onOfflineFallback?: () => Promise<ServiceResult<ReceiptPrintResult>>,
  windowsSender: WindowsPrintSender = sendRawToWindowsPrinter
): Promise<ServiceResult<ReceiptPrintResult>> {
  const usingMock = settings.mock === true

  if (!usingMock && settings.connectionType === 'windows') {
    return sendToWindowsPrinter(render, settings.interfaceName, windowsSender, onOfflineFallback)
  }

  const sink = usingMock ? createMockSink() : null
  const client = sink ? sink.client : factory(settings.interfaceName)

  try {
    if (!usingMock) {
      const connected = await client.isPrinterConnected()
      if (!connected) {
        if (onOfflineFallback) return onOfflineFallback()
        return {
          success: false,
          error: `${describePrinter(settings)} is offline or unreachable. Check it is switched on and connected.`
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
    return { success: false, error: translatePrinterError(err, describePrinter(settings)) }
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
    return { success: false, error: translatePrinterError(err, describePrinter(settings)) }
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
 * @param {WindowsPrintSender} [windowsSender] — injected Windows-queue sender for testing (docs/phase-174)
 * @returns {Promise<ServiceResult<ReceiptPrintResult>>}
 */
export async function printReceipt(
  order: ReceiptOrder,
  items: ReceiptLineItem[],
  settings: PrinterSettings,
  factory: PrinterFactory = defaultPrinterFactory,
  pdfGenerator: PdfReceiptGenerator = generatePdfReceipt,
  windowsSender: WindowsPrintSender = sendRawToWindowsPrinter
): Promise<ServiceResult<ReceiptPrintResult>> {
  return sendToPrinter(
    (client) => renderReceipt(client, order, items, settings),
    settings,
    factory,
    `Order #${order.localId}`,
    () => fallBackToPdf(order, items, settings, pdfGenerator),
    windowsSender
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
  factory: PrinterFactory = defaultPrinterFactory,
  windowsSender: WindowsPrintSender = sendRawToWindowsPrinter
): Promise<ServiceResult<ReceiptPrintResult>> {
  return sendToPrinter(
    (client) => renderZReport(client, report, settings),
    settings,
    factory,
    `Z-Report Shift #${report.shiftId}`,
    undefined,
    windowsSender
  )
}

/**
 * Formats and sends a Z-report to the printer receipts use (docs/phase-228): the same
 * {@link resolvePrinterSettings} lookup, the first enabled printer of the type in `registry`, otherwise the default
 * settings. So a till whose printer is a Windows queue, or at another address, prints its Z-report there. There is no
 * PDF fallback: a Z-report that quietly became a file could be mistaken for the paper one.
 *
 * @param {ZReport} report
 * @param {PrinterRegistry} registry
 * @param {PrinterSettings} defaultSettings
 * @param {PrinterType} [printerType] — defaults to `'receipt'`
 * @param {PrinterFactory} [factory] — injected client factory for testing
 * @param {WindowsPrintSender} [windowsSender] — injected Windows-queue sender for testing
 * @returns {Promise<ServiceResult<ReceiptPrintResult>>}
 */
export async function printZReportToType(
  report: ZReport,
  registry: PrinterRegistry,
  defaultSettings: PrinterSettings,
  printerType: PrinterType = 'receipt',
  factory: PrinterFactory = defaultPrinterFactory,
  windowsSender: WindowsPrintSender = sendRawToWindowsPrinter
): Promise<ServiceResult<ReceiptPrintResult>> {
  const settings = resolvePrinterSettings(registry, printerType, defaultSettings)
  return printZReport(report, settings, factory, windowsSender)
}

/**
 * The status dot's check of the printer receipts use (docs/phase-228), through the same
 * {@link resolvePrinterSettings} lookup the prints use. A mock printer reads as connected, a network printer is
 * probed at its own address, and a Windows queue reads as "status unknown": nothing here can tell whether it is
 * switched on, and it must never show as connected on a guess.
 *
 * @param {PrinterRegistry} registry
 * @param {PrinterSettings} defaultSettings
 * @param {(interfaceName: string) => Promise<ConnectivityCheckResult>} tcpCheck — the TCP reachability probe, injected
 * @returns {Promise<ConnectivityCheckResult>}
 */
export function checkReceiptPrinter(
  registry: PrinterRegistry,
  defaultSettings: PrinterSettings,
  tcpCheck: (interfaceName: string) => Promise<ConnectivityCheckResult>
): Promise<ConnectivityCheckResult> {
  if (defaultSettings.mock === true) {
    return Promise.resolve({ connected: true, lastCheckedAt: new Date().toISOString(), latencyMs: 0 })
  }
  const settings = resolvePrinterSettings(registry, 'receipt', defaultSettings)
  if (settings.connectionType === 'windows') {
    return Promise.resolve({
      connected: false,
      notApplicable: true,
      lastCheckedAt: new Date().toISOString(),
      error: `${describePrinter(settings)}: its status cannot be read from here. Print a test page to check it.`
    })
  }
  return tcpCheck(settings.interfaceName)
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
 * @param {WindowsPrintSender} [windowsSender] — injected Windows-queue sender for testing (docs/phase-174)
 * @returns {Promise<ServiceResult<ReceiptPrintResult>>}
 */
export async function printReceiptToType(
  order: ReceiptOrder,
  items: ReceiptLineItem[],
  registry: PrinterRegistry,
  defaultSettings: PrinterSettings,
  printerType: PrinterType = 'receipt',
  factory: PrinterFactory = defaultPrinterFactory,
  pdfGenerator: PdfReceiptGenerator = generatePdfReceipt,
  windowsSender: WindowsPrintSender = sendRawToWindowsPrinter
): Promise<ServiceResult<ReceiptPrintResult>> {
  const settings = resolvePrinterSettings(registry, printerType, defaultSettings)
  return printReceipt(order, items, settings, factory, pdfGenerator, windowsSender)
}

/**
 * Renders the Enjoy customer slip (docs/phase-198) onto a printer client, as
 * its own job ending in its own cut.
 *
 * @param {ThermalPrinterLike} client
 * @param {ReceiptOrder} order
 * @param {ReceiptLineItem[]} items
 * @param {PrinterSettings} settings
 * @param {EnjoySlipKraNote} kraNote
 */
export function renderEnjoySlip(
  client: ThermalPrinterLike,
  order: ReceiptOrder,
  items: ReceiptLineItem[],
  settings: PrinterSettings,
  kraNote: EnjoySlipKraNote
): void {
  const layoutOrder: ReceiptLayoutOrder = {
    ...order,
    isDuplicate: order.customerSlipIsDuplicate ?? order.isDuplicate,
    items: items.map((item) => ({
      title: item.title,
      variantTitle: item.variantTitle,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      discount: item.discount,
      vatClass: item.vatClass,
      ...(item.autoDiscount ? { autoDiscount: item.autoDiscount } : {})
    }))
  }
  const entries = buildEnjoySlip(
    layoutOrder,
    { locationName: settings.locationName, address: settings.address },
    { width: settings.width ?? 48, kraNote }
  )
  renderEntries(client, entries)
}

/** Which slips of a sale one {@link printOrderSlips} call prints. */
export interface OrderSlipSelection {
  fiscal: boolean
  customer: boolean
}

/** What {@link printOrderSlips} did with each slip; `null` for one not asked for. */
export interface OrderSlipsResult {
  fiscal: ServiceResult<ReceiptPrintResult> | null
  customer: ServiceResult<ReceiptPrintResult> | null
}

/**
 * Decides the KRA line the customer slip carries from what actually
 * happened at the printer, never from what was intended (docs/phase-198): it
 * says the tax invoice is "printed separately" only when the fiscal slip
 * physically printed, and "will follow" only for a sale not yet filed.
 *
 * @param {ReceiptOrder} order
 * @param {ServiceResult<ReceiptPrintResult> | null} fiscal the fiscal slip's result in this call, or `null` when it was not printed
 * @returns {EnjoySlipKraNote}
 */
export function kraNoteFor(order: ReceiptOrder, fiscal: ServiceResult<ReceiptPrintResult> | null): EnjoySlipKraNote {
  if (order.fiscalInvoiceNumber) {
    return fiscal?.success && fiscal.data?.mode !== 'pdf' ? 'printed' : 'none'
  }
  return order.fiscalPending ? 'pending' : 'none'
}

/**
 * Prints a sale's slips as separate jobs, in order: the fiscal-side slip
 * (cut), then the Enjoy customer slip (cut) (docs/phase-198). Each succeeds
 * or fails on its own: a failed fiscal slip never stops the customer slip,
 * and neither is retried here. The customer slip has no PDF fallback; when
 * the printer is out it simply fails and the caller says so.
 *
 * @param {ReceiptOrder} order
 * @param {ReceiptLineItem[]} items
 * @param {PrinterRegistry} registry
 * @param {PrinterSettings} defaultSettings
 * @param {OrderSlipSelection} slips
 * @param {PrinterType} [printerType]
 * @param {PrinterFactory} [factory]
 * @param {PdfReceiptGenerator} [pdfGenerator]
 * @param {WindowsPrintSender} [windowsSender]
 * @returns {Promise<OrderSlipsResult>}
 */
export async function printOrderSlips(
  order: ReceiptOrder,
  items: ReceiptLineItem[],
  registry: PrinterRegistry,
  defaultSettings: PrinterSettings,
  slips: OrderSlipSelection,
  printerType: PrinterType = 'receipt',
  factory: PrinterFactory = defaultPrinterFactory,
  pdfGenerator: PdfReceiptGenerator = generatePdfReceipt,
  windowsSender: WindowsPrintSender = sendRawToWindowsPrinter
): Promise<OrderSlipsResult> {
  const settings = resolvePrinterSettings(registry, printerType, defaultSettings)
  const fiscal = slips.fiscal
    ? await printReceipt(order, items, settings, factory, pdfGenerator, windowsSender)
    : null
  const customer = slips.customer
    ? await sendToPrinter(
        (client) => renderEnjoySlip(client, order, items, settings, kraNoteFor(order, fiscal)),
        settings,
        factory,
        `Enjoy slip, order #${order.localId}`,
        undefined,
        windowsSender
      )
    : null
  return { fiscal, customer }
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
    { interfaceName, storeName: 'RUBIS POS', taxRate: 0, printerLabel: 'Test page' },
    factory,
    `Test Page (${interfaceName})`
  )
}

/**
 * Sends a short test slip — shop name, date, "Test print", cut — RAW to
 * a Windows printer queue (docs/phase-174). The Windows-route
 * counterpart of {@link printTestPage}, kept as its own function rather
 * than folded into it: `printTestPage`'s own content is fixed
 * ("RUBIS POS"/"TEST PAGE", not the configured store name) and this
 * route's hard rule is to leave that network test path untouched, so
 * this one is free to show the real store name instead.
 *
 * @param {string} printerName — the queue's system name (`PrinterConfig.interfaceName`)
 * @param {string} storeName
 * @param {WindowsPrintSender} [windowsSender] — injected Windows-queue sender for testing
 * @returns {Promise<ServiceResult<ReceiptPrintResult>>}
 */
export async function printWindowsTestPage(
  printerName: string,
  storeName: string,
  windowsSender: WindowsPrintSender = sendRawToWindowsPrinter
): Promise<ServiceResult<ReceiptPrintResult>> {
  return sendToWindowsPrinter(
    (client) => {
      client.alignCenter()
      client.bold(true)
      client.println(storeName)
      client.bold(false)
      client.println(new Date().toLocaleString())
      client.println('Test print')
      client.cut()
    },
    printerName,
    windowsSender
  )
}

/**
 * Folds the customer slip's outcome into the fiscal slip's result, the shape the
 * renderer already understands (docs/phase-198). A failed fiscal slip is
 * returned as it is: its own message already tells the cashier to reprint.
 *
 * @param {ServiceResult<ReceiptPrintResult>} fiscal
 * @param {ServiceResult<ReceiptPrintResult> | null} customer `null` when no customer slip was asked for
 * @returns {ServiceResult<ReceiptPrintResult>}
 */
export function attachCustomerSlipResult(
  fiscal: ServiceResult<ReceiptPrintResult>,
  customer: ServiceResult<ReceiptPrintResult> | null
): ServiceResult<ReceiptPrintResult> {
  if (!fiscal.success || !customer) return fiscal
  return {
    ...fiscal,
    data: {
      printed: fiscal.data?.printed ?? false,
      mock: fiscal.data?.mock ?? false,
      ...fiscal.data,
      customerSlip: customer.success ? 'printed' : 'failed',
      customerSlipError: customer.success ? undefined : customer.error
    }
  }
}

/**
 * The slips that physically reached paper in one {@link printOrderSlips} call
 * (docs/phase-198): a PDF fallback is not paper, and a failure is not a print.
 * What an Order History reprint logs.
 *
 * @param {OrderSlipsResult} result
 * @returns {Array<'fiscal' | 'enjoy'>}
 */
export function physicallyPrintedSlips(result: OrderSlipsResult): Array<'fiscal' | 'enjoy'> {
  const slips: Array<'fiscal' | 'enjoy'> = []
  if (result.fiscal?.success && result.fiscal.data?.mode !== 'pdf') slips.push('fiscal')
  if (result.customer?.success) slips.push('enjoy')
  return slips
}
