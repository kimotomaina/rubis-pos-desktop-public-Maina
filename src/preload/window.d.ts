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

import type { ServiceResult } from '../main/services/shopify-types.js'
import type { FiscalConnectionTestResult } from '../main/services/integrations/fiscal-connection-test.js'
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
import type {
  StkPushRequest,
  StkPushResult,
  ManualCodeVerification,
  ManualCodeVerificationResult,
  StkPushStatusResult
} from '../main/services/integrations/mpesa.js'

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
  /** Lightweight health-check channel, resolves to 'pong'. */
  ping: () => Promise<string>
  /** Application version from the main process. */
  getAppVersion: () => Promise<string>
  /** Opens an external URL in the OS default browser. */
  openExternal: (url: string) => void
  /** Fetches the active Shopify product catalog. */
  fetchProducts: () => Promise<ServiceResult<ProductSummary[]>>
  /** Reads the last cached catalog from SQLite (offline fallback). */
  getCachedProducts: () => Promise<ServiceResult<ProductSummary[]>>
  /** Persists the cart as an order; immediate sync when online. */
  checkout: (
    request: CheckoutRequest
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
  /** The back-office "needs attention" list — every needs_fixing sale plus every stuck-waiting sale. */
  getSalesNeedingAttention: () => Promise<ServiceResult<NeedsAttentionRow[]>>
  /** The Rule-3 safety-net count: every completed-but-unfiled sale, regardless of the stuck threshold. */
  getUnfiledSalesCount: () => Promise<ServiceResult<number>>
  /** Prints (or, in mock mode, logs) a receipt for a local order, optionally routed to a printer type. */
  printReceipt: (
    localId: number,
    printerType?: PrinterType
  ) => Promise<ServiceResult<ReceiptPrintResult>>
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
  /** Reads the currently open till shift, if any. */
  getCurrentShift: () => Promise<ServiceResult<ShiftRow | null>>
  /** Opens a new store-wide till shift with a starting cash float. */
  openShift: (staffId: number, startingCash: number) => Promise<ServiceResult<{ shiftId: number }>>
  /** Closes the open till shift, reconciling counted cash. */
  closeShift: (
    shiftId: number,
    endingCash: number
  ) => Promise<ServiceResult<{ expectedCash: number; discrepancy: number }>>
  /** Generates the Z-report for a shift. */
  getZReport: (shiftId: number) => Promise<ServiceResult<ZReport>>
  /** Generates today's sales summary for the Admin screen. */
  getDailySummary: () => Promise<ServiceResult<DailySummary>>
  /** Triggers an update check against the configured update feed. */
  checkForUpdates: () => Promise<ServiceResult<void>>
  /** Quits and relaunches the app to install a downloaded update. */
  installUpdate: () => Promise<ServiceResult<void>>
  /** Subscribes to auto-update status changes; returns an unsubscribe fn. */
  onUpdateStatus: (callback: (status: UpdateStatus) => void) => () => void
  /** Initiates an M-Pesa STK Push prompt to the customer's phone. */
  initiateMpesaStkPush: (request: StkPushRequest) => Promise<ServiceResult<StkPushResult>>
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
  /** Voids a local `pending_sync` order. */
  voidOrder: (localId: number) => Promise<ServiceResult<{ localId: number; voidedAt: string }>>
  /** Lists every configured printer. */
  getPrinters: () => Promise<ServiceResult<PrinterConfig[]>>
  /** Upserts a printer configuration. Requires a re-verified admin Manager PIN. */
  savePrinter: (
    config: PrinterConfig,
    managerId: number,
    managerPin: string
  ) => Promise<ServiceResult<void>>
  /** Removes a printer configuration. Requires a re-verified admin Manager PIN. */
  deletePrinter: (id: string, managerId: number, managerPin: string) => Promise<ServiceResult<void>>
  /** Sends a test page to a printer interface to verify connectivity. */
  testPrinter: (interfaceName: string) => Promise<ServiceResult<ReceiptPrintResult>>
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
  ) => Promise<ServiceResult<{ shopName: string; locations: { id: string; name: string }[] }>>
  /** Fetches this till's available Shopify locations using its already-resolved store URL/token. */
  listLocations: () => Promise<
    ServiceResult<{ shopName: string; locations: { id: string; name: string }[] }>
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
  /** Reads the store name and KRA PIN printed on every receipt. */
  getStoreIdentity: () => Promise<ServiceResult<{ storeName: string; storeKraPin: string }>>
  /** Saves the store name and KRA PIN printed on every receipt. Requires a re-verified admin Manager PIN. */
  setStoreIdentity: (
    identity: { storeName: string; storeKraPin: string },
    managerId: number,
    managerPin: string
  ) => Promise<ServiceResult<void>>
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
