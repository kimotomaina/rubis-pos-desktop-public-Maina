import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { ServiceResult } from '../main/services/shopify-types.js'
import type { ProductSummary } from '../renderer/src/types/shopify.js'
import type {
  CheckoutReceipt,
  CheckoutRequest,
  FiscalResendResult,
  OrderRow,
  StaffSummary,
  StaffRole,
  ShiftRow,
  IntegrationProviderName,
  PrinterConfig,
  PrinterType,
  MpesaTransactionRow,
  AppConfigCategory,
  NeedsAttentionRow
} from '../main/services/database.js'
import type { ReceiptPrintResult } from '../main/services/printer.js'
import type { ZReport, DailySummary } from '../main/services/reports.js'
import type { UpdateStatus } from '../main/services/updater.js'
import type { FiscalConnectionTestResult } from '../main/services/integrations/fiscal-connection-test.js'
import type {
  StkPushRequest,
  StkPushResult,
  ManualCodeVerification,
  ManualCodeVerificationResult,
  StkPushStatusResult
} from '../main/services/integrations/mpesa.js'
import type { UnmatchedMpesaPayment } from '../main/services/integrations/sms-mpesa-provider.js'

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
   * @param {CheckoutRequest} request
   * @returns {Promise<ServiceResult<CheckoutReceipt>>}
   */
  checkout: (
    request: CheckoutRequest
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
   * Prints (or, in mock mode, logs) a receipt for a local order.
   *
   * @param {number} localId
   * @param {PrinterType} [printerType] — routes to a registered printer
   *   of this type; defaults to `'receipt'` when omitted.
   * @returns {Promise<ServiceResult<ReceiptPrintResult>>}
   */
  printReceipt: (
    localId: number,
    printerType?: PrinterType
  ): Promise<ServiceResult<ReceiptPrintResult>> =>
    ipcRenderer.invoke('receipt:print', { localId, printerType }),

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
   * Opens a new store-wide till shift with a starting cash float.
   *
   * @param {number} staffId
   * @param {number} startingCash
   * @returns {Promise<ServiceResult<{ shiftId: number }>>}
   */
  openShift: (
    staffId: number,
    startingCash: number
  ): Promise<ServiceResult<{ shiftId: number }>> =>
    ipcRenderer.invoke('shifts:open', { staffId, startingCash }),

  /**
   * Closes the open till shift, reconciling counted cash.
   *
   * @param {number} shiftId
   * @param {number} endingCash
   * @returns {Promise<ServiceResult<{ expectedCash: number; discrepancy: number }>>}
   */
  closeShift: (
    shiftId: number,
    endingCash: number
  ): Promise<ServiceResult<{ expectedCash: number; discrepancy: number }>> =>
    ipcRenderer.invoke('shifts:close', { shiftId, endingCash }),

  /**
   * Generates the Z-report for a shift.
   *
   * @param {number} shiftId
   * @returns {Promise<ServiceResult<ZReport>>}
   */
  getZReport: (shiftId: number): Promise<ServiceResult<ZReport>> =>
    ipcRenderer.invoke('reports:z-report', shiftId),

  /**
   * Generates today's sales summary for the Admin screen.
   *
   * @returns {Promise<ServiceResult<DailySummary>>}
   */
  getDailySummary: (): Promise<ServiceResult<DailySummary>> =>
    ipcRenderer.invoke('reports:daily-summary'),

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
   *
   * @returns {Promise<ServiceResult<{ manualCodeSupported: boolean }>>}
   */
  getMpesaCapabilities: (): Promise<ServiceResult<{ manualCodeSupported: boolean }>> =>
    ipcRenderer.invoke('integrations:mpesa-capabilities'),

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
   * Voids a local `pending_sync` order — reverses inventory and marks
   * it `voided`. Manager PIN authorization happens in the
   * renderer before this is called.
   *
   * @param {number} localId
   * @returns {Promise<ServiceResult<{ localId: number; voidedAt: string }>>}
   */
  voidOrder: (
    localId: number
  ): Promise<ServiceResult<{ localId: number; voidedAt: string }>> =>
    ipcRenderer.invoke('orders:void', localId),

  /**
   * Lists every configured printer (Admin screen
   * Peripherals tab).
   *
   * @returns {Promise<ServiceResult<PrinterConfig[]>>}
   */
  getPrinters: (): Promise<ServiceResult<PrinterConfig[]>> =>
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
   * Sends a test page to a printer interface to verify connectivity —
   * no manager PIN required (read-only diagnostic).
   *
   * @param {string} interfaceName — `tcp://<ip>:<port>`
   * @returns {Promise<ServiceResult<ReceiptPrintResult>>}
   */
  testPrinter: (interfaceName: string): Promise<ServiceResult<ReceiptPrintResult>> =>
    ipcRenderer.invoke('printers:test', { interfaceName }),

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
   * @returns {Promise<ServiceResult<{ shopName: string; locations: { id: string; name: string }[] }>>}
   */
  validateShopifyConfig: (
    storeUrl: string,
    token: string
  ): Promise<ServiceResult<{ shopName: string; locations: { id: string; name: string }[] }>> =>
    ipcRenderer.invoke('config:validate', { storeUrl, token }),

  /**
   * Fetches this till's already-resolved Shopify store URL/token
   * (nothing re-entered) and returns its available locations, for
   * the post-login location-confirmation gate and the Admin screen's
   * "Change Location" control.
   *
   * @returns {Promise<ServiceResult<{ shopName: string; locations: { id: string; name: string }[] }>>}
   */
  listLocations: (): Promise<
    ServiceResult<{ shopName: string; locations: { id: string; name: string }[] }>
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
   * Reads the store name and KRA PIN printed on every receipt.
   *
   * @returns {Promise<ServiceResult<{ storeName: string; storeKraPin: string }>>}
   */
  getStoreIdentity: (): Promise<ServiceResult<{ storeName: string; storeKraPin: string }>> =>
    ipcRenderer.invoke('store:get-identity'),

  /**
   * Saves the store name and KRA PIN printed on every receipt. Requires
   * a re-verified admin Manager PIN.
   *
   * @param {object} identity
   * @param {number} managerId
   * @param {string} managerPin
   * @returns {Promise<ServiceResult<void>>}
   */
  setStoreIdentity: (
    identity: { storeName: string; storeKraPin: string },
    managerId: number,
    managerPin: string
  ): Promise<ServiceResult<void>> =>
    ipcRenderer.invoke('store:set-identity', { ...identity, managerId, managerPin })
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
