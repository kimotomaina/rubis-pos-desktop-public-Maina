import { contextBridge, ipcRenderer } from 'electron'
import type { VatMismatchRow } from '../main/services/vat-reconcile.js'
import type { ShiftType } from '../main/lib/shiftWindows.js'
import { electronAPI } from '@electron-toolkit/preload'
import type { ShiftWindowStatus } from '../main/services/shift-window-status.js'
import type { WindowReport } from '../main/services/window-report.js'
import type { ShiftCorrectionRequest } from '../main/services/shift-corrections.js'
import type { MoveSaleRequest } from '../main/services/sale-moves.js'
import type { MergeShiftsRequest } from '../main/services/shift-merges.js'
import type { ServiceResult } from '../main/services/shopify-types.js'
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
  ShiftMergePreview,
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
import type { FiscalConnectionTestResult } from '../main/services/integrations/fiscal-connection-test.js'
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

/** Status payload broadcast over the `network:status` channel. */
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

/** Status payload broadcast over the `connectivity:status` channel. */
export interface ConnectivityStatusPayload {
  mpesa: ConnectivityCheckPayload
  fiscal: ConnectivityCheckPayload
  printer: ConnectivityCheckPayload
}

/**
 * Custom renderer-facing API surface.
 *
 * Every method that touches the main process must go through
 * `ipcRenderer` so the renderer can never import arbitrary Node modules
 * directly (contextIsolation + sandbox).
 */
const api = {
  /**
   * The OS this till is running on (docs/phase-174) — a plain value,
   * not an IPC call, since it never changes for a running process. Lets
   * the Admin screen hide the Windows-printer connection option on
   * every other platform.
   */
  platform: process.platform,

  /**
   * Lightweight health-check channel.
   * @returns {Promise<string>} resolves to 'pong'
   */
  ping: (): Promise<string> => ipcRenderer.invoke('ping'),

  /**
   * Returns the application version from the main process.
   * @returns {Promise<string>} the semver version string
   */
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:get-version'),

  /**
   * Test-hook-only (docs/phase-166 Commit E3): which screen/overlay
   * `check:fit` wants force-shown, or `null` on every real launch. See
   * `main/index.ts`'s `checkFit:getForcedScreen` handler.
   * @returns {Promise<string | null>}
   */
  getCheckFitForcedScreen: (): Promise<string | null> => ipcRenderer.invoke('checkFit:getForcedScreen'),

  /**
   * Opens the given external URL in the OS default browser.
   * @param {string} url
   */
    openExternal: (url: string): void => ipcRenderer.send('app:open-external', url),

  /**
   * Fetches the active product catalog from Shopify via the main-process
   * IPC handler. Credentials are resolved server-side from the environment.
   *
   * @returns {Promise<ServiceResult<ProductSummary[]>>}
   */
  fetchProducts: (): Promise<
    ServiceResult<ProductSummary[]>
  > => ipcRenderer.invoke('products:fetch'),

  /**
   * Returns the last successfully cached catalog from SQLite
   * (offline fallback when the live fetch fails).
   *
   * @returns {Promise<ServiceResult<ProductSummary[]>>}
   */
  getCachedProducts: (): Promise<
    ServiceResult<ProductSummary[]>
  > => ipcRenderer.invoke('products:cached'),

  /**
   * Persists the current cart as an order and attempts immediate sync
   * when connectivity allows.
   *
   * @param {CheckoutIpcRequest} request
   * @returns {Promise<ServiceResult<CheckoutReceipt>>}
   */
  checkout: (
    request: CheckoutIpcRequest
  ): Promise<ServiceResult<CheckoutReceipt>> =>
    ipcRenderer.invoke('orders:checkout', request),

  /**
   * Reads the current main-process connectivity state.
   *
   * @returns {Promise<NetworkStatusPayload>}
   */
  getNetworkStatus: (): Promise<NetworkStatusPayload> =>
    ipcRenderer.invoke('network:get-status'),

  /**
   * Subscribes to connectivity transitions broadcast by the main
   * process.  Returns a cleanup function that removes the listener.
   *
   * @param {(status: NetworkStatusPayload) => void} callback
   * @returns {() => void} unsubscribe
   */
  onNetworkStatus: (
    callback: (status: NetworkStatusPayload) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      status: NetworkStatusPayload
    ): void => callback(status)
    ipcRenderer.on('network:status', listener)
    return () => ipcRenderer.removeListener('network:status', listener)
  },

  /**
   * Reads the last-known M-Pesa/fiscal-device/printer reachability.
   *
   * @returns {Promise<ConnectivityStatusPayload>}
   */
  getConnectivityStatus: (): Promise<ConnectivityStatusPayload> =>
    ipcRenderer.invoke('connectivity:get-status'),

  /**
   * Triggers an immediate reachability check across every monitored
   * integration.
   *
   * @returns {Promise<ConnectivityStatusPayload>}
   */
  testAllConnectivity: (): Promise<ConnectivityStatusPayload> =>
    ipcRenderer.invoke('connectivity:test-all'),

  /**
   * Subscribes to connectivity check results broadcast by the main
   * process. Returns a cleanup function that removes the listener.
   *
   * @param {(status: ConnectivityStatusPayload) => void} callback
   * @returns {() => void} unsubscribe
   */
  onConnectivityStatus: (
    callback: (status: ConnectivityStatusPayload) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      status: ConnectivityStatusPayload
    ): void => callback(status)
    ipcRenderer.on('connectivity:status', listener)
    return () => ipcRenderer.removeListener('connectivity:status', listener)
  },

  /**
   * Fetches local orders for the order history view.
   *
   * @param {number} [limit=50]
   * @param {number} [offset=0]
   * @returns {Promise<ServiceResult<OrderRow[]>>}
   */
  getLocalOrders: (
    limit?: number,
    offset?: number
  ): Promise<ServiceResult<OrderRow[]>> =>
    ipcRenderer.invoke('orders:getLocal', { limit, offset }),

  /**
   * Retries syncing a failed or pending order.
   *
   * @param {number} localId
   * @returns {Promise<ServiceResult<{ queueId: number }>>}
   */
  retryOrderSync: (
    localId: number
  ): Promise<ServiceResult<{ queueId: number }>> =>
    ipcRenderer.invoke('orders:retrySync', localId),

  /**
   * Corrects (or, passing `null`, removes) the buyer PIN on a sale
   * flagged `needs_fixing` for a wrong PIN, then resends its
   * fiscalization through the same guarded retry/resend path.
   *
   * @param {number} localId
   * @param {string | null} buyerPin
   * @returns {Promise<ServiceResult<FiscalResendResult>>}
   */
  correctPinAndResend: (
    localId: number,
    buyerPin: string | null
  ): Promise<ServiceResult<FiscalResendResult>> =>
    ipcRenderer.invoke('fiscal:correct-pin-and-resend', { localId, buyerPin }),

  /**
   * Resends a sale's fiscalization as-is (no PIN change) — the
   * back-office list's plain "Resend" action (phase-88, Step 4). Same
   * guarded retry/resend path as `correctPinAndResend`.
   *
   * @param {number} localId
   * @returns {Promise<ServiceResult<FiscalResendResult>>}
   */
  resendFiscalization: (localId: number): Promise<ServiceResult<FiscalResendResult>> =>
    ipcRenderer.invoke('fiscal:resend', { localId }),

  /**
   * Prints an order's receipt at the fiscal device (docs/phase-196-2).
   * Requires a re-verified admin Manager PIN, and succeeds only when the
   * device's last receipt is this order's.
   *
   * @param {number} orderId
   * @param {number} managerId — admin staff id authorizing this action
   * @param {string} managerPin — that admin's PIN, captured via `ManagerPinModal`
   * @returns {Promise<ServiceResult<{ issuedNewReceipt: boolean }>>}
   */
  printFiscalDuplicate: (
    orderId: number,
    managerId: number,
    managerPin: string
  ): Promise<ServiceResult<{ issuedNewReceipt: boolean }>> =>
    ipcRenderer.invoke('fiscal:print-duplicate', { orderId, managerId, managerPin }),

  /**
   * Registers the renderer's answer to the main process asking it to save its
   * cart draft before the app quits (docs/phase-197-1). `handler` writes the
   * draft; the main process is told when it has finished, whether it
   * succeeded or threw. Returns a function that removes the listener.
   *
   * @param {() => Promise<void> | void} handler
   * @returns {() => void} unsubscribe
   */
  onCartFlushRequest: (handler: () => Promise<void> | void): (() => void) => {
    const listener = (): void => {
      void Promise.resolve()
        .then(handler)
        .catch(() => undefined)
        .finally(() => ipcRenderer.send('cart:flush-done'))
    }
    ipcRenderer.on('cart:flush-request', listener)
    return () => ipcRenderer.removeListener('cart:flush-request', listener)
  },

  /**
   * Saves the cart being built so it survives a restart (docs/phase-197).
   * Lines only - never payment state.
   *
   * @param {{ cartToken: string, items: CartItem[] }} draft
   * @returns {Promise<ServiceResult<void>>}
   */
  saveCartDraft: (draft: { cartToken: string; items: CartItem[] }): Promise<ServiceResult<void>> =>
    ipcRenderer.invoke('cart:save-draft', draft),

  /**
   * @returns {Promise<ServiceResult<{ payloadJson: string } | null>>} the saved cart, or `null`
   */
  loadCartDraft: (): Promise<ServiceResult<{ payloadJson: string } | null>> =>
    ipcRenderer.invoke('cart:load-draft'),

  /**
   * Deletes the saved cart (docs/phase-197).
   *
   * @returns {Promise<ServiceResult<void>>}
   */
  clearCartDraft: (): Promise<ServiceResult<void>> => ipcRenderer.invoke('cart:clear-draft'),

  /**
   * Records manager-approved cart removals; the main process re-verifies
   * the manager PIN (docs/phase-197).
   *
   * @param {CartRemovalRequest} request
   * @returns {Promise<ServiceResult<void>>}
   */
  recordCartRemovals: (request: CartRemovalRequest): Promise<ServiceResult<void>> =>
    ipcRenderer.invoke('cart:record-removals', request),

  /**
   * Every sale on hold or resumed on this till (docs/phase-217).
   *
   * @returns {Promise<ServiceResult<HeldSaleSummary[]>>}
   */
  listHeldSales: (): Promise<ServiceResult<HeldSaleSummary[]>> => ipcRenderer.invoke('held:list'),

  /**
   * Parks the cart. Not a sale: nothing is filed, queued or counted (docs/phase-217).
   *
   * @param {HoldSaleRequest} request
   * @returns {Promise<ServiceResult<HeldSaleSummary>>}
   */
  holdSale: (request: HoldSaleRequest): Promise<ServiceResult<HeldSaleSummary>> =>
    ipcRenderer.invoke('held:hold', request),

  /**
   * Takes a held sale back; its lines come back exactly as held (docs/phase-217).
   *
   * @param {number} id
   * @returns {Promise<ServiceResult<{ summary: HeldSaleSummary; payloadJson: string }>>}
   */
  resumeHeldSale: (id: number): Promise<ServiceResult<{ summary: HeldSaleSummary; payloadJson: string }>> =>
    ipcRenderer.invoke('held:resume', { id }),

  /**
   * @param {number} id
   * @param {string} label
   * @returns {Promise<ServiceResult<HeldSaleSummary>>}
   */
  renameHeldSale: (id: number, label: string): Promise<ServiceResult<HeldSaleSummary>> =>
    ipcRenderer.invoke('held:rename', { id, label }),

  /**
   * Discards a held sale; the main process re-verifies the manager PIN (docs/phase-217).
   *
   * @param {DiscardHeldSaleRequest} request
   * @returns {Promise<ServiceResult<HeldSaleSummary>>}
   */
  discardHeldSale: (request: DiscardHeldSaleRequest): Promise<ServiceResult<HeldSaleSummary>> =>
    ipcRenderer.invoke('held:discard', request),

  /**
   * Held sales discarded on one Africa/Nairobi day, for End of Day (docs/phase-217).
   *
   * @param {string} [localDay] `YYYY-MM-DD`; today when omitted
   * @returns {Promise<ServiceResult<DiscardedHeldSale[]>>}
   */
  getDiscardedHeldSales: (localDay?: string): Promise<ServiceResult<DiscardedHeldSale[]>> =>
    ipcRenderer.invoke('held:discarded-for-day', { localDay }),

  /**
   * The back-office "needs attention" list — every `needs_fixing` sale
   * plus every stuck-`waiting` sale (phase-88, Step 4).
   *
   * @returns {Promise<ServiceResult<NeedsAttentionRow[]>>}
   */
  getSalesNeedingAttention: (): Promise<ServiceResult<NeedsAttentionRow[]>> =>
    ipcRenderer.invoke('fiscal:needs-attention'),

  /**
   * The Rule-3 safety-net count: every completed-but-unfiled sale,
   * regardless of the stuck threshold (phase-88, Step 4).
   *
   * @returns {Promise<ServiceResult<number>>}
   */
  getUnfiledSalesCount: (): Promise<ServiceResult<number>> =>
    ipcRenderer.invoke('fiscal:unfiled-count'),

  /**
   * Whether this till is running the real fiscal provider (docs/phase-161,
   * Commit 1) - the renderer hides discount/price-override controls, and
   * blocks a cart that already carries one, only when this is `true`.
   *
   * @returns {Promise<ServiceResult<boolean>>}
   */
  isFiscalLive: (): Promise<ServiceResult<boolean>> =>
    ipcRenderer.invoke('fiscal:is-live'),

  /**
   * Prints (or, in mock mode, logs) a receipt for a local order.
   *
   * @param {number} localId
   * @param {object} [options]
   * @param {PrinterType} [options.printerType] — routes to a registered
   *   printer of this type; defaults to `'receipt'` when omitted.
   * @param {boolean} [options.auto] — set for the automatic end-of-sale
   *   print (docs/phase-165): on a printer-offline PDF fallback, the file
   *   is still saved but never force-opened in a viewer, unlike a manual
   *   print. Never set by a manual Order History print.
   * @param {number} [options.staffId] — the cashier signed in; recorded against an Order History reprint (docs/phase-198).
   * @param {boolean} [options.fiscalOnly] — print only the fiscal slip (docs/phase-198).
   * @returns {Promise<ServiceResult<ReceiptPrintResult>>}
   */
  printReceipt: (
    localId: number,
    options?: { printerType?: PrinterType; auto?: boolean; staffId?: number; fiscalOnly?: boolean }
  ): Promise<ServiceResult<ReceiptPrintResult>> =>
    ipcRenderer.invoke('receipt:print', {
      localId,
      printerType: options?.printerType,
      auto: options?.auto,
      staffId: options?.staffId,
      fiscalOnly: options?.fiscalOnly
    }),

  /**
   * Sales whose stored device VAT figures disagree with the till's own
   * (docs/phase-198-1), for the Needs Attention list.
   *
   * @returns {Promise<ServiceResult<VatMismatchRow[]>>}
   */
  getVatMismatches: (): Promise<ServiceResult<VatMismatchRow[]>> => ipcRenderer.invoke('fiscal:vat-mismatches'),

  /**
   * Filed sales whose fiscal slip never reached paper (docs/phase-198), for
   * the Needs Attention list.
   *
   * @returns {Promise<ServiceResult<UnprintedFiscalSlipRow[]>>}
   */
  getUnprintedFiscalSlips: (): Promise<ServiceResult<UnprintedFiscalSlipRow[]>> =>
    ipcRenderer.invoke('fiscal:unprinted-slips'),

  /**
   * Prints (or, in mock mode, logs) a shift's Z-report.
   *
   * @param {number} shiftId
   * @returns {Promise<ServiceResult<ReceiptPrintResult>>}
   */
  printZReport: (
    shiftId: number
  ): Promise<ServiceResult<ReceiptPrintResult>> =>
    ipcRenderer.invoke('receipt:print', { shiftId, isZReport: true }),

  /**
   * Fetches every active staff account for the login picker.
   *
   * @returns {Promise<ServiceResult<StaffSummary[]>>}
   */
  getStaffList: (): Promise<ServiceResult<StaffSummary[]>> =>
    ipcRenderer.invoke('staff:list'),

  /**
   * Verifies a staff PIN and opens a new shift on success.
   *
   * @param {number} staffId
   * @param {string} pin
   * @returns {Promise<ServiceResult<StaffSummary>>}
   */
  login: (
    staffId: number,
    pin: string
  ): Promise<ServiceResult<StaffSummary>> =>
    ipcRenderer.invoke('auth:login', { staffId, pin }),

  /**
   * Ends the renderer session. Authentication only — the till shift
   * is a separate, explicitly opened/closed concept.
   *
   * @param {number} staffId
   * @returns {Promise<ServiceResult<void>>}
   */
  logout: (staffId: number): Promise<ServiceResult<void>> =>
    ipcRenderer.invoke('auth:logout', { staffId }),

  /**
   * Creates a new staff account (Admin screen). Requires a re-verified
   * admin Manager PIN — the main process independently
   * checks `managerId`/`managerPin` before creating the account.
   *
   * @param {string} name
   * @param {string} pin
   * @param {StaffRole} role
   * @param {number} managerId — admin staff id authorizing this action
   * @param {string} managerPin — that admin's PIN, captured via `ManagerPinModal`
   * @returns {Promise<ServiceResult<StaffSummary>>}
   */
  createStaff: (
    name: string,
    pin: string,
    role: StaffRole,
    managerId: number,
    managerPin: string
  ): Promise<ServiceResult<StaffSummary>> =>
    ipcRenderer.invoke('staff:create', { name, pin, role, managerId, managerPin }),

  /**
   * Resets a staff member's PIN (Admin screen). Requires a re-verified
   * admin Manager PIN — the main process independently
   * checks `managerId`/`managerPin` before resetting the target PIN.
   *
   * @param {number} staffId
   * @param {string} pin
   * @param {number} managerId — admin staff id authorizing this action
   * @param {string} managerPin — that admin's PIN, captured via `ManagerPinModal`
   * @returns {Promise<ServiceResult<void>>}
   */
  resetStaffPin: (
    staffId: number,
    pin: string,
    managerId: number,
    managerPin: string
  ): Promise<ServiceResult<void>> =>
    ipcRenderer.invoke('staff:resetPin', { staffId, pin, managerId, managerPin }),

  /**
   * Reads the currently open till shift, if any.
   *
   * @returns {Promise<ServiceResult<ShiftRow | null>>}
   */
  getCurrentShift: (): Promise<ServiceResult<ShiftRow | null>> =>
    ipcRenderer.invoke('shifts:current'),

  /**
   * Asks the main process to write one event to `till.log` (docs/phase-228). Only the events on the main process's
   * short list are accepted, and the detail is flattened and capped there.
   *
   * @param {'shift-state-unreadable'} event
   * @param {string} [detail]
   * @returns {Promise<ServiceResult<void>>}
   */
  logTillEvent: (event: 'shift-state-unreadable', detail?: string): Promise<ServiceResult<void>> =>
    ipcRenderer.invoke('log:till-event', { event, detail }),

  /**
   * Opens the one shift of the current window (docs/phase-232). The type is the window's, from the clock in the main
   * process: it is not sent. `startingCash` is the cash counted in the drawer now.
   *
   * @param {number} staffId
   * @param {number} startingCash — the cash counted in the drawer now
   * @param {number} [mpesaOpeningBalance] — the M-Pesa till balance now, if it was read (docs/phase-222)
   * @param {OpenShiftOptions} [options] — what the form showed of the earlier sales, and an admin's start-at-0 choice
   * @returns {Promise<ServiceResult<{ shiftId: number }>>}
   */
  openShift: (
    staffId: number,
    startingCash: number,
    mpesaOpeningBalance?: number,
    options?: OpenShiftOptions
  ): Promise<ServiceResult<{ shiftId: number }>> =>
    ipcRenderer.invoke('shifts:open', { staffId, startingCash, mpesaOpeningBalance, ...options }),

  /**
   * Opens a shift under a manager's PIN, from the cart's "No shift open" dialog when the person at the till is not
   * an admin (docs/phase-227). The main process re-verifies the PIN and records the shift under that manager.
   *
   * @param {number} managerId
   * @param {string} managerPin
   * @param {number} startingCash — the cash counted in the drawer now
   * @param {number} [mpesaOpeningBalance]
   * @param {OpenShiftOptions} [options]
   * @returns {Promise<ServiceResult<{ shiftId: number }>>}
   */
  openShiftAsManager: (
    managerId: number,
    managerPin: string,
    startingCash: number,
    mpesaOpeningBalance?: number,
    options?: OpenShiftOptions
  ): Promise<ServiceResult<{ shiftId: number }>> =>
    ipcRenderer.invoke('shifts:open', {
      staffId: managerId,
      managerId,
      managerPin,
      startingCash,
      mpesaOpeningBalance,
      ...options
    }),

  /**
   * Closes the open till shift, reconciling counted cash.
   *
   * @param {number} shiftId
   * @param {number} endingCash
   * @param {number} [mpesaClosingBalance] — the M-Pesa till balance, if it was read (docs/phase-222)
   * @returns {Promise<ServiceResult<ShiftCloseResult>>}
   */
  closeShift: (
    shiftId: number,
    endingCash: number,
    mpesaClosingBalance?: number
  ): Promise<ServiceResult<ShiftCloseResult>> =>
    ipcRenderer.invoke('shifts:close', { shiftId, endingCash, mpesaClosingBalance }),

  /**
   * The shift window of this moment, its shift, the earlier sales an Open Shift would bring in, and when the open
   * shift may be closed (docs/phase-232). Read-only: the screens carry no time rule of their own.
   *
   * @returns {Promise<ServiceResult<ShiftWindowStatus>>}
   */
  getShiftWindowStatus: (): Promise<ServiceResult<ShiftWindowStatus>> => ipcRenderer.invoke('shifts:window-status'),

  /**
   * The combined report of one window: every shift that began in it, each with its own Z report, and the sums that
   * are safe to add (docs/phase-232). Read-only.
   *
   * @param {ShiftType} type
   * @param {string} startDate — `YYYY-MM-DD`
   * @returns {Promise<ServiceResult<WindowReport>>}
   */
  getWindowReport: (type: ShiftType, startDate: string): Promise<ServiceResult<WindowReport>> =>
    ipcRenderer.invoke('reports:window-report', { type, startDate }),

  /**
   * Gives every sale with no shift to the shift it belongs to (docs/phase-232). Takes no input and no PIN: it can
   * only do what the rules say, and running it again changes nothing.
   *
   * @returns {Promise<ServiceResult<AutoAssignResult>>}
   */
  autoAssignSales: (): Promise<ServiceResult<AutoAssignResult>> => ipcRenderer.invoke('shifts:auto-assign'),

  /**
   * What moving one sale to another shift would do (docs/phase-232). Read-only.
   *
   * @param {number} orderId
   * @param {number} toShiftId
   * @param {boolean} [override] — preview with the closed-shift rules lifted (docs/phase-244)
   * @returns {Promise<ServiceResult<SaleMovePreview>>}
   */
  previewSaleMove: (orderId: number, toShiftId: number, override?: boolean): Promise<ServiceResult<SaleMovePreview>> =>
    ipcRenderer.invoke('shifts:move-sale-preview', { orderId, toShiftId, ...(override ? { override: true } : {}) }),

  /**
   * Moves one sale to another shift (docs/phase-232, S5). Admin-gated: the main process re-verifies the PIN.
   *
   * @param {MoveSaleRequest} request
   * @returns {Promise<ServiceResult<{ fromShiftId: number; toShiftId: number }>>}
   */
  moveSale: (request: MoveSaleRequest): Promise<ServiceResult<{ fromShiftId: number; toShiftId: number }>> =>
    ipcRenderer.invoke('shifts:move-sale', request),

  /**
   * What merging one shift into another would do (docs/phase-239). Read-only.
   *
   * @param {number} absorbedShiftId
   * @param {number} intoShiftId
   * @returns {Promise<ServiceResult<ShiftMergePreview>>}
   */
  previewShiftMerge: (absorbedShiftId: number, intoShiftId: number): Promise<ServiceResult<ShiftMergePreview>> =>
    ipcRenderer.invoke('shifts:merge-preview', { absorbedShiftId, intoShiftId }),

  /**
   * Merges one closed shift into another of the same window (docs/phase-239). Admin-gated: the main process
   * re-verifies the PIN. No undo.
   *
   * @param {MergeShiftsRequest} request
   * @returns {Promise<ServiceResult<{ absorbedShiftId: number; intoShiftId: number; salesCount: number }>>}
   */
  mergeShifts: (
    request: MergeShiftsRequest
  ): Promise<ServiceResult<{ absorbedShiftId: number; intoShiftId: number; salesCount: number }>> =>
    ipcRenderer.invoke('shifts:merge', request),

  /**
   * Appends a correction to a closed shift's typed-in figures (docs/phase-224). Manager-gated: the main process
   * re-verifies the PIN. The shift's own row is never changed.
   *
   * @param {ShiftCorrectionRequest} request
   * @returns {Promise<ServiceResult<ShiftCorrectionRow>>}
   */
  correctShift: (request: ShiftCorrectionRequest): Promise<ServiceResult<ShiftCorrectionRow>> =>
    ipcRenderer.invoke('shifts:correct', request),

  /**
   * Generates the Z-report for a shift.
   *
   * @param {number} shiftId
   * @returns {Promise<ServiceResult<ZReport>>}
   */
  getZReport: (shiftId: number): Promise<ServiceResult<ZReport>> =>
    ipcRenderer.invoke('reports:z-report', { shiftId }),

  /**
   * Generates today's sales summary for the Admin screen.
   *
   * @returns {Promise<ServiceResult<DailySummary>>}
   */
  getDailySummary: (): Promise<ServiceResult<DailySummary>> =>
    ipcRenderer.invoke('reports:daily-summary'),

  /**
   * Generates the end-of-day report (docs/phase-151/152) for one
   * Africa/Nairobi calendar day, defaulting to today when omitted.
   * Read-only — any logged-in staff may call it.
   *
   * @param {string} [localDay] — `YYYY-MM-DD`
   * @param {number} [shiftId] — limit the report to this shift's sales on that day (docs/phase-241)
   * @returns {Promise<ServiceResult<EndOfDayReport>>}
   */
  getEndOfDayReport: (localDay?: string, shiftId?: number): Promise<ServiceResult<EndOfDayReport>> =>
    ipcRenderer.invoke('reports:end-of-day', { localDay, shiftId }),

  /**
   * A manager's end-of-day review: approves exactly the manual M-Pesa
   * entries named by `approvedIds`, and records why each id in
   * `excluded` was deliberately left pending (docs/phase-153) — both are
   * the ids/reasons the caller's own report displayed. Requires a
   * re-verified admin Manager PIN.
   *
   * @param {object} request
   * @param {string} request.localDay
   * @param {number[]} request.approvedIds
   * @param {Array<{ paymentId: number; reason?: string }>} request.excluded
   * @param {number} request.managerId
   * @param {string} request.managerPin
   * @param {string} [request.note]
   * @returns {Promise<ServiceResult<ApproveMpesaEntriesResult>>}
   */
  approveDayReport: (request: {
    localDay: string
    approvedIds: number[]
    excluded: Array<{ paymentId: number; reason?: string }>
    managerId: number
    managerPin: string
    note?: string
  }): Promise<ServiceResult<ApproveMpesaEntriesResult>> =>
    ipcRenderer.invoke('reports:approve-day', request),

  /**
   * One page of shift history, most recently opened first (docs/phase-158).
   *
   * @param {number} page — 1-indexed
   * @returns {Promise<ServiceResult<{ shifts: ShiftRow[]; total: number; page: number }>>}
   */
  getShiftsList: (
    page: number
  ): Promise<ServiceResult<{ shifts: ShiftRow[]; total: number; page: number }>> =>
    ipcRenderer.invoke('reports:shifts-list', { page }),

  /**
   * A sales summary for one of the fixed Nairobi date-range presets.
   *
   * @param {ReportRangePreset} preset
   * @returns {Promise<ServiceResult<SalesSummary>>}
   */
  getSalesSummary: (preset: ReportRangePreset): Promise<ServiceResult<SalesSummary>> =>
    ipcRenderer.invoke('reports:sales-summary', { preset }),

  /**
   * Order counts by fiscal status, one row per Nairobi calendar day
   * within the preset.
   *
   * @param {ReportRangePreset} preset
   * @returns {Promise<ServiceResult<FiscalStatusDayCount[]>>}
   */
  getFiscalStatusByDay: (
    preset: ReportRangePreset
  ): Promise<ServiceResult<FiscalStatusDayCount[]>> =>
    ipcRenderer.invoke('reports:fiscal-by-day', { preset }),

  /**
   * The fiscal reconciliation report (docs/phase-163, Commit 2) for one
   * of the fixed Nairobi date-range presets — every fiscalized order
   * compared against the device's own stored per-VAT-group amounts.
   *
   * @param {ReportRangePreset} preset
   * @returns {Promise<ServiceResult<FiscalReconciliationReport>>}
   */
  getFiscalReconciliation: (
    preset: ReportRangePreset
  ): Promise<ServiceResult<FiscalReconciliationReport>> =>
    ipcRenderer.invoke('reports:fiscal-reconciliation', { preset }),

  /**
   * One page of orders (CU and trader invoice numbers included) for the
   * invoice list.
   *
   * @param {ReportRangePreset} preset
   * @param {number} page — 1-indexed
   * @returns {Promise<ServiceResult<{ orders: OrderRow[]; total: number; page: number }>>}
   */
  getInvoiceList: (
    preset: ReportRangePreset,
    page: number
  ): Promise<
    ServiceResult<{
      invoices: Array<{ order: OrderRow; traderInvoiceNumber: string }>
      total: number
      page: number
    }>
  > => ipcRenderer.invoke('reports:invoice-list', { preset, page }),

  /**
   * Exports orders or line items for a preset as CSV, via the OS save
   * dialog — the user picks where the file is written (e.g. a USB
   * stick). A cancelled dialog resolves `{ saved: false }`, not an error.
   *
   * @param {ReportRangePreset} preset
   * @param {'orders' | 'lines'} kind
   * @returns {Promise<ServiceResult<{ saved: boolean; filePath?: string }>>}
   */
  exportReportsCsv: (
    preset: ReportRangePreset,
    kind: 'orders' | 'lines'
  ): Promise<ServiceResult<{ saved: boolean; filePath?: string }>> =>
    ipcRenderer.invoke('reports:export-csv', { preset, kind }),

  /**
   * Triggers an update check against the configured GitHub Releases feed.
   * Results arrive asynchronously via {@link onUpdateStatus}.
   *
   * @returns {Promise<ServiceResult<void>>}
   */
  checkForUpdates: (): Promise<ServiceResult<void>> =>
    ipcRenderer.invoke('updater:check'),

  /**
   * Quits and relaunches the app to install a downloaded update.
   *
   * @returns {Promise<ServiceResult<void>>}
   */
  installUpdate: (): Promise<ServiceResult<void>> =>
    ipcRenderer.invoke('updater:install'),

  /**
   * Checks for an update once per app start (docs/phase-219). Resolves with the version
   * on offer, or null when there is none, this run has already checked, or the check failed.
   *
   * @returns {Promise<ServiceResult<string | null>>}
   */
  startupUpdateCheck: (): Promise<ServiceResult<string | null>> =>
    ipcRenderer.invoke('updater:startup-check'),

  /**
   * Downloads the update the last check found, on request (docs/phase-219). Resolves when
   * the download has finished or failed; progress arrives through {@link onUpdateStatus}.
   *
   * @returns {Promise<ServiceResult<void>>}
   */
  downloadUpdate: (): Promise<ServiceResult<void>> =>
    ipcRenderer.invoke('updater:download'),

  /**
   * Subscribes to auto-update status changes broadcast by the main
   * process. Returns a cleanup function that removes the listener.
   *
   * @param {(status: UpdateStatus) => void} callback
   * @returns {() => void} unsubscribe
   */
  onUpdateStatus: (callback: (status: UpdateStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: UpdateStatus): void =>
      callback(status)
    ipcRenderer.on('updater:status', listener)
    return () => ipcRenderer.removeListener('updater:status', listener)
  },

  /**
   * Reads the result of the most recently completed over-the-air update,
   * or `null` if none has landed since it was last resolved.
   *
   * @returns {Promise<ServiceResult<LastUpdateResult | null>>}
   */
  getLastUpdateResult: (): Promise<ServiceResult<LastUpdateResult | null>> =>
    ipcRenderer.invoke('updater:last-result'),

  /**
   * Initiates an M-Pesa STK Push prompt to the customer's phone. This
   * is a placeholder pending real Daraja API integration.
   *
   * @param {StkPushRequest} request
   * @returns {Promise<ServiceResult<StkPushResult>>}
   */
  initiateMpesaStkPush: (
    request: StkPushRequest
  ): Promise<ServiceResult<StkPushResult>> =>
    ipcRenderer.invoke('integrations:mpesa-stk-push', request),

  /**
   * Recent M-Pesa payments this till received by message that no sale has
   * used yet, plus one sentence on the reader's health so an empty list
   * is never ambiguous.
   *
   * @returns {Promise<ServiceResult<{ payments: UnmatchedMpesaPayment[]; health: string | null }>>}
   */
  listUnmatchedMpesaPayments: (): Promise<
    ServiceResult<{ payments: UnmatchedMpesaPayment[]; health: string | null }>
  > => ipcRenderer.invoke('mpesa-sms:list-unmatched'),

  /**
   * Reports what this till's M-Pesa provider can do, so a payment
   * screen never offers a route that cannot end in a confirmed payment.
   * `mode` is how the till confirms M-Pesa payments (`'manual'` by
   * default) — `PaymentModal` renders an entirely different screen per
   * mode rather than inferring it from the two booleans alone.
   *
   * @returns {Promise<ServiceResult<{ manualCodeSupported: boolean; manualEntryEnabled: boolean; mode: MpesaConfirmationMethod }>>}
   */
  getMpesaCapabilities: (): Promise<
    ServiceResult<{
      manualCodeSupported: boolean
      manualEntryEnabled: boolean
      mode: MpesaConfirmationMethod
    }>
  > => ipcRenderer.invoke('integrations:mpesa-capabilities'),

  /**
   * Every M-Pesa payment that settled a sale, across all three modes.
   *
   * @returns {Promise<ServiceResult<MpesaPaymentRow[]>>}
   */
  listMpesaPayments: (): Promise<ServiceResult<MpesaPaymentRow[]>> =>
    ipcRenderer.invoke('mpesa:list-payments'),

  /**
   * Manually entered payments nobody has yet checked against the M-Pesa
   * statement — the reconciliation queue.
   *
   * @returns {Promise<ServiceResult<MpesaPaymentRow[]>>}
   */
  listUnreconciledMpesaPayments: (): Promise<ServiceResult<MpesaPaymentRow[]>> =>
    ipcRenderer.invoke('mpesa:list-unreconciled'),

  /**
   * Marks one manual payment as checked against the statement. Requires
   * a re-verified admin Manager PIN.
   *
   * @param {number} paymentId
   * @param {number} managerId
   * @param {string} managerPin
   * @param {string} [note]
   * @returns {Promise<ServiceResult<void>>}
   */
  reconcileMpesaPayment: (
    paymentId: number,
    managerId: number,
    managerPin: string,
    note?: string
  ): Promise<ServiceResult<void>> =>
    ipcRenderer.invoke('mpesa:reconcile', { paymentId, managerId, managerPin, note }),

  /**
   * Verifies a manually entered M-Pesa transaction code against
   * whatever confirmation source this till has.
   *
   * @param {ManualCodeVerification} request
   * @returns {Promise<ServiceResult<ManualCodeVerificationResult>>}
   */
  verifyMpesaCode: (
    request: ManualCodeVerification
  ): Promise<ServiceResult<ManualCodeVerificationResult>> =>
    ipcRenderer.invoke('integrations:mpesa-verify-code', request),

  /**
   * Logs a newly initiated STK Push for the M-Pesa Logs screen.
   *
   * @param {object} request
   * @param {number} [request.orderLocalId]
   * @param {string} request.checkoutRequestId
   * @param {string} request.merchantRequestId
   * @param {string} request.phoneNumber
   * @param {number} request.amount
   * @param {'pending' | 'success' | 'failed'} [request.status] — defaults to `'pending'`
   * @returns {Promise<ServiceResult<{ id: number }>>}
   */
  logMpesaTransaction: (request: {
    orderLocalId?: number
    checkoutRequestId: string
    merchantRequestId: string
    phoneNumber: string
    amount: number
    status?: 'pending' | 'success' | 'failed'
  }): Promise<ServiceResult<{ id: number }>> =>
    ipcRenderer.invoke('mpesa:log-transaction', request),

  /**
   * Fetches recent M-Pesa transactions for the M-Pesa Logs screen.
   *
   * @param {number} [limit=50]
   * @returns {Promise<ServiceResult<MpesaTransactionRow[]>>}
   */
  getMpesaTransactions: (limit?: number): Promise<ServiceResult<MpesaTransactionRow[]>> =>
    ipcRenderer.invoke('mpesa:get-logs', limit),

  /**
   * Re-checks a pending STK Push's outcome and persists the result —
   * the M-Pesa Logs screen's "Check Status" action.
   *
   * @param {string} checkoutRequestId
   * @returns {Promise<ServiceResult<StkPushStatusResult>>}
   */
  queryMpesaStatus: (checkoutRequestId: string): Promise<ServiceResult<StkPushStatusResult>> =>
    ipcRenderer.invoke('mpesa:query-status', checkoutRequestId),

  /**
   * Reports whether the M-Pesa consumer secret / passkey are
   * currently stored in the credential vault — never the values.
   *
   * @returns {Promise<ServiceResult<{ consumerSecretConfigured: boolean; passkeyConfigured: boolean }>>}
   */
  getMpesaCredentialStatus: (): Promise<
    ServiceResult<{ consumerSecretConfigured: boolean; passkeyConfigured: boolean }>
  > => ipcRenderer.invoke('secrets:get-mpesa-status'),

  /**
   * Saves the M-Pesa consumer secret and/or passkey to the credential
   * vault (Admin screen). Requires a re-verified admin Manager PIN.
   * Takes effect on next restart.
   *
   * @param {object} credentials
   * @param {string} [credentials.consumerSecret]
   * @param {string} [credentials.passkey]
   * @param {number} managerId
   * @param {string} managerPin
   * @returns {Promise<ServiceResult<void>>}
   */
  setMpesaCredentials: (
    credentials: { consumerSecret?: string; passkey?: string },
    managerId: number,
    managerPin: string
  ): Promise<ServiceResult<void>> =>
    ipcRenderer.invoke('secrets:set-mpesa-credentials', { ...credentials, managerId, managerPin }),

  /**
   * Verifies the currently configured Daraja credentials via an
   * OAuth2 token exchange only — no STK Push, no charge.
   *
   * @returns {Promise<ServiceResult<void>>}
   */
  testMpesaConnection: (): Promise<ServiceResult<void>> => ipcRenderer.invoke('config:test-mpesa'),

  /**
   * Reads every `app_configurations` value, optionally scoped to one
   * category, for the Admin screen.
   *
   * @param {AppConfigCategory} [category]
   * @returns {Promise<ServiceResult<Record<string, string>>>}
   */
  getAllConfigs: (category?: AppConfigCategory): Promise<ServiceResult<Record<string, string>>> =>
    ipcRenderer.invoke('config:get-all', category),

  /**
   * Writes one `app_configurations` value (Admin screen). Requires a
   * re-verified admin Manager PIN.
   *
   * @param {string} key
   * @param {string} value
   * @param {object} [options]
   * @param {boolean} [options.requiresRestart]
   * @param {AppConfigCategory} [options.category]
   * @param {number} managerId
   * @param {string} managerPin
   * @returns {Promise<ServiceResult<void>>}
   */
  setConfig: (
    key: string,
    value: string,
    options: { requiresRestart?: boolean; category?: AppConfigCategory } | undefined,
    managerId: number,
    managerPin: string
  ): Promise<ServiceResult<void>> =>
    ipcRenderer.invoke('config:set', { key, value, ...options, managerId, managerPin }),

  /**
   * Relaunches the app — used after saving a `requiresRestart`
   * configuration.
   *
   * @returns {Promise<ServiceResult<void>>}
   */
  restartApp: (): Promise<ServiceResult<void>> => ipcRenderer.invoke('app:restart'),

  /**
   * Reads a provider's stored integration config (Admin screen).
   *
   * @param {IntegrationProviderName} provider
   * @returns {Promise<ServiceResult<Record<string, unknown>>>}
   */
  getIntegrationConfig: (
    provider: IntegrationProviderName
  ): Promise<ServiceResult<Record<string, unknown>>> =>
    ipcRenderer.invoke('integrations:get-config', provider),

  /**
   * Saves a provider's integration config (Admin screen). Requires a
   * re-verified admin Manager PIN — the main process
   * independently checks `managerId`/`managerPin` before writing the
   * config (Paybill/Till numbers, middleware URLs).
   *
   * @param {IntegrationProviderName} provider
   * @param {Record<string, unknown>} config
   * @param {number} managerId — admin staff id authorizing this action
   * @param {string} managerPin — that admin's PIN, captured via `ManagerPinModal`
   * @returns {Promise<ServiceResult<void>>}
   */
  setIntegrationConfig: (
    provider: IntegrationProviderName,
    config: Record<string, unknown>,
    managerId: number,
    managerPin: string
  ): Promise<ServiceResult<void>> =>
    ipcRenderer.invoke('integrations:set-config', { provider, config, managerId, managerPin }),

  /**
   * Lists every configured printer (Admin screen
   * Peripherals tab). A `connectionType: 'windows'` entry carries
   * `missing: true` when its saved queue is no longer installed
   * (docs/phase-174).
   *
   * @returns {Promise<ServiceResult<PrinterWithAvailability[]>>}
   */
  getPrinters: (): Promise<ServiceResult<PrinterWithAvailability[]>> =>
    ipcRenderer.invoke('printers:list'),

  /**
   * Upserts a printer configuration. Requires a re-verified admin
   * Manager PIN — the main process independently checks
   * `managerId`/`managerPin` before writing the row.
   *
   * @param {PrinterConfig} config
   * @param {number} managerId — admin staff id authorizing this action
   * @param {string} managerPin — that admin's PIN, captured via `ManagerPinModal`
   * @returns {Promise<ServiceResult<void>>}
   */
  savePrinter: (
    config: PrinterConfig,
    managerId: number,
    managerPin: string
  ): Promise<ServiceResult<void>> =>
    ipcRenderer.invoke('printers:save', { ...config, managerId, managerPin }),

  /**
   * Removes a printer configuration. Requires a re-verified admin
   * Manager PIN, matching `savePrinter`.
   *
   * @param {string} id
   * @param {number} managerId — admin staff id authorizing this action
   * @param {string} managerPin — that admin's PIN, captured via `ManagerPinModal`
   * @returns {Promise<ServiceResult<void>>}
   */
  deletePrinter: (
    id: string,
    managerId: number,
    managerPin: string
  ): Promise<ServiceResult<void>> =>
    ipcRenderer.invoke('printers:delete', { id, managerId, managerPin }),

  /**
   * Sends a test page to verify connectivity — no manager PIN required
   * (read-only diagnostic). Either a network printer interface
   * (unchanged), or (docs/phase-174, Windows only) a Windows printer
   * queue's system name, sent RAW.
   *
   * @param {{ interfaceName: string } | { connectionType: 'windows'; windowsPrinterName: string }} target
   * @returns {Promise<ServiceResult<ReceiptPrintResult>>}
   */
  testPrinter: (
    target: { interfaceName: string } | { connectionType: 'windows'; windowsPrinterName: string }
  ): Promise<ServiceResult<ReceiptPrintResult>> => ipcRenderer.invoke('printers:test', target),

  /**
   * Lists Windows printer queues (USB or COM/serial) for the Admin
   * screen's "Find printers" button (docs/phase-174, Windows only).
   *
   * @returns {Promise<ServiceResult<WindowsPrinterInfo[]>>}
   */
  findWindowsPrinters: (): Promise<ServiceResult<WindowsPrinterInfo[]>> =>
    ipcRenderer.invoke('printers:find-windows'),

  /**
   * Reports whether a Shopify Admin API token is currently stored in
   * the credential vault — never the token value itself.
   *
   * @returns {Promise<ServiceResult<{ configured: boolean }>>}
   */
  getShopifyTokenStatus: (): Promise<ServiceResult<{ configured: boolean }>> =>
    ipcRenderer.invoke('secrets:get-shopify-token-status'),

  /**
   * Saves the Shopify Admin API token to the credential vault.
   * Write-only — there is no corresponding "get the
   * value" channel.
   *
   * @param {string} token
   * @returns {Promise<ServiceResult<void>>}
   */
  setShopifyToken: (token: string): Promise<ServiceResult<void>> =>
    ipcRenderer.invoke('secrets:set-shopify-token', token),

  /**
   * Reads the currently resolved Shopify store URL — not a
   * secret, so unlike the token this returns the actual value.
   *
   * @returns {Promise<ServiceResult<{ storeUrl: string | null }>>}
   */
  getShopifyStoreUrl: (): Promise<ServiceResult<{ storeUrl: string | null }>> =>
    ipcRenderer.invoke('shopify:get-store-url'),

  /**
   * Saves the Shopify store URL to the local settings table — lets
   * an install be configured without a `.env` file.
   * Requires a re-verified admin Manager PIN.
   *
   * @param {string} storeUrl
   * @param {number} managerId — admin staff id authorizing this action
   * @param {string} managerPin — that admin's PIN, captured via `ManagerPinModal`
   * @returns {Promise<ServiceResult<void>>}
   */
  setShopifyStoreUrl: (
    storeUrl: string,
    managerId: number,
    managerPin: string
  ): Promise<ServiceResult<void>> =>
    ipcRenderer.invoke('shopify:set-store-url', { storeUrl, managerId, managerPin }),

  /**
   * Reports whether this till already has a working Shopify connection
   * and whether its location has been explicitly admin-confirmed —
   * `App.tsx` calls this on mount (and after location confirmation)
   * to decide between `OnboardingScreen`, the normal Login screen,
   * the location-confirmation gate, and the main POS shell.
   *
   * @returns {Promise<ServiceResult<{ hasConfig: boolean; locationConfirmed: boolean; config?: { storeUrl: string; locationId: string | null; locationName: string | null } }>>}
   */
  getConfigStatus: (): Promise<
    ServiceResult<{
      hasConfig: boolean
      locationConfirmed: boolean
      config?: { storeUrl: string; locationId: string | null; locationName: string | null }
    }>
  > => ipcRenderer.invoke('config:get-status'),

  /**
   * Onboarding wizard's "Connect & Verify" step — verifies
   * a store URL/token pair against the live Shopify API and returns
   * the shop name plus its locations. Saves nothing.
   *
   * @param {string} storeUrl
   * @param {string} token
   * @returns {Promise<ServiceResult<{ shopName: string; locations: { id: string; name: string; address?: string }[] }>>}
   */
  validateShopifyConfig: (
    storeUrl: string,
    token: string
  ): Promise<ServiceResult<{ shopName: string; locations: { id: string; name: string; address?: string }[] }>> =>
    ipcRenderer.invoke('config:validate', { storeUrl, token }),

  /**
   * Fetches this till's already-resolved Shopify store URL/token
   * (nothing re-entered) and returns its available locations, for
   * the post-login location-confirmation gate and the Admin screen's
   * "Change Location" control.
   *
   * @returns {Promise<ServiceResult<{ shopName: string; locations: { id: string; name: string; address?: string }[] }>>}
   */
  listLocations: (): Promise<
    ServiceResult<{ shopName: string; locations: { id: string; name: string; address?: string }[] }>
  > => ipcRenderer.invoke('location:list'),

  /**
   * Persists the admin-confirmed location for this till. Requires a
   * re-verified admin Manager PIN.
   *
   * @param {string} locationId
   * @param {string} locationName
   * @param {number} managerId
   * @param {string} managerPin
   * @returns {Promise<ServiceResult<void>>}
   */
  setLocation: (
    locationId: string,
    locationName: string,
    managerId: number,
    managerPin: string
  ): Promise<ServiceResult<void>> =>
    ipcRenderer.invoke('location:set', { locationId, locationName, managerId, managerPin }),

  /**
   * Persists the onboarding wizard's verified store URL, token, and
   * selected location. No manager PIN — this runs before
   * any staff has signed in.
   *
   * @param {string} storeUrl
   * @param {string} token
   * @param {string} locationId
   * @param {string} locationName
   * @returns {Promise<ServiceResult<void>>}
   */
  saveConfig: (
    storeUrl: string,
    token: string,
    locationId: string,
    locationName: string
  ): Promise<ServiceResult<void>> =>
    ipcRenderer.invoke('config:save', { storeUrl, token, locationId, locationName }),

  /**
   * Admin screen's "Reset Configuration" action —
   * clears the store URL, vault token, and confirmed location,
   * returning the till to the first-run onboarding state. Requires a
   * re-verified admin Manager PIN.
   *
   * @param {number} managerId
   * @param {string} managerPin
   * @returns {Promise<ServiceResult<void>>}
   */
  clearConfig: (managerId: number, managerPin: string): Promise<ServiceResult<void>> =>
    ipcRenderer.invoke('config:clear', { managerId, managerPin }),

  /**
   * Reports whether this till may proceed past the mandatory eTIMS
   * setup gate — always complete in mock mode, otherwise requires the
   * four Real-eTIMS connection fields to already be saved.
   *
   * @returns {Promise<ServiceResult<{ isComplete: boolean; missingFields: string[] }>>}
   */
  checkEtimsCompletion: (): Promise<
    ServiceResult<{ isComplete: boolean; missingFields: string[] }>
  > => ipcRenderer.invoke('setup:check-etims-completion'),

  /**
   * Saves the four required Real-eTIMS connection fields from the
   * setup gate. No manager PIN required.
   *
   * @param {object} config
   * @param {string} config.baseUrl
   * @param {string} config.deviceIp
   * @param {string} config.devicePort
   * @param {string} config.password
   * @returns {Promise<ServiceResult<void>>}
   */
  saveEtimsConfig: (config: {
    baseUrl: string
    deviceIp: string
    devicePort: string
    password: string
  }): Promise<ServiceResult<void>> => ipcRenderer.invoke('setup:save-etims-config', config),

  /**
   * Saves the fiscal device password to the credential vault. Requires a
   * re-verified admin Manager PIN. Applies to the next sale.
   *
   * @param {string} password
   * @param {number} managerId
   * @param {string} managerPin
   * @returns {Promise<ServiceResult<void>>}
   */
  setEtimsPassword: (
    password: string,
    managerId: number,
    managerPin: string
  ): Promise<ServiceResult<void>> =>
    ipcRenderer.invoke('secrets:set-etims-password', { password, managerId, managerPin }),

  /**
   * Reports whether a fiscal device password is stored, never the value.
   *
   * @returns {Promise<ServiceResult<{ passwordConfigured: boolean }>>}
   */
  getEtimsSecretStatus: (): Promise<ServiceResult<{ passwordConfigured: boolean }>> =>
    ipcRenderer.invoke('secrets:get-etims-status'),

  /**
   * Walks the three hops to the fiscal device and reports which one
   * broke, in plain words.
   *
   * @returns {Promise<ServiceResult<FiscalConnectionTestResult>>}
   */
  testEtimsConnection: (): Promise<ServiceResult<FiscalConnectionTestResult>> =>
    ipcRenderer.invoke('config:test-etims'),

  /**
   * Reads the seller identity fields printed on every receipt (docs/phase-171).
   *
   * @returns {Promise<ServiceResult<{ storeName: string; storeKraPin: string; legalName: string; address: string; phone: string; footerMessage: string }>>}
   */
  getStoreIdentity: (): Promise<
    ServiceResult<{
      storeName: string
      storeKraPin: string
      legalName: string
      address: string
      phone: string
      footerMessage: string
    }>
  > => ipcRenderer.invoke('store:get-identity'),

  /**
   * Saves the seller identity fields printed on every receipt
   * (docs/phase-171). Requires a re-verified admin Manager PIN.
   *
   * @param {object} identity
   * @param {number} managerId
   * @param {string} managerPin
   * @returns {Promise<ServiceResult<void>>}
   */
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
  ): Promise<ServiceResult<void>> =>
    ipcRenderer.invoke('store:set-identity', { ...identity, managerId, managerPin }),

  /**
   * Opens a stock-take session against a fresh Shopify read.
   * Online-only. The till's location is resolved in the main process
   * and is deliberately not a parameter here.
   *
   * @param {number} staffId — who is doing the counting
   * @returns {Promise<ServiceResult<StockTakeSessionView>>}
   */
  openStockTake: (staffId: number): Promise<ServiceResult<StockTakeSessionView>> =>
    ipcRenderer.invoke('stocktake:open', { staffId }),

  /**
   * Returns the stock take this till is currently working on, or null.
   *
   * @returns {Promise<ServiceResult<StockTakeSessionView | null>>}
   */
  getActiveStockTake: (): Promise<ServiceResult<StockTakeSessionView | null>> =>
    ipcRenderer.invoke('stocktake:active'),

  /**
   * Records one counted variant. Works offline.
   *
   * @param {object} count
   * @returns {Promise<ServiceResult<StockTakeSessionView>>}
   */
  recordStockTakeCount: (count: {
    sessionId: number
    variantId: string
    variantLabel: string
    countedQty: number
  }): Promise<ServiceResult<StockTakeSessionView>> => ipcRenderer.invoke('stocktake:count', count),

  /**
   * Drops one mis-scanned row from a session still being counted.
   *
   * @param {number} sessionId
   * @param {string} variantId
   * @returns {Promise<ServiceResult<StockTakeSessionView>>}
   */
  removeStockTakeCount: (
    sessionId: number,
    variantId: string
  ): Promise<ServiceResult<StockTakeSessionView>> =>
    ipcRenderer.invoke('stocktake:remove', { sessionId, variantId }),

  /**
   * Submits a counted session for manager approval.
   *
   * @param {number} sessionId
   * @returns {Promise<ServiceResult<StockTakeSessionView>>}
   */
  submitStockTake: (sessionId: number): Promise<ServiceResult<StockTakeSessionView>> =>
    ipcRenderer.invoke('stocktake:submit', { sessionId }),

  /**
   * Discards an uncommitted session. Requires a re-verified admin
   * Manager PIN.
   *
   * @param {number} sessionId
   * @param {number} managerId
   * @param {string} managerPin
   * @returns {Promise<ServiceResult<void>>}
   */
  abandonStockTake: (
    sessionId: number,
    managerId: number,
    managerPin: string
  ): Promise<ServiceResult<void>> =>
    ipcRenderer.invoke('stocktake:abandon', { sessionId, managerId, managerPin }),

  /**
   * Re-reads Shopify and returns what pushing this session would do.
   * Online-only; changes nothing.
   *
   * @param {number} sessionId
   * @returns {Promise<ServiceResult<StockTakePreview>>}
   */
  previewStockTake: (sessionId: number): Promise<ServiceResult<StockTakePreview>> =>
    ipcRenderer.invoke('stocktake:preview', { sessionId }),

  /**
   * Pushes an approved stock take to Shopify. Requires a re-verified
   * admin Manager PIN, plus a second approver above the configured
   * value threshold, and an explicit `confirm`.
   *
   * @param {object} request
   * @returns {Promise<ServiceResult<StockTakeCommitSummary>>}
   */
  commitStockTake: (request: {
    sessionId: number
    managerId: number
    managerPin: string
    secondApproverId?: number
    secondApproverPin?: string
  }): Promise<ServiceResult<StockTakeCommitSummary>> =>
    ipcRenderer.invoke('stocktake:commit', { ...request, confirm: true }),

  /**
   * Returns recent stock takes for the back-office history list.
   *
   * @returns {Promise<ServiceResult<StockTakeSessionView[]>>}
   */
  listStockTakes: (): Promise<ServiceResult<StockTakeSessionView[]>> =>
    ipcRenderer.invoke('stocktake:list'),

  /**
   * Reads the stock-take approval policy.
   *
   * @returns {Promise<ServiceResult<StockTakeSettings>>}
   */
  getStockTakeSettings: (): Promise<ServiceResult<StockTakeSettings>> =>
    ipcRenderer.invoke('stocktake:get-settings'),

  /**
   * Saves the stock-take approval policy. Requires a re-verified admin
   * Manager PIN.
   *
   * @param {StockTakeSettings} settings
   * @param {number} managerId
   * @param {string} managerPin
   * @returns {Promise<ServiceResult<void>>}
   */
  saveStockTakeSettings: (
    settings: StockTakeSettings,
    managerId: number,
    managerPin: string
  ): Promise<ServiceResult<void>> =>
    ipcRenderer.invoke('stocktake:save-settings', { ...settings, managerId, managerPin }),

  /** The Shopify sales-safety check's latest result (docs/phase-170), or `null` before the first check has run. */
  getShopifyReconciliationStatus: (): Promise<ServiceResult<ReconciliationResult | null>> =>
    ipcRenderer.invoke('shopify:get-reconciliation-status'),

  /** Subscribes to a freshly completed Shopify check; returns an unsubscribe fn. */
  onShopifyReconciliationStatus: (
    callback: (result: ReconciliationResult) => void
  ): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, result: ReconciliationResult): void =>
      callback(result)
    ipcRenderer.on('shopify-reconciliation:status', listener)
    return () => ipcRenderer.removeListener('shopify-reconciliation:status', listener)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
  } catch (error) {
    console.error('[preload] failed to expose window.electron:', error)
  }
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error('[preload] failed to expose window.api:', error)
  }
} else {
  // @ts-ignore — augmented via src/preload/index.d.ts
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}
