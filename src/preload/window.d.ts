/**
 * Global `Window.api` contract exposed by `src/preload/index.ts`.
 *
 * Kept in its own declaration file (no sibling `.ts`) so that BOTH
 * TypeScript projects (tsconfig.node.json and tsconfig.web.json)
 * receive the augmentation.  TypeScript will not pick a `*.d.ts`
 * into a program when a same-named `*.ts` sits beside it (it is
 * treated as that file's declaration output), which is why this
 * augmentation lives here instead of in `index.d.ts`.
 */

import type { VatMismatchRow } from '../main/services/vat-reconcile.js'
import type { ShiftType } from '../main/lib/shiftWindows.js'
import type { ShiftWindowStatus } from '../main/services/shift-window-status.js'
import type { WindowReport } from '../main/services/window-report.js'
import type { ShiftCorrectionRequest } from '../main/services/shift-corrections.js'
import type { MoveSaleRequest } from '../main/services/sale-moves.js'
import type { ServiceResult } from '../main/services/shopify-types.js'
import type { FiscalConnectionTestResult } from '../main/services/integrations/fiscal-connection-test.js'
import type {
  CartItem,
  CartRemovalRequest,
  DiscardHeldSaleRequest,
  HoldSaleRequest,
  ProductSummary
} from '../renderer/src/types/shopify.js'
import type {
  CheckoutIpcRequest,
  CheckoutReceipt,
  DiscardedHeldSale,
  HeldSaleSummary,
  MpesaPaymentRow,
  FiscalResendResult,
  OrderRow,
  StaffSummary,
  StaffRole,
  AutoAssignResult,
  OpenShiftOptions,
  SaleMovePreview,
  ShiftCorrectionRow,
  ShiftCloseResult,
  ShiftRow,
  IntegrationProviderName,
  PrinterConfig,
  PrinterType,
  MpesaTransactionRow,
  AppConfigCategory,
  NeedsAttentionRow,
  UnprintedFiscalSlipRow,
  ApproveMpesaEntriesResult
} from '../main/services/database.js'
import type {
  StockTakeCommitSummary,
  StockTakePreview,
  StockTakeSessionView,
  StockTakeSettings
} from '../main/services/stock-take.js'
import type { ReceiptPrintResult } from '../main/services/printer.js'
import type { WindowsPrinterInfo, PrinterWithAvailability } from '../main/services/windowsPrinter.js'
import type {
  ZReport,
  DailySummary,
  EndOfDayReport,
  SalesSummary,
  FiscalStatusDayCount,
  FiscalReconciliationReport,
  ReportRangePreset
} from '../main/services/reports.js'
import type { UpdateStatus } from '../main/services/updater.js'
import type { LastUpdateResult } from '../main/services/updateBackup.js'
import type {
  StkPushRequest,
  StkPushResult,
  ManualCodeVerification,
  ManualCodeVerificationResult,
  StkPushStatusResult
} from '../main/services/integrations/mpesa.js'
import type { UnmatchedMpesaPayment } from '../main/services/integrations/sms-mpesa-provider.js'
import type { MpesaConfirmationMethod } from '../main/services/mpesa-provider-factory.js'
import type { ReconciliationResult } from '../main/services/reconciliation.js'

/** Payload of the `network:status` broadcast / `network:get-status` invoke. */
export interface NetworkStatusPayload {
  online: boolean
}

/** Result of one reachability probe, mirroring `ConnectivityCheckResult` in the main process. */
export interface ConnectivityCheckPayload {
  connected: boolean
  lastCheckedAt: string
  latencyMs?: number
  error?: string
  /** True when there is nothing external to probe (e.g. M-Pesa in manual/SMS mode) — a neutral state, not a failure. */
  notApplicable?: boolean
}

/** Payload of the `connectivity:status` broadcast / `connectivity:get-status` invoke. */
export interface ConnectivityStatusPayload {
  mpesa: ConnectivityCheckPayload
  fiscal: ConnectivityCheckPayload
  printer: ConnectivityCheckPayload
}

/**
 * Renderer-facing API surface — mirror of the `api` object
 * built in `src/preload/index.ts`.
 */
export interface PosApi {
  /** The OS this till is running on (docs/phase-174) — used to hide the Windows-printer connection option elsewhere. */
  platform: NodeJS.Platform
  /** Lightweight health-check channel, resolves to 'pong'. */
  ping: () => Promise<string>
  /** Application version from the main process. */
  getAppVersion: () => Promise<string>
  /** Test-hook-only (docs/phase-166 Commit E3): which screen/overlay check:fit wants force-shown, or null on every real launch. */
  getCheckFitForcedScreen: () => Promise<string | null>
  /** Opens an external URL in the OS default browser. */
  openExternal: (url: string) => void
  /** Fetches the active Shopify product catalog. */
  fetchProducts: () => Promise<ServiceResult<ProductSummary[]>>
  /** Reads the last cached catalog from SQLite (offline fallback). */
  getCachedProducts: () => Promise<ServiceResult<ProductSummary[]>>
  /** Persists the cart as an order; immediate sync when online. */
  checkout: (
    request: CheckoutIpcRequest
  ) => Promise<ServiceResult<CheckoutReceipt>>
  /** Reads the current main-process connectivity state. */
  getNetworkStatus: () => Promise<NetworkStatusPayload>
  /** Subscribes to connectivity transitions; returns an unsubscribe fn. */
  onNetworkStatus: (callback: (status: NetworkStatusPayload) => void) => () => void
  /** Reads the last-known M-Pesa/fiscal-device/printer reachability. */
  getConnectivityStatus: () => Promise<ConnectivityStatusPayload>
  /** Triggers an immediate reachability check across every monitored integration. */
  testAllConnectivity: () => Promise<ConnectivityStatusPayload>
  /** Subscribes to connectivity check results; returns an unsubscribe fn. */
  onConnectivityStatus: (callback: (status: ConnectivityStatusPayload) => void) => () => void
  /** Fetches local orders for the order history view. */
  getLocalOrders: (limit?: number, offset?: number) => Promise<ServiceResult<OrderRow[]>>
  /** Retries syncing a failed or pending order. */
  retryOrderSync: (localId: number) => Promise<ServiceResult<{ queueId: number }>>
  /** Corrects (or, passing `null`, removes) the buyer PIN on a wrong-PIN sale, then resends its fiscalization. */
  correctPinAndResend: (
    localId: number,
    buyerPin: string | null
  ) => Promise<ServiceResult<FiscalResendResult>>
  /** Resends a sale's fiscalization as-is (no PIN change) — the back-office list's plain "Resend" action. */
  resendFiscalization: (localId: number) => Promise<ServiceResult<FiscalResendResult>>
  /** Registers the renderer's answer to "save the cart draft now, the app is quitting". Returns an unsubscribe function. */
  onCartFlushRequest: (handler: () => Promise<void> | void) => () => void
  /** Saves the cart being built so it survives a restart. Lines only, never payment state. */
  saveCartDraft: (draft: { cartToken: string; items: CartItem[] }) => Promise<ServiceResult<void>>
  /** The saved cart, or `null` when there is none. */
  loadCartDraft: () => Promise<ServiceResult<{ payloadJson: string } | null>>
  /** Deletes the saved cart. */
  clearCartDraft: () => Promise<ServiceResult<void>>
  /** Records manager-approved cart removals; the main process re-verifies the manager PIN. */
  recordCartRemovals: (request: CartRemovalRequest) => Promise<ServiceResult<void>>
  /** Every sale on hold or resumed on this till. */
  listHeldSales: () => Promise<ServiceResult<HeldSaleSummary[]>>
  /** Parks the cart. Not a sale: nothing is filed, queued or counted. */
  holdSale: (request: HoldSaleRequest) => Promise<ServiceResult<HeldSaleSummary>>
  /** Takes a held sale back; its lines come back exactly as held. */
  resumeHeldSale: (id: number) => Promise<ServiceResult<{ summary: HeldSaleSummary; payloadJson: string }>>
  /** Renames a held sale. */
  renameHeldSale: (id: number, label: string) => Promise<ServiceResult<HeldSaleSummary>>
  /** Discards a held sale; the main process re-verifies the manager PIN. */
  discardHeldSale: (request: DiscardHeldSaleRequest) => Promise<ServiceResult<HeldSaleSummary>>
  /** Held sales discarded on one Africa/Nairobi day (today when omitted), for End of Day. */
  getDiscardedHeldSales: (localDay?: string) => Promise<ServiceResult<DiscardedHeldSale[]>>
  /** Prints an order's receipt at the fiscal device. Requires a re-verified admin Manager PIN; succeeds only when the device's last receipt is this order's. */
  printFiscalDuplicate: (
    orderId: number,
    managerId: number,
    managerPin: string
  ) => Promise<ServiceResult<{ issuedNewReceipt: boolean }>>
  /** The back-office "needs attention" list — every needs_fixing sale plus every stuck-waiting sale. */
  getSalesNeedingAttention: () => Promise<ServiceResult<NeedsAttentionRow[]>>
  /** The Rule-3 safety-net count: every completed-but-unfiled sale, regardless of the stuck threshold. */
  getUnfiledSalesCount: () => Promise<ServiceResult<number>>
  /** Whether this till is running the real fiscal provider (docs/phase-161). */
  isFiscalLive: () => Promise<ServiceResult<boolean>>
  /**
   * Prints (or, in mock mode, logs) a receipt for a local order,
   * optionally routed to a printer type. `auto: true` marks the
   * automatic end-of-sale print (docs/phase-165) — never set by a manual
   * Order History print.
   */
  printReceipt: (
    localId: number,
    options?: { printerType?: PrinterType; auto?: boolean; staffId?: number; fiscalOnly?: boolean }
  ) => Promise<ServiceResult<ReceiptPrintResult>>
  /** Sales whose stored device VAT figures disagree with the till's own, for the Needs Attention list (docs/phase-198-1). */
  getVatMismatches: () => Promise<ServiceResult<VatMismatchRow[]>>
  /** Filed sales whose fiscal slip never reached paper, for the Needs Attention list (docs/phase-198). */
  getUnprintedFiscalSlips: () => Promise<ServiceResult<UnprintedFiscalSlipRow[]>>
  /** Fetches every active staff account for the login picker. */
  getStaffList: () => Promise<ServiceResult<StaffSummary[]>>
  /** Verifies a staff PIN. */
  login: (staffId: number, pin: string) => Promise<ServiceResult<StaffSummary>>
  /** Ends the renderer session (authentication only). */
  logout: (staffId: number) => Promise<ServiceResult<void>>
  /** Prints (or, in mock mode, logs) a shift's Z-report. */
  printZReport: (shiftId: number) => Promise<ServiceResult<ReceiptPrintResult>>
  /** Creates a new staff account. Requires a re-verified admin Manager PIN. */
  createStaff: (
    name: string,
    pin: string,
    role: StaffRole,
    managerId: number,
    managerPin: string
  ) => Promise<ServiceResult<StaffSummary>>
  /** Resets a staff member's PIN. Requires a re-verified admin Manager PIN. */
  resetStaffPin: (
    staffId: number,
    pin: string,
    managerId: number,
    managerPin: string
  ) => Promise<ServiceResult<void>>
  /** Writes one of a fixed list of events to `till.log`; the main process refuses anything else (docs/phase-228). */
  logTillEvent: (event: 'shift-state-unreadable', detail?: string) => Promise<ServiceResult<void>>
  /** Reads the currently open till shift, if any. */
  getCurrentShift: () => Promise<ServiceResult<ShiftRow | null>>
  /** Opens a new store-wide till shift with a starting cash float, day or night (docs/phase-199). */
  openShift: (
    staffId: number,
    startingCash: number,
    mpesaOpeningBalance?: number,
    options?: OpenShiftOptions
  ) => Promise<ServiceResult<{ shiftId: number }>>
  /** Opens a shift under a manager's PIN, from the cart when the person at the till is not an admin (docs/phase-227). */
  openShiftAsManager: (
    managerId: number,
    managerPin: string,
    startingCash: number,
    mpesaOpeningBalance?: number,
    options?: OpenShiftOptions
  ) => Promise<ServiceResult<{ shiftId: number }>>
  /** Closes the open till shift, reconciling counted cash and, if given, the M-Pesa balance (docs/phase-222). */
  closeShift: (
    shiftId: number,
    endingCash: number,
    mpesaClosingBalance?: number
  ) => Promise<ServiceResult<ShiftCloseResult>>
  /** The shift window of this moment, its shift, the earlier sales an Open Shift would bring in, and when the open shift may close (docs/phase-232). */
  getShiftWindowStatus: () => Promise<ServiceResult<ShiftWindowStatus>>
  /** The combined report of one window (docs/phase-232). Read-only. */
  getWindowReport: (type: ShiftType, startDate: string) => Promise<ServiceResult<WindowReport>>
  /** Gives every sale with no shift to the shift it belongs to (docs/phase-232). No input, no PIN; running it again changes nothing. */
  autoAssignSales: () => Promise<ServiceResult<AutoAssignResult>>
  /** What moving one sale to another shift would do (docs/phase-232). Read-only. */
  previewSaleMove: (orderId: number, toShiftId: number) => Promise<ServiceResult<SaleMovePreview>>
  /** Moves one sale to another shift (docs/phase-232). Admin PIN re-checked in the main process. */
  moveSale: (request: MoveSaleRequest) => Promise<ServiceResult<{ fromShiftId: number; toShiftId: number }>>
  /** Appends a correction to a closed shift's typed-in figures (docs/phase-224). Manager PIN re-checked in the main process; the shift's own row is never changed. */
  correctShift: (request: ShiftCorrectionRequest) => Promise<ServiceResult<ShiftCorrectionRow>>
  /** Generates the Z-report for a shift. */
  getZReport: (shiftId: number) => Promise<ServiceResult<ZReport>>
  /** Generates today's sales summary for the Admin screen. */
  getDailySummary: () => Promise<ServiceResult<DailySummary>>
  /** Generates the end-of-day report for one Africa/Nairobi calendar day (defaults to today). Read-only. */
  getEndOfDayReport: (localDay?: string) => Promise<ServiceResult<EndOfDayReport>>
  /** A manager's end-of-day review: approves `approvedIds` and records why each `excluded` entry was left pending. */
  approveDayReport: (request: {
    localDay: string
    approvedIds: number[]
    excluded: Array<{ paymentId: number; reason?: string }>
    managerId: number
    managerPin: string
    note?: string
  }) => Promise<ServiceResult<ApproveMpesaEntriesResult>>
  /** One page of shift history, most recently opened first (docs/phase-158). */
  getShiftsList: (
    page: number
  ) => Promise<ServiceResult<{ shifts: ShiftRow[]; total: number; page: number }>>
  /** A sales summary for one of the fixed Nairobi date-range presets. */
  getSalesSummary: (preset: ReportRangePreset) => Promise<ServiceResult<SalesSummary>>
  /** Order counts by fiscal status, one row per Nairobi calendar day within the preset. */
  getFiscalStatusByDay: (
    preset: ReportRangePreset
  ) => Promise<ServiceResult<FiscalStatusDayCount[]>>
  /** The fiscal reconciliation report for one of the fixed Nairobi date-range presets (docs/phase-163). */
  getFiscalReconciliation: (
    preset: ReportRangePreset
  ) => Promise<ServiceResult<FiscalReconciliationReport>>
  /** One page of orders (CU and trader invoice numbers included) for the invoice list. */
  getInvoiceList: (
    preset: ReportRangePreset,
    page: number
  ) => Promise<
    ServiceResult<{
      invoices: Array<{ order: OrderRow; traderInvoiceNumber: string }>
      total: number
      page: number
    }>
  >
  /** Exports orders or line items for a preset as CSV, via the OS save dialog. */
  exportReportsCsv: (
    preset: ReportRangePreset,
    kind: 'orders' | 'lines'
  ) => Promise<ServiceResult<{ saved: boolean; filePath?: string }>>
  /** Triggers an update check against the configured update feed. */
  checkForUpdates: () => Promise<ServiceResult<void>>
  /** Quits and relaunches the app to install a downloaded update. */
  installUpdate: () => Promise<ServiceResult<void>>
  /** The check made once per app start: the version on offer, or null (none, already checked, or the check failed). */
  startupUpdateCheck: () => Promise<ServiceResult<string | null>>
  /** Downloads the update the last check found; resolves when finished or failed. */
  downloadUpdate: () => Promise<ServiceResult<void>>
  /** Subscribes to auto-update status changes; returns an unsubscribe fn. */
  onUpdateStatus: (callback: (status: UpdateStatus) => void) => () => void
  /** The result of the most recently completed OTA update, or null. */
  getLastUpdateResult: () => Promise<ServiceResult<LastUpdateResult | null>>
  /** Initiates an M-Pesa STK Push prompt to the customer's phone. */
  initiateMpesaStkPush: (request: StkPushRequest) => Promise<ServiceResult<StkPushResult>>
  /**
   * Reports what this till's M-Pesa provider can confirm, so a screen
   * offers no dead-end route. `mode` is how this till confirms M-Pesa
   * payments (`'manual'` by default) — `PaymentModal` renders per mode.
   */
  getMpesaCapabilities: () => Promise<
    ServiceResult<{
      manualCodeSupported: boolean
      manualEntryEnabled: boolean
      mode: MpesaConfirmationMethod
    }>
  >
  /** Every M-Pesa payment that settled a sale, across all three modes. */
  listMpesaPayments: () => Promise<ServiceResult<MpesaPaymentRow[]>>
  /** Manually entered payments not yet checked against the M-Pesa statement. */
  listUnreconciledMpesaPayments: () => Promise<ServiceResult<MpesaPaymentRow[]>>
  /** Marks one manual payment as reconciled. Requires a re-verified admin Manager PIN. */
  reconcileMpesaPayment: (
    paymentId: number,
    managerId: number,
    managerPin: string,
    note?: string
  ) => Promise<ServiceResult<void>>
  /** Recent M-Pesa payments received by message that no sale has used yet, plus the reader's health. */
  listUnmatchedMpesaPayments: () => Promise<
    ServiceResult<{ payments: UnmatchedMpesaPayment[]; health: string | null }>
  >
  /** Verifies a manually entered M-Pesa transaction code. */
  verifyMpesaCode: (
    request: ManualCodeVerification
  ) => Promise<ServiceResult<ManualCodeVerificationResult>>
  /** Logs a newly initiated STK Push for the M-Pesa Logs screen. */
  logMpesaTransaction: (request: {
    orderLocalId?: number
    checkoutRequestId: string
    merchantRequestId: string
    phoneNumber: string
    amount: number
    status?: 'pending' | 'success' | 'failed'
  }) => Promise<ServiceResult<{ id: number }>>
  /** Fetches recent M-Pesa transactions for the M-Pesa Logs screen. */
  getMpesaTransactions: (limit?: number) => Promise<ServiceResult<MpesaTransactionRow[]>>
  /** Re-checks a pending STK Push's outcome and persists the result. */
  queryMpesaStatus: (checkoutRequestId: string) => Promise<ServiceResult<StkPushStatusResult>>
  /** Reports whether the M-Pesa consumer secret / passkey are stored in the credential vault. */
  getMpesaCredentialStatus: () => Promise<
    ServiceResult<{ consumerSecretConfigured: boolean; passkeyConfigured: boolean }>
  >
  /** Saves the M-Pesa consumer secret and/or passkey to the credential vault. Requires a re-verified admin Manager PIN. */
  setMpesaCredentials: (
    credentials: { consumerSecret?: string; passkey?: string },
    managerId: number,
    managerPin: string
  ) => Promise<ServiceResult<void>>
  /** Verifies the currently configured Daraja credentials via an OAuth2 token exchange only. */
  testMpesaConnection: () => Promise<ServiceResult<void>>
  /** Reads every `app_configurations` value, optionally scoped to one category. */
  getAllConfigs: (category?: AppConfigCategory) => Promise<ServiceResult<Record<string, string>>>
  /** Writes one `app_configurations` value. Requires a re-verified admin Manager PIN. */
  setConfig: (
    key: string,
    value: string,
    options: { requiresRestart?: boolean; category?: AppConfigCategory } | undefined,
    managerId: number,
    managerPin: string
  ) => Promise<ServiceResult<void>>
  /** Relaunches the app to apply a `requiresRestart` configuration change. */
  restartApp: () => Promise<ServiceResult<void>>
  /** Reads a provider's stored integration config. */
  getIntegrationConfig: (
    provider: IntegrationProviderName
  ) => Promise<ServiceResult<Record<string, unknown>>>
  /** Saves a provider's integration config. Requires a re-verified admin Manager PIN. */
  setIntegrationConfig: (
    provider: IntegrationProviderName,
    config: Record<string, unknown>,
    managerId: number,
    managerPin: string
  ) => Promise<ServiceResult<void>>
  /** Lists every configured printer — a `connectionType: 'windows'` entry carries `missing: true` when its queue is no longer installed (docs/phase-174). */
  getPrinters: () => Promise<ServiceResult<PrinterWithAvailability[]>>
  /** Upserts a printer configuration. Requires a re-verified admin Manager PIN. */
  savePrinter: (
    config: PrinterConfig,
    managerId: number,
    managerPin: string
  ) => Promise<ServiceResult<void>>
  /** Removes a printer configuration. Requires a re-verified admin Manager PIN. */
  deletePrinter: (id: string, managerId: number, managerPin: string) => Promise<ServiceResult<void>>
  /**
   * Sends a test page — either to a network printer interface (unchanged),
   * or (docs/phase-174, Windows only) RAW to a Windows printer queue by
   * its system name.
   */
  testPrinter: (
    target: { interfaceName: string } | { connectionType: 'windows'; windowsPrinterName: string }
  ) => Promise<ServiceResult<ReceiptPrintResult>>
  /** Lists Windows printer queues (USB or COM/serial) for the "Find printers" button (docs/phase-174, Windows only). */
  findWindowsPrinters: () => Promise<ServiceResult<WindowsPrinterInfo[]>>
  /** Reports whether a Shopify Admin API token is stored in the credential vault. */
  getShopifyTokenStatus: () => Promise<ServiceResult<{ configured: boolean }>>
  /** Saves the Shopify Admin API token to the credential vault. */
  setShopifyToken: (token: string) => Promise<ServiceResult<void>>
  /** Reads the currently resolved Shopify store URL (not a secret). */
  getShopifyStoreUrl: () => Promise<ServiceResult<{ storeUrl: string | null }>>
  /** Saves the Shopify store URL. Requires a re-verified admin Manager PIN. */
  setShopifyStoreUrl: (
    storeUrl: string,
    managerId: number,
    managerPin: string
  ) => Promise<ServiceResult<void>>
  /** Reports whether this till has a working Shopify connection yet and whether its location is admin-confirmed. */
  getConfigStatus: () => Promise<
    ServiceResult<{
      hasConfig: boolean
      locationConfirmed: boolean
      config?: { storeUrl: string; locationId: string | null; locationName: string | null }
    }>
  >
  /** Onboarding wizard's "Connect & Verify" step — verifies credentials and fetches locations. */
  validateShopifyConfig: (
    storeUrl: string,
    token: string
  ) => Promise<
    ServiceResult<{
      shopName: string
      locations: { id: string; name: string; address?: string }[]
    }>
  >
  /** Fetches every one of this till's available Shopify locations, paginated, using its already-resolved store URL/token. */
  listLocations: () => Promise<
    ServiceResult<{
      shopName: string
      locations: { id: string; name: string; address?: string }[]
    }>
  >
  /** Persists the admin-confirmed location for this till. Requires a re-verified admin Manager PIN. */
  setLocation: (
    locationId: string,
    locationName: string,
    managerId: number,
    managerPin: string
  ) => Promise<ServiceResult<void>>
  /** Persists the onboarding wizard's verified store URL, token, and selected location. */
  saveConfig: (
    storeUrl: string,
    token: string,
    locationId: string,
    locationName: string
  ) => Promise<ServiceResult<void>>
  /** Admin screen's "Reset Configuration" action. Requires a re-verified admin Manager PIN. */
  clearConfig: (managerId: number, managerPin: string) => Promise<ServiceResult<void>>
  /** Reports whether this till may proceed past the mandatory eTIMS setup gate. */
  checkEtimsCompletion: () => Promise<
    ServiceResult<{ isComplete: boolean; missingFields: string[] }>
  >
  /** Saves the four required Real-eTIMS connection fields from the setup gate. No manager PIN required. */
  saveEtimsConfig: (config: {
    baseUrl: string
    deviceIp: string
    devicePort: string
    password: string
  }) => Promise<ServiceResult<void>>
  /** Saves the fiscal device password to the credential vault. Requires a re-verified admin Manager PIN. */
  setEtimsPassword: (
    password: string,
    managerId: number,
    managerPin: string
  ) => Promise<ServiceResult<void>>
  /** Reports whether a fiscal device password is stored, never the value. */
  getEtimsSecretStatus: () => Promise<ServiceResult<{ passwordConfigured: boolean }>>
  /** Walks the three hops to the fiscal device and reports which one broke, in plain words. */
  testEtimsConnection: () => Promise<ServiceResult<FiscalConnectionTestResult>>
  /** Reads the seller identity fields printed on every receipt (docs/phase-171). */
  getStoreIdentity: () => Promise<
    ServiceResult<{
      storeName: string
      storeKraPin: string
      legalName: string
      address: string
      phone: string
      footerMessage: string
    }>
  >
  /** Saves the seller identity fields printed on every receipt (docs/phase-171). Requires a re-verified admin Manager PIN. */
  setStoreIdentity: (
    identity: {
      storeName: string
      storeKraPin: string
      legalName?: string
      address?: string
      phone?: string
      footerMessage?: string
    },
    managerId: number,
    managerPin: string
  ) => Promise<ServiceResult<void>>
  /** Opens a stock-take session against a fresh Shopify read. Online-only. */
  openStockTake: (staffId: number) => Promise<ServiceResult<StockTakeSessionView>>
  /** Returns the stock take this till is currently working on, or null. */
  getActiveStockTake: () => Promise<ServiceResult<StockTakeSessionView | null>>
  /** Records one counted variant. Works offline. */
  recordStockTakeCount: (count: {
    sessionId: number
    variantId: string
    variantLabel: string
    countedQty: number
  }) => Promise<ServiceResult<StockTakeSessionView>>
  /** Drops one mis-scanned row from a session still being counted. */
  removeStockTakeCount: (
    sessionId: number,
    variantId: string
  ) => Promise<ServiceResult<StockTakeSessionView>>
  /** Submits a counted session for manager approval. */
  submitStockTake: (sessionId: number) => Promise<ServiceResult<StockTakeSessionView>>
  /** Discards an uncommitted session. Requires a re-verified admin Manager PIN. */
  abandonStockTake: (
    sessionId: number,
    managerId: number,
    managerPin: string
  ) => Promise<ServiceResult<void>>
  /** Re-reads Shopify and returns what pushing this session would do. Online-only. */
  previewStockTake: (sessionId: number) => Promise<ServiceResult<StockTakePreview>>
  /** Pushes an approved stock take to Shopify. Requires a re-verified admin Manager PIN. */
  commitStockTake: (request: {
    sessionId: number
    managerId: number
    managerPin: string
    secondApproverId?: number
    secondApproverPin?: string
  }) => Promise<ServiceResult<StockTakeCommitSummary>>
  /** Returns recent stock takes for the back-office history list. */
  listStockTakes: () => Promise<ServiceResult<StockTakeSessionView[]>>
  /** Reads the stock-take approval policy. */
  getStockTakeSettings: () => Promise<ServiceResult<StockTakeSettings>>
  /** Saves the stock-take approval policy. Requires a re-verified admin Manager PIN. */
  saveStockTakeSettings: (
    settings: StockTakeSettings,
    managerId: number,
    managerPin: string
  ) => Promise<ServiceResult<void>>
  /** The Shopify sales-safety check's latest result (docs/phase-170), or `null` before the first check has run. */
  getShopifyReconciliationStatus: () => Promise<ServiceResult<ReconciliationResult | null>>
  /** Subscribes to a freshly completed Shopify check; returns an unsubscribe fn. */
  onShopifyReconciliationStatus: (callback: (result: ReconciliationResult) => void) => () => void
}

declare global {
  interface Window {
    /**
     * Custom API registered by the preload script via
     * `contextBridge.exposeInMainWorld('api', api)`.
     */
    api: PosApi
  }
}
