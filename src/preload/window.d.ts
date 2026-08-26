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
import type { ProductSummary } from '../renderer/src/types/shopify.js'
import type {
  CheckoutReceipt,
  CheckoutRequest,
  OrderRow,
  StaffSummary,
  StaffRole,
  ShiftRow,
  IntegrationProviderName,
  PrinterConfig,
  PrinterType
} from '../main/services/database.js'
import type { ReceiptPrintResult } from '../main/services/printer.js'
import type { ZReport, DailySummary } from '../main/services/reports.js'
import type { UpdateStatus } from '../main/services/updater.js'
import type {
  StkPushRequest,
  StkPushResult,
  ManualCodeVerification,
  ManualCodeVerificationResult
} from '../main/services/integrations/mpesa.js'

/** Payload of the `network:status` broadcast / `network:get-status` invoke. */
export interface NetworkStatusPayload {
  online: boolean
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
  /** Fetches local orders for the order history view. */
  getLocalOrders: (limit?: number, offset?: number) => Promise<ServiceResult<OrderRow[]>>
  /** Retries syncing a failed or pending order. */
  retryOrderSync: (localId: number) => Promise<ServiceResult<{ queueId: number }>>
  /** Prints (or, in mock mode, logs) a receipt for a local order, optionally routed to a printer type (Phase 15). */
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
  /** Creates a new staff account. Requires a re-verified admin Manager PIN (Phase 14). */
  createStaff: (
    name: string,
    pin: string,
    role: StaffRole,
    managerId: number,
    managerPin: string
  ) => Promise<ServiceResult<StaffSummary>>
  /** Resets a staff member's PIN. Requires a re-verified admin Manager PIN (Phase 14). */
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
  /** Reads a provider's stored integration config. */
  getIntegrationConfig: (
    provider: IntegrationProviderName
  ) => Promise<ServiceResult<Record<string, unknown>>>
  /** Saves a provider's integration config. Requires a re-verified admin Manager PIN (Phase 14). */
  setIntegrationConfig: (
    provider: IntegrationProviderName,
    config: Record<string, unknown>,
    managerId: number,
    managerPin: string
  ) => Promise<ServiceResult<void>>
  /** Voids a local `pending_sync` order. */
  voidOrder: (localId: number) => Promise<ServiceResult<{ localId: number; voidedAt: string }>>
  /** Lists every configured printer (Phase 15). */
  getPrinters: () => Promise<ServiceResult<PrinterConfig[]>>
  /** Upserts a printer configuration. Requires a re-verified admin Manager PIN (Phase 15). */
  savePrinter: (
    config: PrinterConfig,
    managerId: number,
    managerPin: string
  ) => Promise<ServiceResult<void>>
  /** Removes a printer configuration. Requires a re-verified admin Manager PIN (Phase 15). */
  deletePrinter: (id: string, managerId: number, managerPin: string) => Promise<ServiceResult<void>>
  /** Sends a test page to a printer interface to verify connectivity (Phase 15). */
  testPrinter: (interfaceName: string) => Promise<ServiceResult<ReceiptPrintResult>>
  /** Reports whether a Shopify Admin API token is stored in the credential vault. */
  getShopifyTokenStatus: () => Promise<ServiceResult<{ configured: boolean }>>
  /** Saves the Shopify Admin API token to the credential vault. */
  setShopifyToken: (token: string) => Promise<ServiceResult<void>>
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
