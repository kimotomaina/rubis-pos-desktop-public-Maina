import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { ServiceResult } from '../main/services/shopify-types.js'
import type { ProductSummary } from '../renderer/src/types/shopify.js'
import type {
  CheckoutReceipt,
  CheckoutRequest,
  OrderRow,
  StaffSummary,
  StaffRole,
  ShiftRow
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
import type { IntegrationProviderName } from '../main/services/database.js'

/** Status payload broadcast over the `network:status` channel. */
export interface NetworkStatusPayload {
  online: boolean
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
   * Prints (or, in mock mode, logs) a receipt for a local order.
   *
   * @param {number} localId
   * @returns {Promise<ServiceResult<ReceiptPrintResult>>}
   */
  printReceipt: (
    localId: number
  ): Promise<ServiceResult<ReceiptPrintResult>> =>
    ipcRenderer.invoke('receipt:print', { localId }),

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
   * admin Manager PIN (Phase 14) — the main process independently
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
   * admin Manager PIN (Phase 14) — the main process independently
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
   * Initiates an M-Pesa STK Push prompt to the customer's phone
   * (Phase 9 placeholder — see docs/phase-9.md §2).
   *
   * @param {StkPushRequest} request
   * @returns {Promise<ServiceResult<StkPushResult>>}
   */
  initiateMpesaStkPush: (
    request: StkPushRequest
  ): Promise<ServiceResult<StkPushResult>> =>
    ipcRenderer.invoke('integrations:mpesa-stk-push', request),

  /**
   * Verifies a manually entered M-Pesa transaction code (Phase 9
   * placeholder — see docs/phase-9.md §2).
   *
   * @param {ManualCodeVerification} request
   * @returns {Promise<ServiceResult<ManualCodeVerificationResult>>}
   */
  verifyMpesaCode: (
    request: ManualCodeVerification
  ): Promise<ServiceResult<ManualCodeVerificationResult>> =>
    ipcRenderer.invoke('integrations:mpesa-verify-code', request),

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
   * re-verified admin Manager PIN (Phase 14) — the main process
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
   * it `voided` (Phase 10). Manager PIN authorization happens in the
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
   * Reports whether a Shopify Admin API token is currently stored in
   * the credential vault — never the token value itself (Phase 12).
   *
   * @returns {Promise<ServiceResult<{ configured: boolean }>>}
   */
  getShopifyTokenStatus: (): Promise<ServiceResult<{ configured: boolean }>> =>
    ipcRenderer.invoke('secrets:get-shopify-token-status'),

  /**
   * Saves the Shopify Admin API token to the credential vault
   * (Phase 12). Write-only — there is no corresponding "get the
   * value" channel.
   *
   * @param {string} token
   * @returns {Promise<ServiceResult<void>>}
   */
  setShopifyToken: (token: string): Promise<ServiceResult<void>> =>
    ipcRenderer.invoke('secrets:set-shopify-token', token)
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
