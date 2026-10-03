import { app, BrowserWindow, Menu, shell, ipcMain, net, powerMonitor, dialog, session } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { appendFileSync, chmodSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { config as loadEnvFile } from 'dotenv'
import electronUpdater from 'electron-updater'

/**
 * Must be set before `app` is ready — Chromium reads this switch at
 * startup to correctly scale the window/UI on a high-DPI Windows
 * display (a common till setup) instead of rendering blurry or at the
 * wrong physical size. Harmless on displays running at 100% scaling.
 */
app.commandLine.appendSwitch('high-dpi-support', '1')

/**
 * `VITE_*` credentials (store URL, admin token, printer IP, etc.) are
 * per-till runtime config, not build-time constants — so they're loaded
 * from a `.env` file at startup rather than statically inlined. In dev,
 * `electron-vite dev` already injects `.env` into `process.env` for the
 * spawned Electron process; in a packaged build nothing does that, so the
 * resources-directory copy (see electron-builder's `extraResources`) is
 * loaded explicitly here.
 */
loadEnvFile({
  path: app.isPackaged ? join(process.resourcesPath, '.env') : undefined
})

/**
 * `electron-updater` ships as CommonJS; under `"type": "module"` its named
 * exports aren't statically available, so the default export is
 * destructured here instead.
 */
const { autoUpdater } = electronUpdater
import { electronApp, optimizer } from '@electron-toolkit/utils'
import {
  createBrowserWindowConfig,
  resolveLoadTarget,
  buildCspHeaders,
  buildDevContentSecurityPolicy
} from './window-factory.js'
import { applyAutoZoom } from './lib/scale.js'
import {
  resolveCheckFitForcedScreen,
  resolveCheckFitSendingDisabled,
  guardCheckFitSending,
  shouldStartBackgroundSenders
} from './lib/checkFit.js'
import { initAutoUpdater, checkForUpdates } from './services/updater.js'
import type { UpdateStatus } from './services/updater.js'
import { installUpdate, runPostUpdateCheck } from './services/updateBackup.js'
import type { LastUpdateResult } from './services/updateBackup.js'
import { createFileErrorLogger, installGlobalErrorHandlers } from './services/errorHandler.js'
import {
  fetchAllProducts,
  createShopifyClient,
  fetchInventoryLevelDetails,
  resolveShopifyStoreUrl,
  validateAndFetchLocations
} from './services/shopify.js'
import type { InventoryLevelDetail } from './services/shopify.js'
import { pushInventoryAdjustment } from './services/inventory-adjust.js'
import {
  abandonStockTake,
  commitStockTake,
  openStockTake,
  previewCommit,
  readSession,
  recordCount,
  removeCount,
  resolveStockTakeSettings,
  saveStockTakeSettings,
  submitForApproval
} from './services/stock-take.js'
import type {
  StockTakeCommitSummary,
  StockTakeDeps,
  StockTakePreview,
  StockTakeSessionView,
  StockTakeSettings
} from './services/stock-take.js'
import { createDatabase, STUCK_WAITING_THRESHOLD_MS } from './services/database.js'
import { migrateEnvConfigToDatabase } from './services/configMigration.js'
import { DEMO_PRODUCTS } from './services/demoData.js'
import type {
  CardApproval,
  CheckoutReceipt,
  DiscardedHeldSale,
  FiscalResendResult,
  HeldSaleSummary,
  ManualMpesaApproval,
  MpesaPaymentRow,
  StaffSummary,
  ShiftRow,
  OrderRow
} from './services/database.js'
import {
  MPESA_NOT_CONFIGURED_MESSAGE,
  resolveMpesaProvider,
  type MpesaConfirmationMethod
} from './services/mpesa-provider-factory.js'
import {
  SmsMpesaProvider,
  toUnmatchedPayments,
  type UnmatchedMpesaPayment
} from './services/integrations/sms-mpesa-provider.js'
import { createMpesaSmsInbox, describeInboxHealth } from './services/mpesa-sms-inbox.js'
import { MPESA_SMS_PARSER_READY, parseMpesaPaymentSms } from './lib/mpesaSms.js'
import type {
  StkPushRequest,
  StkPushResult,
  ManualCodeVerification,
  ManualCodeVerificationResult,
  StkPushStatusResult
} from './services/integrations/mpesa.js'
import { DarajaMpesaProvider } from './services/integrations/daraja-mpesa-provider.js'
import type { FiscalizationProvider } from './services/integrations/etims.js'
import { RealFiscalizationProvider } from './services/integrations/real-etims-provider.js'
import type { FiscalConnectionTestResult } from './services/integrations/fiscal-connection-test.js'
import { toConnectivityCheckResult } from './services/integrations/fiscal-connection-test.js'
import { resolveFiscalizationProvider } from './services/fiscal-provider-factory.js'
import { DEFAULT_ETIMS_BASE_URL } from './services/integrations/http-client.js'
import {
  resolveEtimsDevicePassword,
  redactIntegrationConfig
} from './services/etimsCredentials.js'
import {
  createConnectivityMonitor,
  checkHttpReachable,
  checkTcpReachable,
  checkMpesaConnectivity,
  mockConnectedResult,
  mockDisconnectedResult
} from './services/connectivityMonitor.js'
import type { FiscalEndpointPaths } from './services/integrations/real-etims-provider.js'
import { VOID_DISABLED_MESSAGE } from './services/voids.js'
import {
  validate,
  checkoutRequestSchema,
  loginRequestSchema,
  staffCreateSchema,
  staffResetPinSchema,
  integrationsSetConfigSchema,
  printerSaveSchema,
  printerDeleteSchema,
  printerTestSchema,
  shopifySetStoreUrlSchema,
  configValidateSchema,
  configSaveSchema,
  configClearSchema,
  locationSetSchema,
  mpesaLogTransactionSchema,
  mpesaQueryStatusSchema,
  configSetSchema,
  mpesaCredentialsSetSchema,
  etimsConfigSaveSchema,
  mpesaIntegrationConfigSchema,
  etimsPasswordSetSchema,
  etimsIntegrationConfigSchema,
  storeIdentitySetSchema,
  correctPinAndResendSchema,
  resendFiscalizationSchema,
  printFiscalDuplicateSchema,
  saveCartDraftSchema,
  holdSaleSchema,
  heldSaleIdSchema,
  renameHeldSaleSchema,
  discardHeldSaleSchema,
  discardedHeldSalesSchema,
  recordCartRemovalsSchema,
  reconcileMpesaPaymentSchema,
  endOfDayReportSchema,
  approveDayReportSchema,
  stockTakeOpenSchema,
  stockTakeSessionIdSchema,
  stockTakeCountSchema,
  stockTakeRemoveSchema,
  stockTakeAbandonSchema,
  stockTakeCommitSchema,
  stockTakeSettingsSchema,
  zReportRequestSchema,
  receiptPrintRequestSchema,
  shiftsListSchema,
  shiftOpenSchema,
  shiftCloseSchema,
  salesSummarySchema,
  fiscalByDaySchema,
  invoiceListSchema,
  fiscalReconciliationSchema,
  exportCsvSchema
} from './lib/ipcValidator.js'
import { checkEtimsCompletion } from './services/etimsSetup.js'
import type { EtimsCompletionStatus } from './services/etimsSetup.js'
import { requireAdminPin } from './lib/requireAdminPin.js'
import { restrictToOwnerOnly } from './lib/fileSecurity.js'
import {
  loadSecretVault,
  resolveShopifyToken,
  setSecret,
  getSecret,
  deleteSecret,
  SECRET_SERVICE_NAME,
  SHOPIFY_TOKEN_ACCOUNT,
  ETIMS_DEVICE_PASSWORD_ACCOUNT
} from './services/secretStore.js'
import type {
  IntegrationProviderName,
  MpesaTransactionRow,
  AppConfigCategory,
  NeedsAttentionRow,
  PrinterType,
  UnprintedFiscalSlipRow,
  ApproveMpesaEntriesResult
} from './services/database.js'
import { createSyncEngine } from './services/sync-engine.js'
import { createReconciliationRunner } from './services/reconciliation.js'
import type { ReconciliationResult } from './services/reconciliation.js'
import { createFiscalEngine } from './services/fiscal-engine.js'
import { runCheckout } from './services/checkout.js'
import { closeShiftUnlessHeld, discardHeldSaleApproved, holdCart } from './services/held-sales.js'
import {
  correctPinAndResend,
  buildFiscalResendResult,
  resendFiscalization
} from './services/fiscal-retry.js'
import { printFiscalDuplicate } from './services/fiscal-duplicate-print.js'
import { recordApprovedRemovals } from './services/cart-removals.js'
import { createCartFlushCoordinator } from './services/cart-flush.js'
import { printLateFiledSlip as printLateFiledSlipFor } from './services/late-filed-slip.js'
import { recordSlipOutcome, slipStamps } from './services/slip-records.js'
import { findVatMismatches } from './services/vat-reconcile.js'
import type { VatMismatchRow } from './services/vat-reconcile.js'
import { createNetworkMonitor } from './services/network.js'
import { pushOrderToShopify } from './services/orders.js'
import {
  printOrderSlips,
  attachCustomerSlipResult,
  printZReport,
  printTestPage,
  printWindowsTestPage,
  buildPrinterRegistry,
  shouldShowFiscalPendingSlip,
  shouldOpenPdfFallbackViewer
} from './services/printer.js'
import type {
  PrinterSettings,
  ReceiptPrintResult,
  PrinterRegistry,
  OrderSlipSelection,
  OrderSlipsResult,
  ReceiptLayoutVatGroups
} from './services/printer.js'
import { toWindowsPrinterInfo, markMissingWindowsPrinters } from './services/windowsPrinter.js'
import type { WindowsPrinterInfo, PrinterWithAvailability } from './services/windowsPrinter.js'
import { hashPin, authenticateStaff } from './services/auth.js'
import {
  generateZReport,
  generateDailySummary,
  generateEndOfDayReport,
  generateSalesSummary,
  generateFiscalStatusByDay,
  generateFiscalReconciliation,
  getReportRange,
  getLocalDayRange,
  localDayOf,
  todayLocalDay
} from './services/reports.js'
import type {
  ZReport,
  DailySummary,
  EndOfDayReport,
  SalesSummary,
  FiscalStatusDayCount,
  FiscalReconciliationReport
} from './services/reports.js'
import { buildOrdersCsv, buildLinesCsv } from './services/reportsExport.js'
import { resolveTraderSystemInvNum } from './lib/traderSystemInvoiceNumber.js'
import { shouldRefuseCheckoutForDiscount } from './lib/requestHasDiscount.js'
import { resolveCheckoutLocation, NO_LOCATION_MESSAGE } from './lib/checkoutLocation.js'
import { resolveVatClass } from './lib/vatClass.js'

/** One invoice-list row (docs/phase-158): an order plus its pre-computed trader invoice number. */
interface InvoiceListRow {
  order: OrderRow
  traderInvoiceNumber: string
}
import type { OfflineOrderPayload, ServiceResult } from './services/shopify-types.js'
import type { ProductSummary } from '../renderer/src/types/shopify.js'

/** PIN for the default admin account seeded on first run — change after setup. */
const DEFAULT_ADMIN_PIN = '1234'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * Absolute paths used throughout the main-process lifecycle.
 */
const PRELOAD_PATH = join(__dirname, '../preload/index.js')
const RENDERER_HTML = join(__dirname, '../renderer/index.html')
/**
 * Window/taskbar icon. In dev this resolves against the project root
 * (`out/main` → `../../resources`); in a packaged build it comes from
 * the `resources/icons` copy declared via electron-builder's
 * `extraResources` (see electron-builder.yml) — the same pattern used
 * for `.env` above.
 */
const ICON_PATH = app.isPackaged
  ? join(process.resourcesPath, 'icons', 'icon.ico')
  : join(__dirname, '../../resources/icons/icon.ico')

/**
 * Parses `RUBIS_CHECK_FIT_SIZE` (e.g. `"911x512"`) for `scripts/check-
 * fit.mjs` — Electron's CDP implementation has no `Browser.setWindowBounds`
 * (confirmed while building that script: the method doesn't exist on a
 * desktop `BrowserWindow`, only in headless Chrome), so the only way to
 * drive the window to each of the 9 supported-display cases is to set its
 * initial content size at launch and relaunch per case, rather than
 * resize one running instance. Absent or malformed, this is a no-op and
 * the window maximizes exactly as it always has — no real launch ever
 * sets this variable.
 *
 * @param {string | undefined} raw
 * @returns {{ width: number; height: number } | null}
 */
function parseCheckFitSize(raw: string | undefined): { width: number; height: number } | null {
  if (!raw) return null
  const match = /^(\d+)x(\d+)$/.exec(raw.trim())
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return { width, height }
}

/**
 * Creates and configures the main BrowserWindow.
 *
 * Security posture (see window-factory.createBrowserWindowConfig):
 *   contextIsolation, sandbox, webSecurity enabled;
 *   nodeIntegration disabled.
 *
 * Loads the Vite dev-server URL when `app.isPackaged` is false and the
 * URL env var is present, otherwise falls back to the bundled HTML file.
 *
 * @returns {BrowserWindow} the configured window instance
 */
function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow(
    createBrowserWindowConfig({
      isDev: !app.isPackaged,
      preloadPath: PRELOAD_PATH,
      rendererHtmlPath: RENDERER_HTML,
      iconPath: ICON_PATH,
      devServerUrl: process.env['ELECTRON_RENDERER_URL']
    })
  )

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    const testSize = parseCheckFitSize(process.env['RUBIS_CHECK_FIT_SIZE'])
    if (testSize) {
      mainWindow.setContentSize(testSize.width, testSize.height)
    } else {
      mainWindow.maximize()
    }
  })

  /**
   * Whole-window scaling (Phase E, `lib/scale.ts`) — makes every screen
   * fit the window with no scrolling by zooming the page to the window's
   * real size, the same idea Windows' own display scaling uses. Wired
   * here rather than left at Chromium's default zoom of 1.
   *
   * The adapter below exists only because `BrowserWindow.on` is
   * overloaded per event name with no single signature spanning all
   * five triggers — `applyAutoZoom` takes named hooks instead (see its
   * doc comment) so it stays testable without a real `BrowserWindow`.
   */
  applyAutoZoom({
    getContentBounds: () => mainWindow.getContentBounds(),
    setZoomFactor: (factor) => mainWindow.webContents.setZoomFactor(factor),
    onReadyToShow: (listener) => mainWindow.on('ready-to-show', listener),
    onResize: (listener) => mainWindow.on('resize', listener),
    onMove: (listener) => mainWindow.on('move', listener),
    onDidFinishLoad: (listener) => mainWindow.webContents.on('did-finish-load', listener),
    onZoomChanged: (listener) => mainWindow.webContents.on('zoom-changed', listener)
  })

  /**
   * Disables pinch-to-zoom/Ctrl+scroll page zoom — the only zoom this
   * till ever shows is the one `applyAutoZoom` computes from the window
   * size, never one a gesture or a scroll wheel introduced.
   */
  mainWindow.webContents.setVisualZoomLevelLimits(1, 1)

  /**
   * F11 toggles real OS-level fullscreen (hides the title bar entirely) —
   * in addition to the native maximize/restore button, which only
   * maximizes within the taskbar area. Bound here rather than via an
   * application menu accelerator since the menu bar is auto-hidden.
   */
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      mainWindow.setFullScreen(!mainWindow.isFullScreen())
    }
  })

  /**
   * Prevent the renderer from opening new windows.  External links are
   * routed through the OS default browser via shell.openExternal.
   */
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  /**
   * Belt-and-braces devtools lockdown for packaged builds — closes any
   * devtools window opened via a route other than the dev-only F12
   * shortcut gated below (e.g. a stray menu item).
   */
  mainWindow.webContents.on('devtools-opened', () => {
    if (app.isPackaged) mainWindow.webContents.closeDevTools()
  })

  const target = resolveLoadTarget({
    isDev: !app.isPackaged,
    preloadPath: PRELOAD_PATH,
    rendererHtmlPath: RENDERER_HTML,
    devServerUrl: process.env['ELECTRON_RENDERER_URL']
  })

  if (target.type === 'url') {
    void mainWindow.loadURL(target.url)
  } else {
    void mainWindow.loadFile(target.path)
  }

  return mainWindow
}

/* ── App lifecycle ────────────────────────────────────────── */

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.volcha.rubispos')

  /**
   * No application menu at all — not `autoHideMenuBar` alone, which only
   * hides the bar; Electron's default menu still exists underneath it
   * and still registers Ctrl+Plus/Ctrl+Minus/Ctrl+0 as zoom accelerators
   * regardless of whether the bar is shown. This till has exactly one
   * correct zoom, computed from the window size by `applyAutoZoom`
   * (`lib/scale.ts`) — a menu-driven or keyboard-driven zoom change
   * would silently break the "everything fits, nothing scrolls"
   * guarantee the rest of Phase E is built on.
   */
  Menu.setApplicationMenu(null)

  /**
   * Strict Content-Security-Policy: enforced at the
   * session level so it applies to every response the app loads, not just
   * the initial document — belt-and-braces alongside the BrowserWindow's
   * `webSecurity`/`sandbox` config in `window-factory.ts`.
   *
   * In dev (`electron-vite dev`, unpackaged, `ELECTRON_RENDERER_URL` set),
   * the relaxed {@link buildDevContentSecurityPolicy} is used instead —
   * required for `@vitejs/plugin-react`'s inline Fast Refresh preamble
   * script and the dev server's own origin/WS socket. A packaged build
   * never sets `ELECTRON_RENDERER_URL`, so this always resolves to the
   * strict policy in production.
   */
  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  const cspPolicy =
    !app.isPackaged && devServerUrl ? buildDevContentSecurityPolicy(devServerUrl) : undefined
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        ...buildCspHeaders(cspPolicy)
      }
    })
  })

  /**
   * F12/reload shortcuts are dev-only — a packaged build never binds
   * them, closing off another route to devtools on the store floor.
   */
  app.on('browser-window-created', (_, window) => {
    if (!app.isPackaged) optimizer.watchWindowShortcuts(window)
  })

  /**
   * Global crash safety net: logs uncaught errors, unhandled
   * rejections, and renderer crashes to `userData/error.log`, then shows
   * a friendly restart prompt instead of a white screen or silent death.
   */
  installGlobalErrorHandlers({
    process,
    app,
    logger: createFileErrorLogger(join(app.getPath('userData'), 'error.log'), {
      appendFileSync
    }),
    showFatalDialog: (message) => dialog.showErrorBox('RUBIS POS', message)
  })

  /* ── Core services: SQLite, sync engine, connectivity ───── */

  const dbPath = join(app.getPath('userData'), 'rubis-pos.db')
  const db = createDatabase({ dbPath })
  db.init()

  /**
   * Resolves whatever `pendingUpdateCheck` a prior `updater:install` left
   * behind, before the window shows — so Admin > App & Updates can show
   * the result on the very first open after an update (docs/phase-178).
   * A no-op on every launch that didn't just install an update.
   */
  runPostUpdateCheck({ db, installedVersion: app.getVersion() })

  /**
   * Rule 3 (docs/phase-185.md §4.2): a sale stopped mid-filing by an
   * older build has `fiscal_status` NULL and no fiscal row, so nothing
   * would ever retry or count it. The sweep only flags them for a person
   * (nothing is filed), and is a no-op once nothing is NULL.
   */
  const swept = db.sweepUnqueuedFiscalOrders()
  if (swept.resendable > 0 || swept.unsendable > 0) {
    console.warn(
      `[rubis-pos] Start-up sweep: ${swept.resendable} interrupted sale(s) flagged for a check before resending, ${swept.unsendable} flagged for support`
    )
  }

  /**
   * docs/phase-212: once, after migrations and before any sale or engine can run, corrects sales an
   * older build recorded as filed from the device's all-zero "no invoice" counter. Writes nothing to
   * the device; the sales go to Needs Attention.
   */
  const repaired = db.repairFalselyFiledOrders()
  if (repaired.ran) {
    console.log(
      `[rubis-pos] Start-up repair (phase 212): ${repaired.localIds.length} sale(s) recorded as filed in error were moved to Needs Attention` +
        (repaired.localIds.length > 0 ? ` (local ids ${repaired.localIds.join(', ')})` : '')
    )
  }

  /**
   * docs/phase-169-1 commit A: `scripts/check-fit.mjs` sets
   * `RUBIS_CHECK_FIT` on every one of its throwaway launches. When set,
   * nothing real may ever be sent — no Shopify push, no fiscal device
   * command, no M-Pesa STK push, no non-mock print — regardless of what
   * the copied database/vault happen to contain. Never set on a real
   * launch (mirrors `RUBIS_CHECK_FIT_SIZE`/`RUBIS_CHECK_FIT_SCREEN`
   * above). Read once, here, before anything that could send is built.
   */
  const checkFitSendingDisabled = resolveCheckFitSendingDisabled(process.env['RUBIS_CHECK_FIT'])
  if (checkFitSendingDisabled) {
    console.log('[rubis-pos] check:fit mode: all sending disabled.')
  }

  /**
   * One-time seed of the M-Pesa/eTIMS mock-vs-real toggles from
   * `.env` into `app_configurations`, so an install with no `.env`
   * file (and no prior Admin-screen edit) still has a starting value
   * — see `configMigration.ts`. Safe to call on every launch: it's a
   * no-op once the migration has run.
   */
  migrateEnvConfigToDatabase(db, {
    VITE_USE_MOCK_MPESA: process.env.VITE_USE_MOCK_MPESA,
    VITE_USE_MOCK_ETIMS: process.env.VITE_USE_MOCK_ETIMS
  })

  /**
   * Restricts the SQLite file to owner-only access.
   * `userData` is already scoped to the current Windows user profile;
   * this is a second, explicit layer on top of that. Non-fatal on
   * failure (see `fileSecurity.ts`) — a permissions quirk must never
   * block the till from starting.
   */
  restrictToOwnerOnly(chmodSync, dbPath)

  /**
   * Seeds a default admin account on first run so the login screen is
   * never a dead end. PIN is `DEFAULT_ADMIN_PIN` — change it after setup.
   */
  if (db.countStaff() === 0) {
    db.createStaff({ name: 'Admin', pinHash: hashPin(DEFAULT_ADMIN_PIN), role: 'admin' })
    console.warn(
      `[rubis-pos] No staff accounts found; seeded default admin account (PIN ${DEFAULT_ADMIN_PIN}) — change it after setup.`
    )
  }

  /**
   * Demo Mode: when `VITE_DEMO_MODE=true`, the
   * local catalog is seeded from a hardcoded dummy product list
   * instead of the live Shopify API — so a trial terminal looks fully
   * populated and is scannable even with no internet or Shopify
   * credentials configured. `products:fetch` below short-circuits to
   * this same cached data rather than attempting a live fetch.
   */
  const demoMode = process.env.VITE_DEMO_MODE === 'true'
  if (demoMode) {
    db.cacheProducts(DEMO_PRODUCTS)
    console.warn('[rubis-pos] Demo Mode active — seeded 10 dummy products, skipping live Shopify fetch.')
  }

  /**
   * Secure secret storage (see `secretStore.ts`): the
   * Shopify Admin API token is resolved from the OS-encrypted vault,
   * never read from `process.env` directly once resolved. A missing
   * vault entry falls back to `.env` once — packaged or not — and is
   * persisted into the vault so every later launch is vault-only.
   * Cached in a mutable binding so `secrets:set-shopify-token` and the
   * onboarding wizard's `config:save` (below) can update it
   * mid-session without a restart.
   */
  const keytar = await loadSecretVault()
  let shopifyToken = (
    await resolveShopifyToken({
      keytar,
      envToken: process.env.VITE_SHOPIFY_ADMIN_API_TOKEN
    })
  ).token

  /** `settings` table key the Shopify store URL is persisted under. */
  const SHOPIFY_STORE_URL_SETTING_KEY = 'shopify_store_url'

  /** `settings` table key for the store name printed on every receipt. */
  const STORE_NAME_SETTING_KEY = 'store_name'

  /** `settings` table key for the store's own KRA PIN, printed on every receipt. */
  const STORE_KRA_PIN_SETTING_KEY = 'store_kra_pin'

  /** `settings` table key for the registered company (legal) name, printed on the receipt header (docs/phase-171). */
  const STORE_LEGAL_NAME_SETTING_KEY = 'store_legal_name'

  /** `settings` table key for the branch/shop name and street address, one line (docs/phase-171). */
  const STORE_ADDRESS_SETTING_KEY = 'store_address'

  /** `settings` table key for the phone number, printed as "Tel <phone>" (docs/phase-171). */
  const STORE_PHONE_SETTING_KEY = 'store_phone'

  /** `settings` table key for the receipt footer message (docs/phase-171). */
  const STORE_FOOTER_MESSAGE_SETTING_KEY = 'store_footer_message'

  /**
   * Store URL, not a secret (a public shop domain) so it lives in the
   * plain `settings` table rather than the encrypted vault — resolved
   * `.env` first, then whatever was last saved from the Admin screen
   * (`resolveShopifyStoreUrl`), so a fresh install never
   * *requires* a `.env` file to be configured. Cached in a mutable
   * binding so `shopify:set-store-url` (below) can update it
   * mid-session without a restart, matching `shopifyToken` above.
   */
  let shopifyStoreUrl = resolveShopifyStoreUrl(
    process.env.VITE_SHOPIFY_STORE_URL,
    db.getSetting(SHOPIFY_STORE_URL_SETTING_KEY)
  )

  /**
   * Builds a Shopify client from the resolved store URL + vault-backed
   * token; returns null when either is missing.
   */
  const shopifyEnv = () => {
    const storeUrl = shopifyStoreUrl
    const token = shopifyToken
    return storeUrl && token ? { storeUrl, token } : null
  }

  /**
   * Resolves the Shopify location ID for inventory scoping, and
   * whether an admin has explicitly confirmed it. Priority: env var
   * (an explicit deployment-time choice, always confirmed) → settings
   * table (confirmed only if `location_confirmed` was set by an
   * admin via `location:set`/`config:save` — a bare `location_id`
   * from a stale install is NOT treated as confirmed). Never
   * auto-detects or silently persists a location at boot — that used
   * to happen here and let a till start selling against whichever
   * location Shopify returned first with no admin ever confirming
   * it; candidate locations are now only fetched on demand via the
   * `location:list` IPC channel for the renderer's confirmation gate.
   */
  let locationId = process.env.VITE_SHOPIFY_LOCATION_ID
  let locationConfirmed = false
  let locationName: string | undefined
  if (locationId) {
    locationConfirmed = true
    // The env var only gives us an id, not a display name. Resolve one
    // in the background purely for the Admin/gate screens to show —
    // this never affects `locationConfirmed`, which is already true
    // because of the explicit env var override.
    const env = shopifyEnv()
    if (env) {
      const boundLocationId = locationId
      validateAndFetchLocations(env.storeUrl, env.token)
        .then((result) => {
          if (result.success && result.data) {
            const match = result.data.locations.find((l) => l.id === boundLocationId)
            if (match) {
              locationName = match.name
              db.setSetting('location_name', match.name)
            }
          }
        })
        .catch(() => {
          console.warn('[rubis-pos] Could not resolve a display name for VITE_SHOPIFY_LOCATION_ID')
        })
    }
  } else {
    locationId = db.getSetting('location_id') ?? undefined
    locationConfirmed = db.getSetting('location_confirmed') === '1'
    locationName = db.getSetting('location_name') ?? undefined
  }

  /**
   * Thermal printer configuration, resolved once from the environment.
   * `VITE_MOCK_PRINTER=true` skips hardware entirely (demo mode).
   */
  const printerSettings: PrinterSettings = {
    interfaceName: process.env.VITE_PRINTER_INTERFACE || 'tcp://192.168.0.100:9100',
    /**
     * Admin-set (Integrations tab) so a branch can correct its own
     * receipt header without a rebuild. `VITE_STORE_NAME` remains a
     * fallback for an install that predates the setting.
     */
    storeName: db.getSetting(STORE_NAME_SETTING_KEY) || process.env.VITE_STORE_NAME || 'RUBIS',
    storeKraPin: db.getSetting(STORE_KRA_PIN_SETTING_KEY) || undefined,
    legalName: db.getSetting(STORE_LEGAL_NAME_SETTING_KEY) || undefined,
    address: db.getSetting(STORE_ADDRESS_SETTING_KEY) || undefined,
    phone: db.getSetting(STORE_PHONE_SETTING_KEY) || undefined,
    footerMessage: db.getSetting(STORE_FOOTER_MESSAGE_SETTING_KEY) || undefined,
    taxRate: Number(process.env.VITE_TAX_RATE) || 0,
    mock: process.env.VITE_MOCK_PRINTER === 'true'
  }

  /**
   * Multi-printer registry:
   * additional printers (e.g. a kitchen or label printer) registered
   * from the Admin screen's Peripherals tab, keyed by id. Rebuilt after
   * every `printers:save`/`printers:delete` so a lookup never reads a
   * stale in-memory copy. A store with no rows in the `printers` table
   * resolves every `printerType` lookup back to `printerSettings` above
   * — see `printer.ts`'s `resolvePrinterSettings`.
   */
  let printerRegistry: PrinterRegistry = buildPrinterRegistry(db.getPrinters())

  /**
   * M-Pesa / eTIMS integrations. Each has its own mock/real switch —
   * `VITE_USE_MOCK_MPESA` and `VITE_USE_MOCK_ETIMS` — rather than one
   * blanket flag, since a till may want a real fiscal device wired up
   * while M-Pesa is still mocked, or vice versa.
   *
   * **The two switches default differently.** M-Pesa defaults to mock
   * when unset, so a fresh checkout never charges a real customer by
   * accident. eTIMS defaults to **real**: a mocked fiscalization mints a
   * synthetic invoice number that would print on a receipt as though the
   * sale had been filed with KRA, so "no configuration" must never mean
   * "silently mock" (Rule 2). `resolveFiscalizationProvider` enforces the
   * stronger half of that — a packaged build cannot select the mock at
   * all, and does not contain it.
   *
   * `mockMpesaEnabled` selects between `MockMpesaProvider` and a real
   * `DarajaMpesaProvider` talking to Safaricom's Daraja API (credentials
   * come from the `integrations` table, falling back to `MPESA_*` env
   * vars) — with mocking off, checkout's manual-code verification also
   * switches from the mock's sentinel logic to
   * `DarajaMpesaProvider.verifyTransactionCode`, which reports that path
   * unsupported (Daraja has no code-lookup endpoint).
   *
   * Either way, a fiscalization failure — including the device being
   * unreachable or rejecting the TCP password — is queued in `sync_queue`
   * for retry rather than blocking the sale (see the `orders:checkout`
   * handler below), so the till stays usable and queued invoices heal
   * themselves once the device comes back.
   */
  /** Vault account names for the two secret-bearing Daraja fields, mirroring `SHOPIFY_TOKEN_ACCOUNT`'s pattern. */
  const MPESA_CONSUMER_SECRET_ACCOUNT = 'mpesa-consumer-secret'
  const MPESA_PASSKEY_ACCOUNT = 'mpesa-passkey'

  /**
   * Off by default (phase-80): a normal sale logs only its fiscal
   * outcome, not the wire-level XML/HTTP trace or per-step progress.
   * Flip on to get that trace back when diagnosing a live device issue,
   * without a code change.
   */
  const fiscalDebugLogging = (process.env.FISCAL_DEBUG_LOGGING || '').trim().toLowerCase() === 'true'

  /**
   * M-Pesa defaults to REAL when unset, for the same reason eTIMS does
   * below. The mock's `verifyTransactionCode` approves almost any code,
   * so a till installed without a `.env` used to complete M-Pesa sales
   * for payments that never happened — the payment-side twin of printing
   * `KRA-MOCK-` on a receipt for an unfiled sale. `resolveMpesaProvider`
   * refuses the mock in a packaged build regardless of what this
   * resolves to, and `scripts/verify-no-mock-provider.cjs` fails the
   * build if the mock is in the bundle at all.
   */
  const rawMockMpesa = (process.env.VITE_USE_MOCK_MPESA || 'false').trim().toLowerCase()
  /**
   * eTIMS defaults to REAL when unset, unlike M-Pesa. A till installed
   * without a `.env` must not quietly fiscalize against the mock and
   * print `KRA-MOCK-` invoice numbers on receipts for sales that were
   * never filed (Rule 2). `resolveFiscalizationProvider` refuses the
   * mock in a packaged build regardless of what this resolves to.
   */
  const rawMockEtims = (process.env.VITE_USE_MOCK_ETIMS || 'false').trim().toLowerCase()
  const mockMpesaEnabled =
    (db.getConfig('mock_mpesa_enabled') ?? (rawMockMpesa === 'true' ? 'true' : 'false')) === 'true'
  const mockEtimsEnabled =
    (db.getConfig('mock_etims_enabled') ?? (rawMockEtims === 'true' ? 'true' : 'false')) === 'true'
  console.log(
    `[DEBUG-ETIMS] Startup: raw VITE_USE_MOCK_MPESA="${rawMockMpesa}", raw VITE_USE_MOCK_ETIMS="${rawMockEtims}", ` +
      `db mock_mpesa_enabled=${JSON.stringify(db.getConfig('mock_mpesa_enabled'))}, db mock_etims_enabled=${JSON.stringify(db.getConfig('mock_etims_enabled'))}, ` +
      `resolved mockMpesaEnabled=${mockMpesaEnabled}, resolved mockEtimsEnabled=${mockEtimsEnabled}`
  )
  const mpesaConfig = db.getIntegrationConfig<{
    consumerKey?: string
    shortcode?: string
    environment?: 'sandbox' | 'production'
    callbackUrl?: string
    confirmationMethod?: MpesaConfirmationMethod
    smsInboxPath?: string
    manualEntryEnabled?: boolean
  }>('mpesa')
  /**
   * How this till confirms an M-Pesa payment. Defaults to `'manual'`
   * (docs/phase-148.md step 2 — the client's POC default). A row that
   * explicitly holds `'daraja'` or `'sms'` from before this default
   * existed keeps it; only a row with neither becomes manual.
   */
  const mpesaConfirmationMethod: MpesaConfirmationMethod =
    mpesaConfig.confirmationMethod === 'sms'
      ? 'sms'
      : mpesaConfig.confirmationMethod === 'daraja'
        ? 'daraja'
        : 'manual'
  /**
   * Sandbox vs production, resolved once here so both the real Daraja
   * client and the connectivity probe below check the same host this
   * till is actually configured to call — the probe used to be
   * hardcoded to sandbox regardless of this setting (phase-147 Part 6 #1).
   */
  const mpesaEnvironment: 'sandbox' | 'production' =
    mpesaConfig.environment ??
    (process.env.MPESA_ENVIRONMENT === 'production' ? 'production' : 'sandbox')
  /**
   * `consumerSecret`/`passkey` are the two Daraja fields that can
   * actually authorize a transaction, so — unlike `consumerKey`/
   * `shortcode`/`environment`/`callbackUrl`, which live in the
   * plaintext `integrations` table alongside eTIMS's config — they're
   * resolved from the OS-encrypted vault (`secretStore.ts`), the same
   * mechanism the Shopify Admin API token already uses. `.env`'s
   * `MPESA_CONSUMER_SECRET`/`MPESA_PASSKEY` remain a fallback for an
   * install that hasn't set them via the Admin screen yet.
   */
  const mpesaConsumerSecret =
    (await getSecret(keytar, SECRET_SERVICE_NAME, MPESA_CONSUMER_SECRET_ACCOUNT)) ??
    process.env.MPESA_CONSUMER_SECRET ??
    ''
  const mpesaPasskey =
    (await getSecret(keytar, SECRET_SERVICE_NAME, MPESA_PASSKEY_ACCOUNT)) ??
    process.env.MPESA_PASSKEY ??
    ''
  const {
    provider: mpesaProvider,
    verifyReferenceNumbers,
    claimsStoredPayments,
    manualEntryEnabled
  } = await resolveMpesaProvider({
    isPackaged: app.isPackaged,
    mockRequested: mockMpesaEnabled,
    confirmationMethod: mpesaConfirmationMethod,
    manualEntryEnabled: mpesaConfig.manualEntryEnabled === true,
    smsDb: db,
    darajaOptions: {
      consumerKey: mpesaConfig.consumerKey || process.env.MPESA_CONSUMER_KEY || '',
      consumerSecret: mpesaConsumerSecret,
      shortcode: mpesaConfig.shortcode || process.env.MPESA_SHORTCODE || '',
      passkey: mpesaPasskey,
      environment: mpesaEnvironment,
      callbackUrl: mpesaConfig.callbackUrl ?? process.env.MPESA_CALLBACK_URL
    }
  })
  /**
   * The device TCP password is resolved from the OS-encrypted vault, not
   * this row — and a legacy plaintext `password` left on the row by an
   * older install is migrated into the vault and deleted here, on first
   * launch, without the operator retyping anything.
   */
  const etimsPasswordResolution = await resolveEtimsDevicePassword({ keytar, db })
  if (etimsPasswordResolution.source === 'migrated-from-plaintext') {
    console.log(
      '[rubis-pos] Moved the fiscal device password out of the plaintext integrations row into the credential vault.'
    )
  }
  const etimsConfig = db.getIntegrationConfig<{
    baseUrl?: string
    endpoints?: Partial<FiscalEndpointPaths>
    defaultVatClass?: string
    deviceIp?: string
    devicePort?: string
  }>('etims')
  const fiscalizationProvider: FiscalizationProvider = await resolveFiscalizationProvider({
    isPackaged: app.isPackaged,
    mockRequested: mockEtimsEnabled,
    realOptions: {
      baseUrl: etimsConfig.baseUrl,
      endpoints: etimsConfig.endpoints,
      defaultVatClass: etimsConfig.defaultVatClass,
      password: etimsPasswordResolution.password ?? undefined,
      deviceIp: etimsConfig.deviceIp,
      devicePort: etimsConfig.devicePort,
      debugLogging: fiscalDebugLogging,
      logger: console,
      recordTraderInvNum: (localId, traderInvNum) => db.recordTraderInvNum(localId, traderInvNum),
      lookupInvoice: (invoiceNumber) => {
        const order = db.getOrderByFiscalInvoiceNumber(invoiceNumber)
        if (!order?.fiscal_invoice_number) return undefined
        return {
          invoiceNumber: order.fiscal_invoice_number,
          qrCode: order.fiscal_qr_code ?? '',
          fiscalizedAt: order.fiscal_fiscalized_at ?? order.created_at
        }
      }
    }
  })
  // A development stand-in marks its fiscal slips as tests (docs/phase-198); the real provider has no such method.
  printerSettings.decorateFiscalSlip = fiscalizationProvider.decorateFiscalSlip?.bind(fiscalizationProvider)
  /**
   * Re-reads the saved device details and pushes them into the live
   * provider, so a save from the Admin screen applies to the next sale
   * instead of the next launch.
   *
   * A no-op for the development stand-in, which has nothing to
   * configure.
   *
   * @returns {Promise<void>}
   */
  async function applyEtimsConfigToProvider(): Promise<void> {
    if (!(fiscalizationProvider instanceof RealFiscalizationProvider)) return

    const saved = db.getIntegrationConfig<{
      baseUrl?: string
      defaultVatClass?: string
      deviceIp?: string
      devicePort?: string
    }>('etims')
    const resolution = await resolveEtimsDevicePassword({ keytar, db })

    fiscalizationProvider.reconfigure({
      baseUrl: saved.baseUrl,
      deviceIp: saved.deviceIp,
      devicePort: saved.devicePort,
      defaultVatClass: saved.defaultVatClass,
      password: resolution.password ?? undefined
    })
  }

  console.log(
    `[DEBUG-ETIMS] Startup: mockMpesaEnabled = ${mockMpesaEnabled}, mockEtimsEnabled = ${mockEtimsEnabled}`
  )
  console.log(
    !(fiscalizationProvider instanceof RealFiscalizationProvider)
      ? '[DEBUG-ETIMS] Startup: using the mock fiscalization provider (development only)'
      : `[DEBUG-ETIMS] Startup: using RealFiscalizationProvider, baseUrl = ${etimsConfig.baseUrl || `(default) ${DEFAULT_ETIMS_BASE_URL}`}, deviceIp = ${etimsConfig.deviceIp || '(not configured)'}, devicePort = ${etimsConfig.devicePort || '(not configured)'}, password = ${etimsPasswordResolution.password ? `**** (from ${etimsPasswordResolution.source})` : '(not configured)'}, endpoints = ${JSON.stringify(etimsConfig.endpoints)}`
  )

  /**
   * Builds this till's current Shopify client, or `null` when the
   * store URL/token are not configured - the same resolution
   * `pushOrder` below already uses, factored out so the reconciliation
   * runner (docs/phase-170) can call it fresh on every check/guard
   * too, rather than a client baked in once at startup that would go
   * stale after an Admin-screen credential save.
   */
  const getShopifyClient = () => {
    const env = shopifyEnv()
    return env ? createShopifyClient(env.storeUrl, env.token) : null
  }

  /**
   * The Shopify sales-safety check's latest result (docs/phase-170),
   * kept in memory only - read by Admin's "Shopify check" card via IPC
   * (commit 3), and never persisted, so a restart simply waits for the
   * next check to run rather than showing a stale one.
   */
  let lastReconciliationResult: ReconciliationResult | null = null

  /**
   * Never constructed in check:fit mode (docs/phase-169-1): the check
   * is gated on `checkDue`, itself only ever set by `engine.start()`/
   * `engine.notifyOnline()` (both skipped below), so passing this in
   * would already be inert there - `undefined` here removes it a
   * second, structural way, matching this app's own belt-and-braces
   * pattern for check:fit.
   */
  const reconciliationRunner = shouldStartBackgroundSenders(checkFitSendingDisabled)
    ? createReconciliationRunner({
        db,
        getClient: getShopifyClient,
        onResult: (result) => {
          lastReconciliationResult = result
          // `broadcast` (below) is declared later in this same closure but
          // is already initialized by the time a real check completes
          // (well after this synchronous setup finishes) - see docs/
          // phase-170 commit 3's own note on this.
          broadcast('shopify-reconciliation:status', result)
        },
        logger: console
      })
    : undefined

  const engine = createSyncEngine({
    db,
    isOnline: () => net.isOnline(),
    pushOrder: async (payload) => {
      const env = shopifyEnv()
      if (!env) {
        return {
          success: false,
          error: 'Shopify credentials missing — order sync deferred'
        }
      }
      // docs/phase-210: the sale's own location is in the payload; this till's current
      // settings cover a sale queued before that phase.
      return pushOrderToShopify(
        createShopifyClient(env.storeUrl, env.token),
        payload,
        resolveCheckoutLocation(locationId, locationName)
      )
    },
    intervalMs: 30_000,
    reconciliation: reconciliationRunner
  })

  /**
   * IPC handler returning the Shopify sales-safety check's latest
   * result (docs/phase-170) - `null` before the first check has run
   * (including permanently, in check:fit mode, where the check never
   * runs at all). Read-only; the Admin "Shopify check" card (docs/
   * phase-170 commit 3) polls this rather than needing its own push
   * channel, since a result only ever changes once every few minutes
   * at most.
   */
  ipcMain.handle('shopify:get-reconciliation-status', (): ServiceResult<ReconciliationResult | null> => ({
    success: true,
    data: lastReconciliationResult
  }))

  /**
   * eTIMS fiscalization store-and-forward queue — kept as its own
   * engine/table scope rather than folded into `engine` above so the
   * Shopify sync engine never has to know eTIMS retries exist (see
   * `fiscal-engine.ts`'s file doc for why it doesn't gate on
   * connectivity the way the Shopify engine does).
   */
  const fiscalEngine = createFiscalEngine({
    db,
    submitInvoice: (request) => fiscalizationProvider.submitInvoice(request),
    intervalMs: 30_000,
    logger: console,
    onFiled: (localId) => void printLateFiledSlip(localId)
  })

  /** Broadcasts a JSON payload to every open window. */
  const broadcast = (channel: string, payload: unknown): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(channel, payload)
    }
  }

  const monitor = createNetworkMonitor({
    isOnline: () => net.isOnline(),
    intervalMs: 5_000,
    emit: (online) => {
      broadcast('network:status', { online })
      // docs/phase-169-1 commit A: an offline → online transition is the
      // one trigger neither engine's own `.start()` gate (below) covers
      // — `notifyOnline()` is a method on the already-constructed engine
      // object, reachable regardless of whether `.start()` ran. Read-only
      // connectivity display is unaffected: the broadcast above still runs.
      if (online && shouldStartBackgroundSenders(checkFitSendingDisabled)) {
        engine.notifyOnline()
        fiscalEngine.notifyOnline()
      }
    }
  })

  powerMonitor.on('resume', () => monitor.checkNow())
  monitor.start()
  // docs/phase-169-1 commit A: never start either engine while check:fit
  // has sending disabled — read-only connectivity/status screens still
  // need `monitor`/`connectivityMonitor` running, so only these two are
  // gated.
  if (shouldStartBackgroundSenders(checkFitSendingDisabled)) {
    engine.start()
    fiscalEngine.start()
  }

  /**
   * The confirmation-message reader runs only on a till that confirms
   * payments that way. A Daraja or mock till has no folder to watch, and
   * starting a poller for one would be a timer doing nothing every few
   * seconds forever.
   *
   * `null` on every other till, which is also what
   * `mpesa-sms:list-unmatched` checks before answering.
   */
  const mpesaSmsInbox =
    mpesaConfirmationMethod === 'sms'
      ? createMpesaSmsInbox({
          inboxPath: mpesaConfig.smsInboxPath ?? '',
          db,
          parse: parseMpesaPaymentSms,
          parserReady: MPESA_SMS_PARSER_READY,
          logger: console,
          debugLogging: fiscalDebugLogging
        })
      : null

  if (mpesaSmsInbox) {
    if (!MPESA_SMS_PARSER_READY) {
      console.warn(
        '[rubis-pos] M-Pesa by message is selected, but no confirmation message can be ' +
          'recognised yet — the message format is still being settled against real samples. ' +
          'No M-Pesa payment can be confirmed on this till until it is. The payment screen ' +
          'reports this to the cashier.'
      )
    }
    // docs/phase-169-1 commit A: this reader only reads confirmation
    // files, it sends nothing — skipped anyway, matching the task's own
    // "or any other background sender" instruction literally.
    if (shouldStartBackgroundSenders(checkFitSendingDisabled)) {
      mpesaSmsInbox.start()
    }
  }

  /**
   * M-Pesa (Daraja, environment-aware) / fiscal device / printer
   * reachability — a mocked integration always reports connected without
   * any real network I/O, since there is nothing external to actually
   * reach. M-Pesa/eTIMS mock mode is reported as disconnected — mocking
   * means no real Daraja/fiscal connection exists, and the badge should
   * say so rather than imply a working live integration. Manual/SMS
   * M-Pesa modes report a neutral "nothing to probe" state instead of
   * either (see `checkMpesaConnectivity`). The mock printer (a distinct,
   * older `VITE_MOCK_PRINTER` flag) simulates hardware that was never
   * expected to have a real counterpart, so it's reported as connected
   * instead.
   */
  const connectivityMonitor = createConnectivityMonitor({
    checkMpesa: () =>
      checkMpesaConnectivity({
        mode: mpesaConfirmationMethod,
        mockEnabled: mockMpesaEnabled,
        environment: mpesaEnvironment
      }),
    checkFiscal: () =>
      mockEtimsEnabled
        ? Promise.resolve(mockDisconnectedResult('eTIMS mock mode enabled'))
        : fiscalizationProvider instanceof RealFiscalizationProvider
          ? /**
             * The same three-hop check as the Admin "Test connection"
             * button, so the two never disagree about what "reachable"
             * means — a bare HTTP GET here used to count any response
             * (even from an unrelated service on that port) as
             * connected. `checkConnectivity` (not `testConnection`)
             * reuses an already-open device session instead of forcing
             * a fresh handshake on every 30s poll; it also always reads
             * this provider's current settings, so an Admin save applies
             * immediately (`applyEtimsConfigToProvider`/`reconfigure`
             * keep it current — phase-95, Finding 4's staleness note).
             */
            fiscalizationProvider.checkConnectivity().then(toConnectivityCheckResult)
          : checkHttpReachable(
              db.getIntegrationConfig<{ baseUrl?: string }>('etims').baseUrl || DEFAULT_ETIMS_BASE_URL
            ),
    checkPrinter: () =>
      printerSettings.mock
        ? Promise.resolve(mockConnectedResult())
        : checkTcpReachable(printerSettings.interfaceName),
    intervalMs: 30_000,
    emit: (status) => broadcast('connectivity:status', status)
  })
  connectivityMonitor.start()

  /**
   * Saves the cart draft before the app quits (docs/phase-197-1): the renderer
   * debounces its writes by 300 ms, so on a clean quit it is asked to write
   * now, and the quit waits up to 500 ms for its answer. A kill still loses
   * the last 300 ms.
   *
   * Two hooks, one request. `before-quit` covers `app.quit()` (restart, the
   * updater). Clicking the window's close button closes the window first and
   * only then quits, by which time the renderer is gone, so the window's own
   * `close` event is hooked too. `cartFlushed` makes whichever comes first the
   * only one that waits.
   */
  let cartFlushed = false
  const cartFlush = createCartFlushCoordinator({
    send: () => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window || window.isDestroyed()) throw new Error('no window to flush')
      window.webContents.send('cart:flush-request')
    }
  })
  ipcMain.on('cart:flush-done', () => cartFlush.acknowledge())
  const flushCartBeforeQuit = async (): Promise<void> => {
    const startedAt = Date.now()
    const result = await cartFlush.request()
    console.log(`[rubis-pos] Cart draft flush on quit: ${result} after ${Date.now() - startedAt} ms`)
    cartFlushed = true
  }
  app.on('before-quit', (event) => {
    if (cartFlushed) return
    event.preventDefault()
    void flushCartBeforeQuit().then(() => app.quit())
  })
  /** Hooks a window's `close` so the cart draft is saved before it closes. */
  const flushCartOnWindowClose = (window: BrowserWindow): BrowserWindow => {
    window.on('close', (event) => {
      if (cartFlushed) return
      event.preventDefault()
      void flushCartBeforeQuit().then(() => {
        if (!window.isDestroyed()) window.close()
      })
    })
    return window
  }

  /**
   * Release the ZFPLabServer device session on shutdown — the vendor
   * demo does the same from its form-closing handler. Deliberately not
   * done per sale: the session is what `settings()` establishes, and
   * tearing it down between transactions would force a fresh handshake
   * on every one. Best-effort and time-boxed by the HTTP client's own
   * timeout; a failure here must never delay or block quitting.
   */
  app.on('before-quit', (event) => {
    // The cart-flush hook above prevents the first pass and quits again; the
    // session is released on that final pass, not twice.
    if (event.defaultPrevented) return
    if (fiscalizationProvider instanceof RealFiscalizationProvider) {
      void fiscalizationProvider
        .closeServerConnection()
        .catch((error) =>
          console.warn('[rubis-pos] ZFPLabServer session close failed on quit:', error)
        )
    }
  })

  app.on('will-quit', () => {
    engine.stop()
    fiscalEngine.stop()
    monitor.stop()
    connectivityMonitor.stop()
    db.close()
  })

  /**
   * IPC handler for the renderer `ping()` test channel.
   * Returns a simple pong string to verify the bridge works.
   */
  ipcMain.handle('ping', () => 'pong')

  /**
   * Test-hook-only channel (docs/phase-166 Commit E3, extended
   * docs/phase-167 Part B item 1): tells the renderer which
   * screen/overlay `check:fit` wants force-shown, for the handful of
   * states a normal click-driven flow can't reach (an intermediate
   * onboarding-gate state, the fiscal notice/toast-stack pairing, the
   * manual M-Pesa keyboard, a Z-report, or the variant picker). Reads
   * `RUBIS_CHECK_FIT_SCREEN` via `resolveCheckFitForcedScreen` — absent
   * in every real launch (see `parseCheckFitSize`'s own doc comment on
   * the sibling `RUBIS_CHECK_FIT_SIZE` variable), so this always
   * resolves to `null` outside `scripts/check-fit.mjs`.
   */
  ipcMain.handle('checkFit:getForcedScreen', () =>
    resolveCheckFitForcedScreen(process.env['RUBIS_CHECK_FIT_SCREEN'])
  )

  /**
   * IPC handler that triggers a Shopify product fetch from the renderer.
   * Credentials are read from the process environment — the renderer
   * never sees them directly, only the resulting product data.
   */
  ipcMain.handle(
    'products:fetch',
    async (): Promise<ServiceResult<ProductSummary[]>> => {
      if (demoMode) {
        return { success: true, data: db.getCachedProducts() }
      }

      const env = shopifyEnv()

      if (!env) {
        return {
          success: false,
          error:
            'Shopify credentials missing — set the Store URL and Admin API Token in Admin > Integrations, or add VITE_SHOPIFY_STORE_URL/VITE_SHOPIFY_ADMIN_API_TOKEN to a .env file'
        }
      }

      const result = await fetchAllProducts(env.storeUrl, env.token, {
        locationId
      })

      if (!result.success) {
        console.warn('[rubis-pos] products:fetch failed, falling back to cache:', result.error)
      }

      if (result.success && result.data && result.data.length > 0) {
        try {
          db.cacheProducts(result.data)
        } catch (cacheError) {
          console.error('[rubis-pos] product cache write failed:', cacheError)
        }
      }

      return result
    }
  )

  /**
   * IPC handler that returns the last successfully fetched catalog
   * from SQLite — the renderer's offline fallback.
   */
  ipcMain.handle(
    'products:cached',
    (): ServiceResult<ProductSummary[]> => {
      try {
        return { success: true, data: db.getCachedProducts() }
      } catch (err) {
        return {
          success: false,
          error:
            err instanceof Error
              ? err.message
              : 'Failed to read the cached product catalog'
        }
      }
    }
  )

  /**
   * Checkout entry point.
   *
   * Always persists the sale locally (`orders` + `sync_queue`), then —
   * if currently online — attempts an immediate sync before answering,
   * so the receipt can say "synced" instead of "queued".
   */
  ipcMain.handle(
    'orders:checkout',
    async (_event, request: unknown): Promise<ServiceResult<CheckoutReceipt>> => {
      // docs/phase-169-1 commit A: a check:fit launch may never complete
      // a real sale — refused before validation even runs, since nothing
      // downstream (the queue write, fiscalization, the Shopify push) may
      // happen at all.
      const sendingGuard = guardCheckFitSending(checkFitSendingDisabled)
      if (sendingGuard) return sendingGuard

      const validation = validate(checkoutRequestSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }

      /**
       * Server-side belt-and-braces (docs/phase-161-1): the renderer
       * already hides the discount controls on a live till
       * (`fiscalModeStore.ts`), but this re-checks the request itself,
       * before any payment step and before `runCheckout` - nothing is
       * written, queued, charged, or filed for a refused request. Mock
       * mode is unaffected. See `requestHasDiscount.ts` for why a price
       * override is not checked here.
       */
      if (
        shouldRefuseCheckoutForDiscount(
          fiscalizationProvider instanceof RealFiscalizationProvider,
          validation.data
        )
      ) {
        return {
          success: false,
          error: 'Discounts cannot be filed with KRA yet. Remove the discount and try again.'
        }
      }

      /**
       * docs/phase-210: a sale must carry the shop that sold it. With no
       * location (unset or empty id or name) it is refused before anything
       * is written, paid or filed, so an order with no location can never
       * reach Shopify. The location comes from this till's own settings,
       * never from the renderer.
       */
      const saleLocation = resolveCheckoutLocation(locationId, locationName)
      if (!saleLocation) {
        return { success: false, error: NO_LOCATION_MESSAGE }
      }

      /**
       * A manually entered M-Pesa code completes a sale nobody has
       * confirmed. As of docs/phase-150.md step 3 (the client's POC
       * decision, consciously reversing phase-120 §7.3's original
       * "fallback flag, always manager-gated" design), this needs no
       * manager PIN at sale time: the control is the cashier physically
       * checking the confirmation message on the customer's phone, their
       * attestation of that, and their attribution on the record — a
       * manager's approval comes later, for the whole day's manual
       * entries at once (Step 4), not per sale here.
       *
       * `mpesaManual` is still stripped before `runCheckout` sees it —
       * `manualApproval` carries only the cashier's own attestation,
       * never anything the renderer could use to claim a status,
       * cashier, or approver it did not earn.
       *
       * `cardManual` is stripped the same way, into `cardApproval` — a
       * card (PDQ) sale, recorded manually per docs/phase-176.md Part 2,
       * with no confirming provider to check it against either.
       */
      const { mpesaManual, cardManual, ...checkoutInput } = validation.data
      let manualApproval: ManualMpesaApproval | undefined
      if (mpesaManual) {
        manualApproval = { acknowledgedUnverified: mpesaManual.confirmUnverified }
      }
      let cardApproval: CardApproval | undefined
      if (cardManual) {
        cardApproval = { reference: cardManual.reference, confirmRecorded: cardManual.confirmRecorded }
      }

      return runCheckout(
        {
          db,
          mpesaProvider,
          fiscalizationProvider,
          fiscalEngine,
          monitor,
          engineTick: () => engine.tick(),
          idGen: randomUUID,
          taxRate: printerSettings.taxRate,
          verifyReferenceNumbers,
          claimsStoredPayments,
          manualEntryEnabled,
          logger: console,
          debugLogging: fiscalDebugLogging
        },
        {
          ...checkoutInput,
          referenceNumber: mpesaManual ? mpesaManual.code : checkoutInput.referenceNumber,
          manualApproval,
          cardApproval,
          locationId: saleLocation.id,
          locationName: saleLocation.name
        }
      )
    }
  )

  /**
   * IPC handler returning the unified payment record — every M-Pesa
   * payment that settled a sale, whichever mode took it.
   */
  ipcMain.handle('mpesa:list-payments', (): ServiceResult<MpesaPaymentRow[]> => {
    try {
      return { success: true, data: db.listMpesaPayments() }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to load M-Pesa payments'
      }
    }
  })

  /**
   * IPC handler returning manually entered payments nobody has checked
   * against the M-Pesa statement yet.
   *
   * This queue is the control that justifies allowing an unverified
   * payment at all — a record marked "pending reconciliation" that no
   * screen ever shows would be a silent pass, not a safeguard.
   */
  ipcMain.handle('mpesa:list-unreconciled', (): ServiceResult<MpesaPaymentRow[]> => {
    try {
      return { success: true, data: db.listUnreconciledMpesaPayments() }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to load unreconciled payments'
      }
    }
  })

  /**
   * IPC handler marking one manual payment as checked against the
   * statement. Requires a re-verified admin Manager PIN, and records
   * that manager as the one who signed it off.
   */
  ipcMain.handle('mpesa:reconcile', (_event, request: unknown): ServiceResult<void> => {
    const validation = validate(reconcileMpesaPaymentSchema, request)
    if (!validation.success) {
      return { success: false, error: validation.error }
    }
    const authz = requireAdminPin(db, validation.data.managerId, validation.data.managerPin)
    if (!authz.success) {
      return authz
    }
    try {
      const marked = db.markMpesaPaymentReconciled(
        validation.data.paymentId,
        validation.data.managerId,
        validation.data.note?.trim() || null
      )
      if (!marked) {
        return { success: false, error: 'That payment was not found, or has already been reconciled.' }
      }
      return { success: true }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to reconcile that payment'
      }
    }
  })

  /**
   * IPC handler that initiates an M-Pesa STK Push prompt (the "online"
   * half of the hybrid flow). Standalone from
   * `orders:checkout` so the renderer can show the modal, wait for the
   * customer to complete/cancel the prompt, and only then check out.
   */
  ipcMain.handle(
    'integrations:mpesa-stk-push',
    (_event, request: StkPushRequest): Promise<ServiceResult<StkPushResult>> =>
      mpesaProvider.initiateStkPush(request)
  )

  /**
   * IPC handler reporting what this till's M-Pesa provider can actually
   * do, so a screen never offers a way to pay that cannot end in a
   * confirmed payment.
   *
   * Specifically: a Daraja till cannot check a typed transaction code
   * against Safaricom, so its Manual Code tab could only ever dead-end
   * on an error. Showing it anyway leaves what looks like a second way
   * to complete a sale sitting beside the one that works, which is how a
   * cashier ends up hunting for a way around the gate.
   */
  /**
   * The cashier's "pick the matching payment" list: recent M-Pesa
   * confirmations this till received that no sale has spent yet.
   *
   * Answers with the inbox's health alongside the list, so an empty list
   * is never ambiguous. "No payments yet" and "nothing is being read at
   * all" look identical otherwise, and only one of them means wait.
   */
  ipcMain.handle(
    'mpesa-sms:list-unmatched',
    (): ServiceResult<{ payments: UnmatchedMpesaPayment[]; health: string | null }> => {
      if (!mpesaSmsInbox || !(mpesaProvider instanceof SmsMpesaProvider)) {
        return { success: false, error: 'This till does not confirm M-Pesa payments by message.' }
      }
      try {
        return {
          success: true,
          data: {
            payments: toUnmatchedPayments(mpesaProvider.listRecentUnmatched()),
            health: describeInboxHealth(mpesaSmsInbox.getStatus())
          }
        }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Could not read recent M-Pesa payments'
        }
      }
    }
  )

  ipcMain.handle(
    'integrations:mpesa-capabilities',
    (): ServiceResult<{
      manualCodeSupported: boolean
      manualEntryEnabled: boolean
      mode: MpesaConfirmationMethod
    }> => ({
      success: true,
      data: {
        manualCodeSupported: verifyReferenceNumbers,
        manualEntryEnabled,
        mode: mpesaConfirmationMethod
      }
    })
  )

  /**
   * IPC handler that verifies a manually entered M-Pesa transaction
   * code — the offline-capable half of the hybrid flow. Exposed
   * standalone (in addition to the automatic check inside
   * `orders:checkout`) so the renderer can validate a code before the
   * cashier commits to checkout.
   */
  ipcMain.handle(
    'integrations:mpesa-verify-code',
    (
      _event,
      request: ManualCodeVerification
    ): Promise<ServiceResult<ManualCodeVerificationResult>> =>
      mpesaProvider.verifyTransactionCode(request)
  )

  /**
   * IPC handler that logs a newly initiated STK Push against the
   * M-Pesa Logs table. Called from checkout right after
   * `integrations:mpesa-stk-push` succeeds, so the M-Pesa Logs screen
   * has a `'pending'` row to show/check even before any status query
   * resolves it.
   */
  ipcMain.handle(
    'mpesa:log-transaction',
    (_event, request: unknown): ServiceResult<{ id: number }> => {
      const validation = validate(mpesaLogTransactionSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      try {
        return { success: true, data: db.logMpesaTransaction(validation.data) }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to log M-Pesa transaction'
        }
      }
    }
  )

  /**
   * IPC handler that lists recent M-Pesa transactions for the M-Pesa
   * Logs screen.
   */
  ipcMain.handle(
    'mpesa:get-logs',
    (_event, limit?: number): ServiceResult<MpesaTransactionRow[]> => {
      try {
        return { success: true, data: db.getMpesaTransactions(limit) }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to load M-Pesa transactions'
        }
      }
    }
  )

  /**
   * IPC handler that re-checks a pending STK Push's outcome via
   * `queryStkPushStatus` and persists the result — the manual
   * "Check Status" action on the M-Pesa Logs screen, standing in for
   * a real callback receiver (see `daraja-mpesa-provider.ts`'s file
   * doc).
   */
  ipcMain.handle(
    'mpesa:query-status',
    async (_event, request: unknown): Promise<ServiceResult<StkPushStatusResult>> => {
      const validation = validate(mpesaQueryStatusSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      const result = await mpesaProvider.queryStkPushStatus(validation.data)
      if (result.success && result.data && result.data.status !== 'pending') {
        try {
          db.updateMpesaTransactionStatus(
            validation.data,
            result.data.status,
            result.data.receiptNumber
          )
        } catch (err) {
          console.error('[rubis-pos] Failed to persist M-Pesa status query result:', err)
        }
      }
      return result
    }
  )

  /**
   * IPC handler that reports whether the two secret-bearing Daraja
   * fields (consumer secret, passkey) are currently stored in the
   * credential vault — never the values themselves, mirroring
   * `secrets:get-shopify-token-status`.
   */
  ipcMain.handle(
    'secrets:get-mpesa-status',
    async (): Promise<
      ServiceResult<{ consumerSecretConfigured: boolean; passkeyConfigured: boolean }>
    > => {
      try {
        const [consumerSecret, passkey] = await Promise.all([
          getSecret(keytar, SECRET_SERVICE_NAME, MPESA_CONSUMER_SECRET_ACCOUNT),
          getSecret(keytar, SECRET_SERVICE_NAME, MPESA_PASSKEY_ACCOUNT)
        ])
        return {
          success: true,
          data: { consumerSecretConfigured: !!consumerSecret, passkeyConfigured: !!passkey }
        }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to read M-Pesa credential status'
        }
      }
    }
  )

  /**
   * IPC handler that saves one or both secret-bearing Daraja fields to
   * the credential vault (Admin screen). Requires a re-verified admin
   * Manager PIN — the same privilege class as
   * `integrations:set-config`. Takes effect on next restart since
   * `mpesaProvider` above is constructed once at startup — this
   * mirrors `mock_mpesa_enabled`'s `requiresRestart` framing even
   * though the credential itself isn't stored in `app_configurations`.
   */
  ipcMain.handle(
    'secrets:set-mpesa-credentials',
    async (_event, request: unknown): Promise<ServiceResult<void>> => {
      const validation = validate(mpesaCredentialsSetSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      const authz = requireAdminPin(db, validation.data.managerId, validation.data.managerPin)
      if (!authz.success) {
        return authz
      }
      try {
        if (validation.data.consumerSecret?.trim()) {
          await setSecret(
            keytar,
            SECRET_SERVICE_NAME,
            MPESA_CONSUMER_SECRET_ACCOUNT,
            validation.data.consumerSecret.trim()
          )
        }
        if (validation.data.passkey?.trim()) {
          await setSecret(keytar, SECRET_SERVICE_NAME, MPESA_PASSKEY_ACCOUNT, validation.data.passkey.trim())
        }
        return { success: true }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to save M-Pesa credentials'
        }
      }
    }
  )

  /**
   * IPC handler that verifies the currently configured Daraja
   * credentials by attempting an OAuth2 token exchange only — no STK
   * Push, no charge. Only meaningful once `VITE_USE_MOCK_MPESA=false`
   * and the app has restarted with real credentials in place; against
   * `MockMpesaProvider` this always reports success trivially since
   * the mock has no credentials to check.
   */
  ipcMain.handle('config:test-mpesa', async (): Promise<ServiceResult<void>> => {
    // Branch on what was actually built, not on what the config asked
    // for: `resolveMpesaProvider` refuses the mock in a packaged build
    // and substitutes a refusing provider when credentials are missing,
    // so an unchecked cast here could call a method that is not there.
    if (mpesaProvider instanceof DarajaMpesaProvider) {
      return mpesaProvider.testCredentials()
    }
    if (mockMpesaEnabled) {
      return { success: true }
    }
    return { success: false, error: MPESA_NOT_CONFIGURED_MESSAGE }
  })

  /**
   * IPC handler that reads every `app_configurations` value for the
   * Admin screen, optionally scoped to one category.
   */
  ipcMain.handle(
    'config:get-all',
    (_event, category?: AppConfigCategory): ServiceResult<Record<string, string>> => {
      try {
        return { success: true, data: db.getAllConfigs(category) }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to read configuration'
        }
      }
    }
  )

  /**
   * IPC handler that writes one `app_configurations` value (Admin
   * screen). Requires a re-verified admin Manager PIN — the same
   * privilege class as `integrations:set-config`, since these values
   * select which provider (mock or real) a till talks to.
   */
  ipcMain.handle(
    'config:set',
    (_event, request: unknown): ServiceResult<void> => {
      const validation = validate(configSetSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      const authz = requireAdminPin(db, validation.data.managerId, validation.data.managerPin)
      if (!authz.success) {
        return authz
      }
      try {
        db.setConfig(validation.data.key, validation.data.value, {
          requiresRestart: validation.data.requiresRestart,
          category: validation.data.category
        })
        return { success: true }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to save configuration'
        }
      }
    }
  )

  /**
   * IPC handler that reads a provider's stored integration config
   * for the Admin screen's Integrations panel.
   *
   * Any `password` key is stripped before the config crosses to the
   * renderer. The fiscal device password lives in the credential vault
   * now, so this should never see one — but a row written by an older
   * build could still carry it before
   * {@link resolveEtimsDevicePassword}'s migration has run, and no
   * secret should reach a screen regardless. The Admin form reports
   * "Configured"/"Not configured" from `secrets:get-etims-status`
   * instead, mirroring the Shopify token and Daraja secrets.
   */
  ipcMain.handle(
    'integrations:get-config',
    (_event, provider: IntegrationProviderName): ServiceResult<Record<string, unknown>> => {
      try {
        return { success: true, data: redactIntegrationConfig(db.getIntegrationConfig(provider)) }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to read integration config'
        }
      }
    }
  )

  /**
   * IPC handler that saves a provider's integration config (Paybill/
   * Till numbers, middleware URLs) from the Admin screen. Requires a
   * re-verified admin Manager PIN — routing Paybill/Till
   * numbers is exactly the kind of change a compromised renderer
   * calling this channel directly must not be able to make unchecked.
   */
  ipcMain.handle(
    'integrations:set-config',
    (_event, request: unknown): ServiceResult<void> => {
      const validation = validate(integrationsSetConfigSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      const authz = requireAdminPin(db, validation.data.managerId, validation.data.managerPin)
      if (!authz.success) {
        return authz
      }
      // The generic schema accepts any record; the device fields get the
      // same checks the setup gate enforces, so a save from the Admin
      // screen can no longer store a malformed address the gate would
      // have rejected.
      if (validation.data.provider === 'etims') {
        const etimsValidation = validate(etimsIntegrationConfigSchema, validation.data.config)
        if (!etimsValidation.success) {
          return { success: false, error: etimsValidation.error }
        }
      }
      if (validation.data.provider === 'mpesa') {
        const mpesaValidation = validate(mpesaIntegrationConfigSchema, validation.data.config)
        if (!mpesaValidation.success) {
          return { success: false, error: mpesaValidation.error }
        }
      }
      try {
        db.setIntegrationConfig(validation.data.provider, validation.data.config)
        if (validation.data.provider === 'etims') {
          void applyEtimsConfigToProvider()
        }
        return { success: true }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to save integration config'
        }
      }
    }
  )

  /**
   * IPC handler that saves the fiscal device's TCP password to the
   * credential vault. Requires a re-verified admin Manager PIN — the
   * same privilege class as `integrations:set-config`, and the same
   * shape as `secrets:set-mpesa-credentials`.
   *
   * Unlike the M-Pesa handler this also re-applies the device config, so
   * the new password is in force for the next sale rather than the next
   * launch.
   */
  ipcMain.handle(
    'secrets:set-etims-password',
    async (_event, request: unknown): Promise<ServiceResult<void>> => {
      const validation = validate(etimsPasswordSetSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      const authz = requireAdminPin(db, validation.data.managerId, validation.data.managerPin)
      if (!authz.success) {
        return authz
      }
      try {
        const saved = await setSecret(
          keytar,
          SECRET_SERVICE_NAME,
          ETIMS_DEVICE_PASSWORD_ACCOUNT,
          validation.data.password.trim()
        )
        if (!saved) {
          return {
            success: false,
            error: 'Could not save the fiscal device password securely on this machine.'
          }
        }
        await applyEtimsConfigToProvider()
        return { success: true }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to save the fiscal device password'
        }
      }
    }
  )

  /**
   * IPC handler that reports whether a fiscal device password is stored,
   * never the value — mirroring `secrets:get-mpesa-status`.
   */
  ipcMain.handle(
    'secrets:get-etims-status',
    async (): Promise<ServiceResult<{ passwordConfigured: boolean }>> => {
      try {
        const password = await getSecret(
          keytar,
          SECRET_SERVICE_NAME,
          ETIMS_DEVICE_PASSWORD_ACCOUNT
        )
        return { success: true, data: { passwordConfigured: Boolean(password) } }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to read fiscal device status'
        }
      }
    }
  )

  /**
   * IPC handler that reads the store identity printed on receipts.
   * Not a secret — a shop's own name and KRA PIN appear on every receipt
   * it issues — so no manager PIN to read.
   */
  ipcMain.handle(
    'store:get-identity',
    (): ServiceResult<{
      storeName: string
      storeKraPin: string
      legalName: string
      address: string
      phone: string
      footerMessage: string
    }> => {
      try {
        return {
          success: true,
          data: {
            storeName: db.getSetting(STORE_NAME_SETTING_KEY) ?? '',
            storeKraPin: db.getSetting(STORE_KRA_PIN_SETTING_KEY) ?? '',
            legalName: db.getSetting(STORE_LEGAL_NAME_SETTING_KEY) ?? '',
            address: db.getSetting(STORE_ADDRESS_SETTING_KEY) ?? '',
            phone: db.getSetting(STORE_PHONE_SETTING_KEY) ?? '',
            footerMessage: db.getSetting(STORE_FOOTER_MESSAGE_SETTING_KEY) ?? ''
          }
        }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to read store details'
        }
      }
    }
  )

  /**
   * IPC handler that saves the store identity printed on receipts.
   * Manager PIN required — it changes what every receipt this till
   * issues claims about who issued it. Applies to the next receipt, not
   * the next launch.
   */
  ipcMain.handle(
    'store:set-identity',
    (_event, request: unknown): ServiceResult<void> => {
      const validation = validate(storeIdentitySetSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      const authz = requireAdminPin(db, validation.data.managerId, validation.data.managerPin)
      if (!authz.success) {
        return authz
      }
      try {
        const storeName = validation.data.storeName.trim()
        const storeKraPin = validation.data.storeKraPin.trim()
        const legalName = validation.data.legalName?.trim() ?? ''
        const address = validation.data.address?.trim() ?? ''
        const phone = validation.data.phone?.trim() ?? ''
        const footerMessage = validation.data.footerMessage?.trim() ?? ''
        db.setSetting(STORE_NAME_SETTING_KEY, storeName)
        db.setSetting(STORE_KRA_PIN_SETTING_KEY, storeKraPin)
        db.setSetting(STORE_LEGAL_NAME_SETTING_KEY, legalName)
        db.setSetting(STORE_ADDRESS_SETTING_KEY, address)
        db.setSetting(STORE_PHONE_SETTING_KEY, phone)
        db.setSetting(STORE_FOOTER_MESSAGE_SETTING_KEY, footerMessage)
        printerSettings.storeName = storeName
        printerSettings.storeKraPin = storeKraPin || undefined
        printerSettings.legalName = legalName || undefined
        printerSettings.address = address || undefined
        printerSettings.phone = phone || undefined
        printerSettings.footerMessage = footerMessage || undefined
        return { success: true }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to save store details'
        }
      }
    }
  )

  /**
   * IPC handler behind the Admin screen's "Test connection" button.
   * Walks the three hops between this till and a filed invoice and
   * reports which one broke — see `fiscal-connection-test.ts`.
   */
  ipcMain.handle(
    'config:test-etims',
    async (): Promise<ServiceResult<FiscalConnectionTestResult>> => {
      if (!(fiscalizationProvider instanceof RealFiscalizationProvider)) {
        return {
          success: false,
          error: 'This till is running a development fiscal stand-in, so there is nothing to test.'
        }
      }
      try {
        return { success: true, data: await fiscalizationProvider.testConnection() }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to test the fiscal device connection'
        }
      }
    }
  )

  /**
   * IPC handler that lists every configured printer for the
   * Admin screen's Peripherals tab. On Windows, also re-checks every
   * `connectionType: 'windows'` printer against the currently installed
   * queues (docs/phase-174) — `markMissingWindowsPrinters` flags one
   * `missing: true` when its saved queue name is no longer installed,
   * so the Admin screen can show it rather than let a "Test" silently
   * fail. Re-checked on every load (the first of which is at app
   * start), not just once — a queue can be uninstalled at any time.
   */
  ipcMain.handle(
    'printers:list',
    async (): Promise<ServiceResult<PrinterWithAvailability[]>> => {
      try {
        const configs = db.getPrinters()
        if (process.platform !== 'win32' || !configs.some((c) => c.connectionType === 'windows')) {
          return { success: true, data: configs }
        }
        const window = BrowserWindow.getAllWindows()[0]
        const available = window ? await window.webContents.getPrintersAsync() : []
        return {
          success: true,
          data: markMissingWindowsPrinters(configs, available.map((p) => p.name))
        }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to load printers'
        }
      }
    }
  )

  /**
   * IPC handler behind the Admin screen's "Find printers" button
   * (docs/phase-174) — lists every printer Windows currently knows
   * about via `webContents.getPrintersAsync()` ("Get the system printer
   * list": https://www.electronjs.org/docs/latest/api/web-contents), so
   * a USB or COM/serial printer already installed as a Windows printer
   * queue can be picked instead of typed. Read-only, same risk class as
   * `printers:test`. Windows-only — the Admin screen hides the option
   * elsewhere, but this is refused server-side too rather than trusting
   * that alone.
   */
  ipcMain.handle(
    'printers:find-windows',
    async (): Promise<ServiceResult<WindowsPrinterInfo[]>> => {
      if (process.platform !== 'win32') {
        return { success: false, error: 'Windows printer detection is only available on Windows' }
      }
      try {
        const window = BrowserWindow.getAllWindows()[0]
        if (!window) {
          return { success: false, error: 'No window available to list printers' }
        }
        const printers = await window.webContents.getPrintersAsync()
        return { success: true, data: printers.map(toWindowsPrinterInfo) }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to list Windows printers'
        }
      }
    }
  )

  /**
   * IPC handler that upserts a printer configuration.
   * Requires a re-verified admin Manager PIN — registering a printer
   * interface is the same class of privileged write as
   * `integrations:set-config`.
   */
  ipcMain.handle(
    'printers:save',
    (_event, request: unknown): ServiceResult<void> => {
      const validation = validate(printerSaveSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      const authz = requireAdminPin(db, validation.data.managerId, validation.data.managerPin)
      if (!authz.success) {
        return authz
      }
      try {
        db.savePrinter({
          id: validation.data.id,
          type: validation.data.type,
          interfaceName: validation.data.interfaceName,
          enabled: validation.data.enabled,
          connectionType: validation.data.connectionType
        })
        printerRegistry = buildPrinterRegistry(db.getPrinters())
        return { success: true }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to save printer'
        }
      }
    }
  )

  /**
   * IPC handler that removes a printer configuration.
   * Requires a re-verified admin Manager PIN, matching `printers:save`.
   */
  ipcMain.handle(
    'printers:delete',
    (_event, request: unknown): ServiceResult<void> => {
      const validation = validate(printerDeleteSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      const authz = requireAdminPin(db, validation.data.managerId, validation.data.managerPin)
      if (!authz.success) {
        return authz
      }
      try {
        db.deletePrinter(validation.data.id)
        printerRegistry = buildPrinterRegistry(db.getPrinters())
        return { success: true }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to delete printer'
        }
      }
    }
  )

  /**
   * IPC handler that sends a test page to a given printer — read-only
   * diagnostic, no manager re-authorization needed (see
   * `printerTestSchema`). Branches on the request shape (docs/phase-174):
   * a Windows queue name routes to `printWindowsTestPage`, unchanged
   * `interfaceName` keeps going to `printTestPage` exactly as before.
   */
  ipcMain.handle(
    'printers:test',
    async (_event, request: unknown): Promise<ServiceResult<ReceiptPrintResult>> => {
      const validation = validate(printerTestSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      if ('windowsPrinterName' in validation.data) {
        return printWindowsTestPage(validation.data.windowsPrinterName, printerSettings.storeName)
      }
      return printTestPage(validation.data.interfaceName)
    }
  )

  /**
   * IPC handler that reports whether a Shopify Admin API token is
   * currently stored in the credential vault — never the token value
   * itself. Lets the Admin screen show "Configured"
   * / "Not configured" without ever sending the secret to the renderer.
   */
  ipcMain.handle(
    'secrets:get-shopify-token-status',
    async (): Promise<ServiceResult<{ configured: boolean }>> => {
      try {
        const stored = await getSecret(keytar, SECRET_SERVICE_NAME, SHOPIFY_TOKEN_ACCOUNT)
        return { success: true, data: { configured: !!stored } }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to read token status'
        }
      }
    }
  )

  /**
   * IPC handler that saves the Shopify Admin API token to the
   * credential vault — the "prompt the user" path from Task 1 for a
   * packaged build with no token yet in the vault, surfaced via the
   * Admin screen's Integrations panel. Updates the in-memory
   * `shopifyToken` immediately so sync/fetch work without a restart.
   */
  ipcMain.handle(
    'secrets:set-shopify-token',
    async (_event, token: unknown): Promise<ServiceResult<void>> => {
      if (typeof token !== 'string' || token.trim().length === 0) {
        return { success: false, error: 'A non-empty token is required' }
      }
      const saved = await setSecret(keytar, SECRET_SERVICE_NAME, SHOPIFY_TOKEN_ACCOUNT, token.trim())
      if (!saved) {
        return { success: false, error: 'Failed to save token to the credential vault' }
      }
      shopifyToken = token.trim()
      return { success: true }
    }
  )

  /**
   * IPC handler that reports the currently resolved Shopify store URL
   * — not a secret, so (unlike the token) the value itself
   * is safe to send to the renderer for the Admin screen's field.
   */
  ipcMain.handle(
    'shopify:get-store-url',
    (): ServiceResult<{ storeUrl: string | null }> => ({
      success: true,
      data: { storeUrl: shopifyStoreUrl }
    })
  )

  /**
   * IPC handler that saves the Shopify store URL to the local
   * `settings` table — the "no `.env` required on every
   * install" path: an admin sets it once from the Integrations panel,
   * exactly like `secrets:set-shopify-token` already does for the API
   * token. Requires a re-verified admin Manager PIN, matching
   * `integrations:set-config` and `printers:save` — pointing the till
   * at a different store is a consequential write even though the URL
   * itself isn't a secret. Updates the in-memory `shopifyStoreUrl`
   * immediately so sync/fetch work without a restart.
   */
  ipcMain.handle(
    'shopify:set-store-url',
    (_event, request: unknown): ServiceResult<void> => {
      const validation = validate(shopifySetStoreUrlSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      const authz = requireAdminPin(db, validation.data.managerId, validation.data.managerPin)
      if (!authz.success) {
        return authz
      }
      try {
        db.setSetting(SHOPIFY_STORE_URL_SETTING_KEY, validation.data.storeUrl)
        shopifyStoreUrl = validation.data.storeUrl
        return { success: true }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to save store URL'
        }
      }
    }
  )

  /**
   * IPC handler backing the first-run onboarding wizard:
   * reports whether this till already has a working Shopify connection
   * (store URL + token both resolved, from `.env` or a prior
   * onboarding/Admin-screen save) and, if so, the non-secret parts of
   * that config. `App.tsx` calls this on mount to decide whether to
   * show `OnboardingScreen` or the normal Login screen.
   */
  ipcMain.handle(
    'config:get-status',
    (): ServiceResult<{
      hasConfig: boolean
      locationConfirmed: boolean
      config?: { storeUrl: string; locationId: string | null; locationName: string | null }
    }> => {
      const hasConfig = !!(shopifyStoreUrl && shopifyToken)
      return {
        success: true,
        data: {
          hasConfig,
          locationConfirmed,
          config: shopifyStoreUrl
            ? {
                storeUrl: shopifyStoreUrl,
                locationId: locationId ?? null,
                locationName: locationName ?? null
              }
            : undefined
        }
      }
    }
  )

  /**
   * IPC handler backing the mandatory eTIMS configuration gate:
   * reports whether this till may proceed to the main POS UI. Real
   * eTIMS mode requires `baseUrl`/`deviceIp`/`devicePort`/`password`
   * to already be saved — left unconfigured, checkout previously
   * reached the fiscal device and crashed with an HTTP 500 instead of
   * blocking the UI up front. Mock mode is always complete.
   */
  ipcMain.handle('setup:check-etims-completion', async (): Promise<
    ServiceResult<EtimsCompletionStatus>
  > => {
    try {
      const config = db.getIntegrationConfig<{
        baseUrl?: string
        deviceIp?: string
        devicePort?: string
      }>('etims')
      // The password is no longer on the row — it lives in the vault, so
      // completeness has to ask the vault rather than read the config.
      const password = await getSecret(keytar, SECRET_SERVICE_NAME, ETIMS_DEVICE_PASSWORD_ACCOUNT)
      return {
        success: true,
        // Keyed on the provider actually in use, not on what the config
        // asked for. A packaged build refuses the mock regardless of the
        // stored flag, so an upgraded install whose row still says mock
        // would otherwise skip this gate while running the real provider.
        data: checkEtimsCompletion(!(fiscalizationProvider instanceof RealFiscalizationProvider), {
          ...config,
          password: password ?? undefined
        })
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to check eTIMS configuration'
      }
    }
  })

  /**
   * IPC handler that saves the four required Real-eTIMS connection
   * fields from the setup gate. No manager re-authorization — this
   * runs before any staff has necessarily unblocked the till,
   * mirroring `config:save`'s pre-login write. Preserves any other
   * stored `etims` fields (e.g. `endpoints`, `defaultVatClass`).
   *
   * The password goes to the credential vault, never to the row — the
   * gate writes the same way the Admin screen does.
   */
  ipcMain.handle(
    'setup:save-etims-config',
    async (_event, request: unknown): Promise<ServiceResult<void>> => {
      const validation = validate(etimsConfigSaveSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      try {
        const saved = await setSecret(
          keytar,
          SECRET_SERVICE_NAME,
          ETIMS_DEVICE_PASSWORD_ACCOUNT,
          validation.data.password.trim()
        )
        if (!saved) {
          return {
            success: false,
            error: 'Could not save the fiscal device password securely on this machine.'
          }
        }
        const existing = db.getIntegrationConfig('etims')
        db.setIntegrationConfig('etims', {
          ...existing,
          baseUrl: validation.data.baseUrl.trim(),
          deviceIp: validation.data.deviceIp.trim(),
          devicePort: validation.data.devicePort.trim()
        })
        await applyEtimsConfigToProvider()
        return { success: true }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to save eTIMS configuration'
        }
      }
    }
  )


  /**
   * Fetches this till's already-resolved Shopify store URL/token
   * (nothing re-entered) and returns its available locations for the
   * location-confirmation screen (both first-run onboarding and the
   * post-login gate). Read-only — no manager PIN required, mirrors
   * `config:validate`'s risk class.
   */
  ipcMain.handle(
    'location:list',
    async (): Promise<
      ServiceResult<{ shopName: string; locations: { id: string; name: string; address?: string }[] }>
    > => {
      const env = shopifyEnv()
      if (!env) {
        return { success: false, error: 'Shopify is not configured yet' }
      }
      return validateAndFetchLocations(env.storeUrl, env.token)
    }
  )

  /**
   * Persists the admin-confirmed location for this till. Manager PIN
   * required — this is the one true "confirmation" write, replacing
   * the old silent Phase-4 auto-detect-and-persist logic.
   */
  ipcMain.handle(
    'location:set',
    (_event, request: unknown): ServiceResult<void> => {
      const validation = validate(locationSetSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      const authz = requireAdminPin(db, validation.data.managerId, validation.data.managerPin)
      if (!authz.success) {
        return authz
      }
      try {
        const locationChanged = locationId !== validation.data.locationId
        db.setSetting('location_id', validation.data.locationId)
        db.setSetting('location_name', validation.data.locationName)
        db.setSetting('location_confirmed', '1')
        locationId = validation.data.locationId
        locationName = validation.data.locationName
        locationConfirmed = true
        // The cached catalog was scoped to whatever location was
        // previously confirmed (or none) — serving it as the offline
        // fallback for a different location would show the wrong
        // assortment/stock, so it's dropped rather than carried over.
        if (locationChanged) {
          db.clearProductCache()
        }
        return { success: true }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to save location'
        }
      }
    }
  )

  /**
   * IPC handler for the onboarding wizard's "Connect & Verify" step
   * — makes a single read-only Shopify API call to confirm
   * the store URL/token pair actually works and to fetch the location
   * list the next step picks from. Saves nothing; `config:save` does
   * that once the operator has chosen a location.
   */
  ipcMain.handle(
    'config:validate',
    async (
      _event,
      request: unknown
    ): Promise<ServiceResult<{ shopName: string; locations: { id: string; name: string; address?: string }[] }>> => {
      const validation = validate(configValidateSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      return validateAndFetchLocations(validation.data.storeUrl, validation.data.token)
    }
  )

  /**
   * IPC handler that persists the onboarding wizard's result:
   * the store URL to the `settings` table (same as
   * `shopify:set-store-url`), the token to the credential vault (same
   * as `secrets:set-shopify-token`), and the single selected location
   * id to `settings`. Updates all three in-memory bindings immediately
   * so the app can proceed straight to the Login screen without a
   * restart. No manager PIN — see `configSaveSchema`'s doc comment.
   */
  ipcMain.handle(
    'config:save',
    async (_event, request: unknown): Promise<ServiceResult<void>> => {
      const validation = validate(configSaveSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      const {
        storeUrl,
        token,
        locationId: selectedLocationId,
        locationName: selectedLocationName
      } = validation.data
      const savedToken = await setSecret(keytar, SECRET_SERVICE_NAME, SHOPIFY_TOKEN_ACCOUNT, token)
      if (!savedToken) {
        return { success: false, error: 'Failed to save the Admin API token to the credential vault' }
      }
      try {
        db.setSetting(SHOPIFY_STORE_URL_SETTING_KEY, storeUrl)
        db.setSetting('location_id', selectedLocationId)
        db.setSetting('location_name', selectedLocationName)
        db.setSetting('location_confirmed', '1')
        shopifyStoreUrl = storeUrl
        shopifyToken = token
        locationId = selectedLocationId
        locationName = selectedLocationName
        locationConfirmed = true
        return { success: true }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to save configuration'
        }
      }
    }
  )

  /**
   * IPC handler for the Admin screen's "Reset Configuration" action
   * — clears the store URL, vault token, and location
   * id so the till returns to the first-run onboarding state on next
   * launch (or immediately, once the renderer reloads). Manager PIN
   * required: this is a destructive action with no undo.
   */
  ipcMain.handle(
    'config:clear',
    async (_event, request: unknown): Promise<ServiceResult<void>> => {
      const validation = validate(configClearSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      const authz = requireAdminPin(db, validation.data.managerId, validation.data.managerPin)
      if (!authz.success) {
        return authz
      }
      try {
        db.setSetting(SHOPIFY_STORE_URL_SETTING_KEY, '')
        db.setSetting('location_id', '')
        db.setSetting('location_name', '')
        db.setSetting('location_confirmed', '')
        await deleteSecret(keytar, SECRET_SERVICE_NAME, SHOPIFY_TOKEN_ACCOUNT)
        shopifyStoreUrl = null
        shopifyToken = null
        locationId = undefined
        locationName = undefined
        locationConfirmed = false
        return { success: true }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to reset configuration'
        }
      }
    }
  )

  /**
   * Refuses every void (phase-131). Void was removed from the till
   * because a sale may already be filed with KRA and the till cannot
   * issue the credit note that would reverse it. The channel stays
   * registered so a stale renderer gets a plain refusal, not a
   * missing-handler error.
   */
  ipcMain.handle('orders:void', (): ServiceResult<never> => ({
    success: false,
    error: VOID_DISABLED_MESSAGE
  }))

  /**
   * Lets the renderer read connectivity synchronously at startup,
   * before the first `network:status` event has fired.
   */
  ipcMain.handle('network:get-status', () => ({
    online: monitor.isOnline()
  }))

  /**
   * Lets the renderer read the last-known connectivity status
   * synchronously, before the first `connectivity:status` event has
   * fired.
   */
  ipcMain.handle('connectivity:get-status', () => connectivityMonitor.getStatus())

  /** Triggers an immediate connectivity check across every monitored integration. */
  ipcMain.handle('connectivity:test-all', () => connectivityMonitor.checkNow())

  /**
   * IPC handler to fetch local orders for the order history view.
   */
  ipcMain.handle(
    'orders:getLocal',
    (_event, request?: { limit?: number; offset?: number }) => {
      try {
        const orders = db.getOrders(request?.limit, request?.offset)
        return { success: true, data: orders }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to fetch orders'
        }
      }
    }
  )

  /**
   * IPC handler to retry syncing a failed or pending order.
   */
  ipcMain.handle(
    'orders:retrySync',
    async (_event, localId: number) => {
      // docs/phase-169-1 commit A: retrying still calls engine.tick()
      // below, which would push straight to Shopify.
      const sendingGuard = guardCheckFitSending(checkFitSendingDisabled)
      if (sendingGuard) return sendingGuard

      try {
        const { queueId } = db.retryOrderSync(localId)
        if (monitor.isOnline()) {
          await engine.tick()
        }
        return { success: true, data: { queueId } }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to retry order sync'
        }
      }
    }
  )

  /**
   * IPC handler for the till's wrong-PIN fix-and-resend (phase-78,
   * Part C). Corrects (or, when `buyerPin` is `null`, removes) the
   * buyer PIN on the sale's STORED fiscal request, then resends
   * through the same guarded path every retry/resend uses — never a
   * new submit path, so Rule 1 (never file twice) keeps holding.
   */
  ipcMain.handle(
    'fiscal:correct-pin-and-resend',
    async (_event, request: unknown): Promise<ServiceResult<FiscalResendResult>> => {
      // docs/phase-169-1 commit A: not one of the task's four named
      // handlers, added alongside them because it resends to the same
      // real fiscal device via the same guarded submitInvoice path as
      // fiscal:resend below — see docs/phase-169-1.md for why.
      const sendingGuard = guardCheckFitSending(checkFitSendingDisabled)
      if (sendingGuard) return sendingGuard

      const validation = validate(correctPinAndResendSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      const { localId, buyerPin } = validation.data
      try {
        const outcome = await correctPinAndResend(
          {
            db,
            fiscalizationProvider,
            logger: console,
            isFiling: (id) => fiscalEngine.isClaimed(id),
            onFiled: (id) => void printLateFiledSlip(id)
          },
          localId,
          buyerPin ?? undefined
        )
        return { success: true, data: buildFiscalResendResult(db, localId, outcome) }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to resend the fiscal invoice'
        }
      }
    }
  )

  /**
   * IPC handler for the back-office "Resend" action (phase-88, Step 4)
   * — a plain resend with no PIN change, for a `needs_fixing`/`system`
   * row or a stuck-`waiting` row. Goes through the same guarded
   * `resendFiscalization` every other resend path uses (Rule 1 — never
   * file twice — holds the same way it does everywhere else).
   */
  ipcMain.handle(
    'fiscal:resend',
    async (_event, request: unknown): Promise<ServiceResult<FiscalResendResult>> => {
      // docs/phase-169-1 commit A: this sends a real command to the
      // fiscal device (submitInvoice) exactly like a normal sale would.
      const sendingGuard = guardCheckFitSending(checkFitSendingDisabled)
      if (sendingGuard) return sendingGuard

      const validation = validate(resendFiscalizationSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      const { localId } = validation.data
      try {
        const outcome = await resendFiscalization(
          {
            db,
            fiscalizationProvider,
            logger: console,
            isFiling: (id) => fiscalEngine.isClaimed(id),
            onFiled: (id) => void printLateFiledSlip(id)
          },
          localId
        )
        return { success: true, data: buildFiscalResendResult(db, localId, outcome) }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to resend the fiscal invoice'
        }
      }
    }
  )

  /**
   * IPC handler for "Print ETR copy at the fiscal device" (docs/phase-196-2).
   * Sends `InfoLastReceiptDuplicate` once, and only when the device's last
   * receipt is this order's. Requires a re-verified admin Manager PIN; the
   * manager who authorised it is recorded in the audit row. Issues no new
   * fiscal document and never enters the fiscal queue or `sync_queue`.
   */
  ipcMain.handle(
    'fiscal:print-duplicate',
    async (_event, request: unknown): Promise<ServiceResult<{ issuedNewReceipt: boolean }>> => {
      const sendingGuard = guardCheckFitSending(checkFitSendingDisabled)
      if (sendingGuard) return sendingGuard

      const validation = validate(printFiscalDuplicateSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      const authz = requireAdminPin(db, validation.data.managerId, validation.data.managerPin)
      if (!authz.success) {
        return { success: false, error: authz.error }
      }
      try {
        return await printFiscalDuplicate(
          { db, fiscalizationProvider },
          validation.data.orderId,
          validation.data.managerId
        )
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to print the ETR copy'
        }
      }
    }
  )

  /**
   * IPC handlers for the cart draft (docs/phase-197): the one cart saved on
   * this till so it survives a restart. A draft only - nothing here touches
   * an order, stock or Shopify, and no payment state is stored.
   */
  ipcMain.handle('cart:save-draft', (_event, request: unknown): ServiceResult<void> => {
    const validation = validate(saveCartDraftSchema, request)
    if (!validation.success) {
      return { success: false, error: validation.error }
    }
    try {
      db.saveCartDraft(JSON.stringify(validation.data))
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Failed to save the cart' }
    }
  })

  ipcMain.handle('cart:load-draft', (): ServiceResult<{ payloadJson: string } | null> => {
    try {
      const draft = db.getCartDraft()
      return { success: true, data: draft ? { payloadJson: draft.payload_json } : null }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Failed to load the saved cart' }
    }
  })

  ipcMain.handle('cart:clear-draft', (): ServiceResult<void> => {
    try {
      db.clearCartDraft()
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Failed to clear the saved cart' }
    }
  })

  /**
   * IPC handlers for held sales (docs/phase-217): a cart parked while the cashier
   * serves the next customer. A held sale is not a sale - nothing here files with
   * the tax device, queues for Shopify, moves stock or uses a trader number.
   */
  ipcMain.handle('held:list', (): ServiceResult<HeldSaleSummary[]> => {
    try {
      return { success: true, data: db.listOpenHeldSales() }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Failed to load the held sales' }
    }
  })

  ipcMain.handle('held:hold', (_event, request: unknown): ServiceResult<HeldSaleSummary> => {
    const validation = validate(holdSaleSchema, request)
    if (!validation.success) {
      return { success: false, error: validation.error }
    }
    return holdCart(db, validation.data)
  })

  ipcMain.handle(
    'held:resume',
    (_event, request: unknown): ServiceResult<{ summary: HeldSaleSummary; payloadJson: string }> => {
      const validation = validate(heldSaleIdSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      try {
        return { success: true, data: db.resumeHeldSale(validation.data.id) }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Could not resume the sale' }
      }
    }
  )

  ipcMain.handle('held:rename', (_event, request: unknown): ServiceResult<HeldSaleSummary> => {
    const validation = validate(renameHeldSaleSchema, request)
    if (!validation.success) {
      return { success: false, error: validation.error }
    }
    try {
      return { success: true, data: db.renameHeldSale(validation.data.id, validation.data.label) }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Could not rename the sale' }
    }
  })

  ipcMain.handle('held:discard', (_event, request: unknown): ServiceResult<HeldSaleSummary> => {
    const validation = validate(discardHeldSaleSchema, request)
    if (!validation.success) {
      return { success: false, error: validation.error }
    }
    return discardHeldSaleApproved(db, validation.data)
  })

  ipcMain.handle('held:discarded-for-day', (_event, request: unknown): ServiceResult<DiscardedHeldSale[]> => {
    const validation = validate(discardedHeldSalesSchema, request ?? {})
    if (!validation.success) {
      return { success: false, error: validation.error }
    }
    try {
      const { startIso, endIso } = getLocalDayRange(validation.data.localDay ?? todayLocalDay())
      return { success: true, data: db.getDiscardedHeldSales(startIso, endIso) }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Failed to load the discarded held sales' }
    }
  })

  /**
   * IPC handler that records manager-approved cart removals (docs/phase-197).
   * Re-verifies the manager's PIN in the main process like every privileged
   * write, so a renderer cannot forge an approval. The renderer changes the
   * cart only after this succeeds.
   */
  ipcMain.handle('cart:record-removals', (_event, request: unknown): ServiceResult<void> => {
    const validation = validate(recordCartRemovalsSchema, request)
    if (!validation.success) {
      return { success: false, error: validation.error }
    }
    return recordApprovedRemovals(db, validation.data)
  })

  /**
   * IPC handler for the back-office "needs attention" list (phase-88,
   * Step 4) — every `needs_fixing` order plus every stuck-`waiting`
   * order. Read-only; the actions are the two handlers above.
   */
  ipcMain.handle(
    'fiscal:needs-attention',
    (): ServiceResult<NeedsAttentionRow[]> => {
      try {
        const rows = db.getOrdersNeedingAttention(Date.now(), STUCK_WAITING_THRESHOLD_MS)
        return { success: true, data: rows }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to load sales needing attention'
        }
      }
    }
  )

  /**
   * IPC handler for the sales whose stored device VAT figures disagree with the
   * till's own (docs/phase-198-1). Read-only, and worked out from what is stored
   * each time it is asked, so it follows any change to how the groups are read.
   */
  ipcMain.handle(
    'fiscal:vat-mismatches',
    (): ServiceResult<VatMismatchRow[]> => {
      try {
        return { success: true, data: findVatMismatches(db.getFiscalisedOrdersWithVatGroups(), printerSettings.taxRate) }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to load the VAT figures to reconcile'
        }
      }
    }
  )

  /**
   * IPC handler for the filed sales whose fiscal slip never reached paper
   * (docs/phase-198). Read-only; the action is the existing `receipt:print`.
   */
  ipcMain.handle(
    'fiscal:unprinted-slips',
    (): ServiceResult<UnprintedFiscalSlipRow[]> => {
      try {
        return { success: true, data: db.getUnprintedFiscalSlips() }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to load unprinted tax invoices'
        }
      }
    }
  )

  /**
   * IPC handler for the Rule-3 safety-net count (phase-88, Step 4) —
   * every completed-but-unfiled sale, `waiting` or `needs_fixing`,
   * regardless of the stuck threshold above.
   */
  ipcMain.handle(
    'fiscal:unfiled-count',
    (): ServiceResult<number> => {
      try {
        return { success: true, data: db.getUnfiledOrderCount() }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to count unfiled sales'
        }
      }
    }
  )

  /**
   * IPC handler exposing whether this till is running the real fiscal
   * provider (docs/phase-161, Commit 1 - an interim safeguard against
   * docs/phase-160's finding that a discount or price override is filed
   * with KRA and printed on the receipt against the raw, undiscounted
   * price). The renderer hides the discount/override controls, and
   * blocks completing a sale that already carries one, only when this
   * is `true`.
   *
   * Read directly off the provider instance actually in use
   * (`instanceof RealFiscalizationProvider`, the same check already used
   * elsewhere in this file, e.g. `setup:check-etims-completion` above) -
   * never a second evaluation of `mockRequested`/`isPackaged`, so this
   * can never disagree with what `resolveFiscalizationProvider` already
   * decided at startup.
   */
  ipcMain.handle(
    'fiscal:is-live',
    (): ServiceResult<boolean> => ({
      success: true,
      data: fiscalizationProvider instanceof RealFiscalizationProvider
    })
  )

  /**
   * Opens a PDF receipt in the OS default viewer when printing fell
   * back to saving one instead of reaching a physical printer — never
   * when the physical printer actually printed.
   *
   * @param {ServiceResult<ReceiptPrintResult>} result
   * @returns {ServiceResult<ReceiptPrintResult>}
   */
  const openPdfFallbackIfPresent = (
    result: ServiceResult<ReceiptPrintResult>
  ): ServiceResult<ReceiptPrintResult> => {
    if (result.success && result.data?.mode === 'pdf' && result.data.filePath) {
      void shell.openPath(result.data.filePath)
    }
    return result
  }

  /**
   * Prints the slips of one sale (docs/phase-198): rebuilds the receipt's
   * line items from the order's stored offline-order payload and sends the
   * fiscal-side slip, then the Enjoy customer slip, as separate jobs. Shared
   * by the `receipt:print` handler and the print after a late filing.
   *
   * @param {OrderRow} order
   * @param {object} options
   * @param {OrderSlipSelection} options.slips which slips to print
   * @param {boolean} options.isDuplicate stamps the fiscal-side slip "DUPLICATE"
   * @param {boolean} options.customerSlipIsDuplicate stamps the Enjoy slip "DUPLICATE"
   * @param {PrinterType} options.printerType
   * @returns {Promise<OrderSlipsResult>}
   */
  async function printSlipsForOrder(
    order: OrderRow,
    options: {
      slips: OrderSlipSelection
      isDuplicate: boolean
      customerSlipIsDuplicate: boolean
      printerType: PrinterType
    }
  ): Promise<OrderSlipsResult> {
    const payload = JSON.parse(order.payload_json) as OfflineOrderPayload
    // docs/phase-165: a not-yet-filed sale on the real provider gets
    // a plain "sale record" slip instead of a tax invoice — never on
    // the mock/non-eTIMS provider, which has no filing to promise.
    const fiscalPending = shouldShowFiscalPendingSlip(
      fiscalizationProvider instanceof RealFiscalizationProvider,
      order.fiscal_status
    )
    /**
     * `fiscal_request_json` (docs/phase-171's audit) is the ORIGINAL
     * request sent to the device — read-only here, never resubmitted.
     * It is the only place a buyer's company name is stored
     * (docs/phase-157), and the only place a per-item VAT class is
     * stored before a sale has fiscalised. Absent (an unfiled sale
     * that has never reached the device, or an older order predating
     * this field) means no buyer name and every item defaults to
     * class A, same as `checkout.ts`'s own default.
     */
    let buyerName: string | undefined
    let itemVatClasses: string[] = []
    if (order.fiscal_request_json) {
      try {
        const fiscalRequest = JSON.parse(order.fiscal_request_json) as {
          companyName?: string
          items?: Array<{ vatClass?: string }>
        }
        buyerName = fiscalRequest.companyName || undefined
        itemVatClasses = (fiscalRequest.items ?? []).map(
          (line) => resolveVatClass(line.vatClass) ?? String(line.vatClass)
        )
      } catch {
        // Malformed/legacy JSON — print without a buyer name or per-item VAT classes rather than failing the whole receipt.
      }
    }
    let vatGroups: ReceiptLayoutVatGroups | undefined
    if (order.fiscal_vat_groups_json) {
      try {
        vatGroups = JSON.parse(order.fiscal_vat_groups_json) as ReceiptLayoutVatGroups
      } catch {
        // Malformed JSON — the layout builder's own class-A fallback covers this.
      }
    }
    return printOrderSlips(
      {
        localId: order.local_id,
        createdAt: order.created_at,
        cashierName: payload.staffName,
        paymentMethod: payload.paymentMethod,
        tenderedAmount: payload.tenderedAmount,
        changeDue: payload.changeDue,
        referenceNumber: payload.referenceNumber,
        customerPin: payload.customerPin,
        buyerName,
        fiscalInvoiceNumber: order.fiscal_invoice_number ?? undefined,
        traderInvNum: order.fiscal_trader_inv_num ?? undefined,
        fiscalQrCode: order.fiscal_qr_code ?? undefined,
        fiscalizedAt: order.fiscal_fiscalized_at ?? undefined,
        fiscalizedAtSource: order.fiscal_fiscalized_at_source ?? undefined,
        cuSerial: order.fiscal_cu_serial ?? undefined,
        vatGroups,
        fiscalPending,
        isDuplicate: options.isDuplicate,
        customerSlipIsDuplicate: options.customerSlipIsDuplicate,
        // docs/phase-161: the stored total/discounts, no longer
        // stripped before reaching the printer.
        total: order.total,
        cartDiscount: payload.cartDiscount
      },
      payload.lineItems.map((line, index) => ({
        title: line.title,
        variantTitle: line.variantTitle ?? '',
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discount: line.discount,
        vatClass: itemVatClasses[index]
      })),
      printerRegistry,
      { ...printerSettings, locationName: db.getSetting('location_name') || undefined },
      options.slips,
      options.printerType
    )
  }

  /**
   * Prints the fiscal slip of a sale the fiscal queue has just filed
   * (docs/phase-198); see `late-filed-slip.ts`. A function declaration, so the
   * fiscal engine created earlier can call it.
   *
   * @param {number} localId
   * @returns {Promise<void>}
   */
  function printLateFiledSlip(localId: number): Promise<void> {
    return printLateFiledSlipFor(
      {
        db,
        printFiscalSlip: async (order) => {
          const printed = await printSlipsForOrder(order, {
            slips: { fiscal: true, customer: false },
            isDuplicate: false,
            customerSlipIsDuplicate: false,
            printerType: 'receipt'
          })
          return printed.fiscal as ServiceResult<ReceiptPrintResult>
        },
        logger: console
      },
      localId
    )
  }

  /**
   * IPC handler that prints (or, in mock mode, logs) either a local
   * order's receipt or — when `isZReport` is set — a shift's Z-report.
   * Reconstructs receipt line items from the order's stored
   * offline-order payload.
   */
  ipcMain.handle(
    'receipt:print',
    async (_event, request: unknown): Promise<ServiceResult<ReceiptPrintResult>> => {
      // docs/phase-169-1 commit A: refused only for a REAL printer — the
      // mock printer touches no hardware (it logs, and for the PDF
      // fallback writes a local file only), so it stays available for
      // check:fit's own screens.
      const sendingGuard = guardCheckFitSending(checkFitSendingDisabled, {
        skipWhenMock: printerSettings.mock === true
      })
      if (sendingGuard) return sendingGuard

      const validation = validate(receiptPrintRequestSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      const { localId, shiftId, isZReport, printerType, auto, staffId, fiscalOnly } = validation.data

      if (isZReport) {
        if (!shiftId) {
          return { success: false, error: 'No shift specified for Z-report' }
        }
        try {
          const report = generateZReport(db, shiftId, printerSettings.taxRate)
          return openPdfFallbackIfPresent(await printZReport(report, printerSettings))
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : 'Failed to print Z-report'
          }
        }
      }

      if (!localId) {
        return { success: false, error: 'No order specified' }
      }

      const order = db.getOrder(localId)
      if (!order) {
        return { success: false, error: `Order ${localId} not found` }
      }

      try {
        // docs/phase-164: decided from whether THIS order's receipt was
        // already printed once before — never from which button was
        // pressed, since `receipt:print` is the single call site for
        // both the first print and any later reprint (see docs/phase-164's
        // audit of every receipt:print/printReceipt call site). The Enjoy
        // slip is decided the same way, from its own record (docs/phase-198-1).
        // docs/phase-198: the fiscal slip, then the Enjoy customer slip, as
        // separate jobs that succeed or fail on their own.
        const printed = await printSlipsForOrder(order, {
          slips: { fiscal: true, customer: !fiscalOnly },
          ...slipStamps(db, order),
          printerType: printerType ?? 'receipt'
        })
        const fiscalResult = printed.fiscal as ServiceResult<ReceiptPrintResult>
        // docs/phase-164-1, 198, 198-1: what reached paper is recorded; see slip-records.ts.
        recordSlipOutcome(db, order, printed, { auto, fiscalOnly, staffId })
        const result = attachCustomerSlipResult(fiscalResult, printed.customer)
        // docs/phase-165: the automatic end-of-sale print never
        // force-opens a PDF viewer window when the printer was offline —
        // the PDF is still saved, and the renderer shows one toast
        // instead (cartStore.ts). A manual Order History print keeps
        // opening it, exactly as before this phase.
        return shouldOpenPdfFallbackViewer(auto) ? openPdfFallbackIfPresent(result) : result
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to print receipt'
        }
      }
    }
  )

  /**
   * IPC handler that returns every active staff account for the
   * login screen's name picker. PIN hashes are never included.
   */
  ipcMain.handle(
    'staff:list',
    (): ServiceResult<StaffSummary[]> => {
      try {
        return { success: true, data: db.getActiveStaff() }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to load staff list'
        }
      }
    }
  )

  /**
   * IPC handler that verifies a staff PIN and opens a new shift on
   * success.
   */
  ipcMain.handle(
    'auth:login',
    (_event, request: unknown): ServiceResult<StaffSummary> => {
      const validation = validate(loginRequestSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      try {
        return authenticateStaff(db, validation.data.staffId, validation.data.pin)
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Login failed'
        }
      }
    }
  )

  /**
   * IPC handler for logout. Login/logout are authentication only —
   * the till shift (opened/closed separately from the Admin screen)
   * is unaffected.
   */
  ipcMain.handle('auth:logout', (): ServiceResult<void> => ({ success: true }))

  /**
   * IPC handler that creates a new staff account (Admin screen).
   * Requires a re-verified admin Manager PIN — creating an
   * account (including an `admin` one) is a privilege-escalation path
   * a compromised renderer calling this channel directly must not be
   * able to take unchecked.
   */
  ipcMain.handle(
    'staff:create',
    (_event, request: unknown): ServiceResult<StaffSummary> => {
      const validation = validate(staffCreateSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      const authz = requireAdminPin(db, validation.data.managerId, validation.data.managerPin)
      if (!authz.success) {
        return { success: false, error: authz.error }
      }
      try {
        const { staffId } = db.createStaff({
          name: validation.data.name.trim(),
          pinHash: hashPin(validation.data.pin),
          role: validation.data.role
        })
        return {
          success: true,
          data: { id: staffId, name: validation.data.name.trim(), role: validation.data.role }
        }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to create staff account'
        }
      }
    }
  )

  /**
   * IPC handler that resets a staff member's PIN (Admin screen).
   * Requires a re-verified admin Manager PIN — resetting
   * another account's PIN is equivalent to taking it over.
   */
  ipcMain.handle(
    'staff:resetPin',
    (_event, request: unknown): ServiceResult<void> => {
      const validation = validate(staffResetPinSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      const authz = requireAdminPin(db, validation.data.managerId, validation.data.managerPin)
      if (!authz.success) {
        return authz
      }
      try {
        db.resetStaffPin(validation.data.staffId, hashPin(validation.data.pin))
        return { success: true }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to reset PIN'
        }
      }
    }
  )

  /**
   * IPC handler that returns the currently open till shift, if any.
   */
  ipcMain.handle(
    'shifts:current',
    (): ServiceResult<ShiftRow | null> => {
      try {
        return { success: true, data: db.getOpenShift() ?? null }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to read shift status'
        }
      }
    }
  )

  /**
   * IPC handler that opens a new store-wide till shift with a
   * starting cash float. Fails if a shift is already open — only one
   * shift may be open at a time.
   */
  ipcMain.handle(
    'shifts:open',
    (_event, request: unknown): ServiceResult<{ shiftId: number }> => {
      const validation = validate(shiftOpenSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      try {
        const { staffId, startingCash, shiftType } = validation.data
        const data = db.openShift(staffId, startingCash, shiftType ?? null)
        return { success: true, data }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to open shift'
        }
      }
    }
  )

  /**
   * IPC handler that closes the open till shift, reconciling counted
   * cash against expected cash.
   */
  ipcMain.handle(
    'shifts:close',
    (_event, request: unknown): ServiceResult<{ expectedCash: number; discrepancy: number }> => {
      const validation = validate(shiftCloseSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      return closeShiftUnlessHeld(db, validation.data.shiftId, validation.data.endingCash)
    }
  )

  /**
   * IPC handler that generates the Z-report for a shift.
   *
   * `shiftId` is now zod-validated (docs/phase-158) — previously the only
   * reports handler with no schema at all (docs/phase-157 Part 3).
   */
  ipcMain.handle(
    'reports:z-report',
    (_event, request: unknown): ServiceResult<ZReport> => {
      const validation = validate(zReportRequestSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      try {
        return {
          success: true,
          data: generateZReport(db, validation.data.shiftId, printerSettings.taxRate)
        }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to generate Z-report'
        }
      }
    }
  )

  /**
   * IPC handler that generates today's sales summary for the Admin
   * screen, independent of till-shift boundaries.
   *
   * Moved to the Nairobi calendar day (docs/phase-158, fixing docs/
   * phase-157 Part 3 G3) — this used to default to the UTC day, which
   * disagreed with the end-of-day report's Nairobi day for any sale made
   * between 00:00 and 03:00 local time.
   */
  ipcMain.handle(
    'reports:daily-summary',
    (): ServiceResult<DailySummary> => {
      try {
        return {
          success: true,
          data: generateDailySummary(db, printerSettings.taxRate, getReportRange('today'))
        }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to generate daily summary'
        }
      }
    }
  )

  /**
   * IPC handler generating the end-of-day report (docs/phase-151/152) —
   * read-only, open to any logged-in staff exactly like the Z-report and
   * daily-summary handlers above it. Only *approving* the report
   * (`reports:approve-day`, below) is manager-gated.
   *
   * KNOWN GAP (docs/phase-158, docs/KNOWN_GAPS.md): the main process has
   * no concept of "the currently logged-in staff member" — every write
   * that needs authorization re-verifies a manager PIN passed explicitly
   * on the request (see `requireAdminPin.ts`); there is no server-side
   * session to check a role against for a *read*. Every `reports:*`
   * read channel in this file (this one, `z-report`, `daily-summary`,
   * and the five below) is therefore reachable by any renderer script
   * regardless of which screen is showing, even though the UI only
   * exposes them from the admin-only Reports/Overview screens
   * (App.tsx). Inventing a session, or adding a PIN prompt to a read,
   * was explicitly ruled out for this phase — this is recorded as a gap,
   * not fixed here.
   */
  ipcMain.handle(
    'reports:end-of-day',
    (_event, request: unknown): ServiceResult<EndOfDayReport> => {
      const validation = validate(endOfDayReportSchema, request ?? {})
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      try {
        return {
          success: true,
          data: generateEndOfDayReport(db, validation.data.localDay)
        }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to generate end-of-day report'
        }
      }
    }
  )

  /**
   * IPC handler for a manager's end-of-day review. Requires a
   * re-verified admin Manager PIN — this is the only check a manual
   * M-Pesa entry gets, now that phase-150 removed the per-sale PIN.
   *
   * `approvedIds`/`excluded` must be exactly the ids the renderer's
   * report displayed, split into what to approve and what to leave
   * pending (docs/phase-153); `approveMpesaEntries` only ever touches
   * those, never "every unapproved entry as of now" (see its own doc
   * comment).
   */
  ipcMain.handle(
    'reports:approve-day',
    (_event, request: unknown): ServiceResult<ApproveMpesaEntriesResult> => {
      const validation = validate(approveDayReportSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      const authz = requireAdminPin(db, validation.data.managerId, validation.data.managerPin)
      if (!authz.success) {
        return { success: false, error: authz.error }
      }
      try {
        const { localDay, approvedIds, excluded, managerId, note } = validation.data
        const result = db.approveMpesaEntries(
          approvedIds,
          excluded.map((entry) => ({ paymentId: entry.paymentId, reason: entry.reason?.trim() || null })),
          managerId,
          localDay,
          note?.trim() || null
        )
        return { success: true, data: result }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to record this review'
        }
      }
    }
  )

  /** Orders/invoices per page on the Admin Reports shift-history and invoice-list screens. */
  const REPORTS_PAGE_SIZE = 10

  /**
   * IPC handler returning one page of shift history, most recently
   * opened first (docs/phase-158, closing docs/phase-157 Part 3 G1 —
   * previously only the currently open shift, or one shift already
   * known by id, could be read at all).
   */
  ipcMain.handle(
    'reports:shifts-list',
    (_event, request: unknown): ServiceResult<{ shifts: ShiftRow[]; total: number; page: number }> => {
      const validation = validate(shiftsListSchema, request ?? {})
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      try {
        const { page } = validation.data
        const offset = (page - 1) * REPORTS_PAGE_SIZE
        const shifts = db.listShifts(REPORTS_PAGE_SIZE, offset)
        return { success: true, data: { shifts, total: db.countShifts(), page } }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to list shifts'
        }
      }
    }
  )

  /**
   * IPC handler generating a sales summary for one of the fixed Nairobi
   * date-range presets (docs/phase-158) — the multi-day generalisation
   * of `reports:daily-summary`.
   */
  ipcMain.handle(
    'reports:sales-summary',
    (_event, request: unknown): ServiceResult<SalesSummary> => {
      const validation = validate(salesSummarySchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      try {
        const range = getReportRange(validation.data.preset)
        return { success: true, data: generateSalesSummary(db, printerSettings.taxRate, range) }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to generate sales summary'
        }
      }
    }
  )

  /**
   * IPC handler counting orders by fiscal status, one row per Nairobi
   * calendar day within the chosen preset (docs/phase-158, closing docs/
   * phase-157 Part 3 G10's "per day" gap — the live needs-attention list
   * already existed, but never bucketed by day).
   */
  ipcMain.handle(
    'reports:fiscal-by-day',
    (_event, request: unknown): ServiceResult<FiscalStatusDayCount[]> => {
      const validation = validate(fiscalByDaySchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      try {
        const range = getReportRange(validation.data.preset)
        return { success: true, data: generateFiscalStatusByDay(db, range) }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to generate fiscal status by day'
        }
      }
    }
  )

  /**
   * IPC handler for the fiscal reconciliation report (docs/phase-163,
   * Commit 2; VIL checklist item 13) — every `'fiscalized'` order in the
   * chosen preset, compared against the fiscal device's own stored
   * per-VAT-group amounts. Returns the whole range in one call, like
   * `reports:fiscal-by-day` above (client-side paginated), not one page
   * at a time like `reports:invoice-list` below — a reconciliation
   * preset's mismatch/no-figure counts need the full set to be correct,
   * not just one page of it.
   */
  ipcMain.handle(
    'reports:fiscal-reconciliation',
    (_event, request: unknown): ServiceResult<FiscalReconciliationReport> => {
      const validation = validate(fiscalReconciliationSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      try {
        const range = getReportRange(validation.data.preset)
        return { success: true, data: generateFiscalReconciliation(db, range) }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to generate fiscal reconciliation'
        }
      }
    }
  )

  /**
   * IPC handler returning one page of orders for the invoice list
   * (docs/phase-158) — pairs each order's own (CU) fiscal invoice number
   * with its trader system invoice number, closing docs/phase-157 Part 3
   * G9. The trader invoice number is computed here (via the shared
   * `buildTraderSystemInvNum`, the same format `real-etims-provider.ts`
   * uses — see `traderSystemInvoiceNumber.ts`'s own doc comment for why
   * it is a guarded duplicate rather than an import of that private
   * method), not in the renderer, so the format lives in exactly two
   * places, never three.
   */
  ipcMain.handle(
    'reports:invoice-list',
    (
      _event,
      request: unknown
    ): ServiceResult<{ invoices: InvoiceListRow[]; total: number; page: number }> => {
      const validation = validate(invoiceListSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      try {
        const { preset, page } = validation.data
        const range = getReportRange(preset)
        const offset = (page - 1) * REPORTS_PAGE_SIZE
        const { rows, total } = db.getOrderRowsForRange(
          range.startIso,
          range.endIso,
          REPORTS_PAGE_SIZE,
          offset
        )
        const invoices: InvoiceListRow[] = rows.map((order) => {
          let clientOrderUuid = ''
          try {
            clientOrderUuid = (JSON.parse(order.payload_json) as { clientOrderUuid?: string }).clientOrderUuid ?? ''
          } catch {
            // Defensive only — every order this app has written has a valid payload_json.
          }
          return {
            order,
            traderInvoiceNumber: resolveTraderSystemInvNum(order.fiscal_trader_inv_num, order.local_id, clientOrderUuid)
          }
        })
        return { success: true, data: { invoices, total, page } }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to list invoices'
        }
      }
    }
  )

  /**
   * IPC handler exporting one CSV file (orders or line items, per
   * `kind`) for the chosen preset (docs/phase-158, closing docs/
   * phase-157 Part 3 G12) — the user picks where to save it via
   * Electron's own save dialog (e.g. a USB stick), so nothing is written
   * anywhere without an explicit choice. A cancelled dialog is reported
   * as `{ saved: false }`, not an error.
   *
   * No fiscal or payment code runs here — `buildOrdersCsv`/`buildLinesCsv`
   * only read already-persisted `orders`/`mpesa_payments` rows.
   */
  ipcMain.handle(
    'reports:export-csv',
    async (event, request: unknown): Promise<ServiceResult<{ saved: boolean; filePath?: string }>> => {
      const validation = validate(exportCsvSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      try {
        const { preset, kind } = validation.data
        const range = getReportRange(preset)
        const csv = kind === 'orders'
          ? buildOrdersCsv(db, range, printerSettings.taxRate)
          : buildLinesCsv(db, range)

        // Nairobi calendar day, not `range.startIso.slice(0, 10)` — that
        // slices the UTC instant, which for a Nairobi midnight boundary
        // (UTC+3) names the *previous* day (docs/phase-158-1, same class
        // of bug as docs/phase-157 Part 3 G3).
        const fileName = `rubis-${kind}-${preset}-${localDayOf(range.startIso)}.csv`
        // `BrowserWindow.fromWebContents` ties the native save dialog to
        // the window that invoked it (sheet on macOS, modal on Windows)
        // instead of a windowless dialog; it returns null only if the
        // renderer's window has already been destroyed mid-call, in
        // which case the windowless overload is the correct fallback.
        const parentWindow = BrowserWindow.fromWebContents(event.sender)
        const dialogOptions = {
          title: `Export ${kind} CSV - ${range.label}`,
          defaultPath: join(app.getPath('documents'), fileName),
          filters: [{ name: 'CSV', extensions: ['csv'] }]
        }
        const result = parentWindow
          ? await dialog.showSaveDialog(parentWindow, dialogOptions)
          : await dialog.showSaveDialog(dialogOptions)
        if (result.canceled || !result.filePath) {
          return { success: true, data: { saved: false } }
        }
        writeFileSync(result.filePath, csv, 'utf8')
        return { success: true, data: { saved: true, filePath: result.filePath } }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to export CSV'
        }
      }
    }
  )

  /**
   * IPC handler for the app version (used by @electron-toolkit/preload).
   */
  ipcMain.handle('app:get-version', () => app.getVersion())

  /**
   * The version `update-downloaded` most recently reported — `updater:install`
   * needs it as the backup's `toVersion` (docs/phase-178), and nothing else
   * in `electron-updater`'s API hands it back on demand.
   */
  let downloadedVersion: string | null = null

  /**
   * Auto-update wiring: pushes each status change to every
   * open window as `updater:status`, driving the renderer's toast.
   */
  initAutoUpdater(autoUpdater, (status: UpdateStatus) => {
    if (status.kind === 'downloaded') downloadedVersion = status.version
    broadcast('updater:status', status)
  })

  /**
   * IPC handler that triggers an update check, invoked from the Admin
   * screen's "Check for Updates" button.
   */
  ipcMain.handle('updater:check', async (): Promise<ServiceResult<void>> => {
    await checkForUpdates(autoUpdater)
    return { success: true }
  })

  /** Where phase 178's pre-update backups live — survives an update (the phase-177 NSIS guard), wiped on a real uninstall like everything else under `userData`. */
  const updateBackupsDir = join(app.getPath('userData'), 'backups')

  /**
   * IPC handler that backs up the database, records the before-counts,
   * prunes old backups, then restarts the app to install the downloaded
   * update (docs/phase-178). Thin glue only — `installUpdate` owns the
   * ordering guarantee (backup and settings write fully resolved before
   * `quitAndInstall()` ever runs) and is what's actually unit-tested.
   */
  ipcMain.handle('updater:install', async (): Promise<ServiceResult<void>> => {
    if (!downloadedVersion) {
      return { success: false, error: 'No update ready to install.' }
    }

    const result = await installUpdate({
      db,
      backupsDir: updateBackupsDir,
      fromVersion: app.getVersion(),
      toVersion: downloadedVersion,
      ensureDir: (dir) => mkdirSync(dir, { recursive: true }),
      listBackups: (dir) => readdirSync(dir),
      deleteBackup: (path) => unlinkSync(path),
      quitAndInstall: () => autoUpdater.quitAndInstall()
    })

    if (!result.success) {
      return { success: false, error: result.error }
    }

    return { success: true }
  })

  /**
   * IPC handler that reads the result of the most recently completed
   * over-the-air update, or `null` if none has landed since it was last
   * resolved (docs/phase-178) — drives Admin > App & Updates' carried-over
   * data line.
   */
  ipcMain.handle('updater:last-result', (): ServiceResult<LastUpdateResult | null> => {
    const raw = db.getSetting('lastUpdateResult')
    return { success: true, data: raw ? (JSON.parse(raw) as LastUpdateResult) : null }
  })

  /**
   * IPC handler that relaunches the app — used by the Admin screen's
   * restart-countdown after saving a `requiresRestart` configuration
   * (e.g. the M-Pesa/eTIMS mock toggles), so the change actually takes
   * effect (those providers are constructed once at startup).
   */
  ipcMain.handle('app:restart', (): ServiceResult<void> => {
    app.relaunch()
    app.quit()
    return { success: true }
  })

  /**
   * Reads this till's location-scoped levels straight from Shopify,
   * inventory item ids included, for a stock take's opening snapshot
   * and its re-read at commit.
   *
   * Always a live call. The stock take never reads a cached quantity —
   * not `products.inventory_quantity`, not a previous session's
   * snapshot — because Shopify is the only place a current quantity
   * lives.
   */
  const fetchStockTakeLevels = async (): Promise<
    ServiceResult<Map<string, InventoryLevelDetail>>
  > => {
    const env = shopifyEnv()
    if (!env) {
      return { success: false, error: 'Shopify credentials missing — set them in Admin > Integrations.' }
    }
    if (!locationId) {
      return { success: false, error: 'This till has no confirmed Shopify location.' }
    }
    try {
      const client = createShopifyClient(env.storeUrl, env.token)
      return { success: true, data: await fetchInventoryLevelDetails(client, locationId) }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Could not read current stock from Shopify'
      }
    }
  }

  /**
   * Assembles the stock-take service's dependencies.
   *
   * Rebuilt per call rather than captured once so `locationId` is
   * always this till's *current* confirmed location — a session opened
   * before an admin re-pointed the till is then refused at commit
   * rather than pushed at the new location.
   */
  const stockTakeDeps = (): StockTakeDeps => ({
    db,
    locationId,
    fetchLevels: fetchStockTakeLevels,
    pushAdjustment: async ({ sessionUuid, batchIndex, changes }) => {
      const env = shopifyEnv()
      if (!env || !locationId) {
        return { success: false, error: 'Shopify is not configured for this till.' }
      }
      const client = createShopifyClient(env.storeUrl, env.token)
      return pushInventoryAdjustment(client, {
        locationId,
        sessionUuid,
        batchIndex,
        changes
      })
    },
    isOnline: () => monitor.isOnline(),
    idGen: randomUUID
  })

  /**
   * IPC handler that opens a stock-take session against a fresh
   * Shopify read. Online-only; no manager PIN (counting is ordinary
   * floor work — pushing the result is what needs authorizing).
   */
  ipcMain.handle(
    'stocktake:open',
    async (_event, request: unknown): Promise<ServiceResult<StockTakeSessionView>> => {
      const validation = validate(stockTakeOpenSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      const staff = db.getStaffById(validation.data.staffId)
      if (!staff || staff.is_active !== 1) {
        return { success: false, error: 'That staff account cannot start a stock take.' }
      }
      return openStockTake(stockTakeDeps(), staff.id)
    }
  )

  /**
   * IPC handler that records one counted variant. Works offline — the
   * snapshot and price it stamps the row with are already local.
   */
  ipcMain.handle(
    'stocktake:count',
    (_event, request: unknown): ServiceResult<StockTakeSessionView> => {
      const validation = validate(stockTakeCountSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      return recordCount(stockTakeDeps(), validation.data)
    }
  )

  /** IPC handler that drops one mis-scanned row from a session still being counted. */
  ipcMain.handle(
    'stocktake:remove',
    (_event, request: unknown): ServiceResult<StockTakeSessionView> => {
      const validation = validate(stockTakeRemoveSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      return removeCount(stockTakeDeps(), validation.data.sessionId, validation.data.variantId)
    }
  )

  /** IPC handler returning the session this till is currently working on, if any. */
  ipcMain.handle(
    'stocktake:active',
    (): ServiceResult<StockTakeSessionView | null> => {
      const active = db.getActiveStockTakeSession()
      if (!active) return { success: true, data: null }
      return { success: true, data: { session: active, items: db.getStockTakeItems(active.id) } }
    }
  )

  /** IPC handler returning one session with its counted rows. */
  ipcMain.handle(
    'stocktake:get',
    (_event, request: unknown): ServiceResult<StockTakeSessionView> => {
      const validation = validate(stockTakeSessionIdSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      return readSession(stockTakeDeps(), validation.data.sessionId)
    }
  )

  /** IPC handler returning recent stock takes for the back-office history list. */
  ipcMain.handle('stocktake:list', (): ServiceResult<StockTakeSessionView[]> => {
    try {
      return {
        success: true,
        data: db
          .listStockTakeSessions()
          .map((session) => ({ session, items: db.getStockTakeItems(session.id) }))
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to load stock takes'
      }
    }
  })

  /** IPC handler that submits a counted session for manager approval. */
  ipcMain.handle(
    'stocktake:submit',
    (_event, request: unknown): ServiceResult<StockTakeSessionView> => {
      const validation = validate(stockTakeSessionIdSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      return submitForApproval(stockTakeDeps(), validation.data.sessionId)
    }
  )

  /**
   * IPC handler that discards an uncommitted session. Requires a
   * re-verified admin Manager PIN — throwing away a completed count is
   * a decision someone should have to own.
   */
  ipcMain.handle(
    'stocktake:abandon',
    (_event, request: unknown): ServiceResult<void> => {
      const validation = validate(stockTakeAbandonSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      const authz = requireAdminPin(db, validation.data.managerId, validation.data.managerPin)
      if (!authz.success) {
        return authz
      }
      return abandonStockTake(stockTakeDeps(), validation.data.sessionId)
    }
  )

  /**
   * IPC handler building the pre-commit preview. Online-only, and
   * changes nothing — so no manager PIN, the same reasoning as
   * `config:validate` and `printers:test`.
   */
  ipcMain.handle(
    'stocktake:preview',
    async (_event, request: unknown): Promise<ServiceResult<StockTakePreview>> => {
      const validation = validate(stockTakeSessionIdSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      return previewCommit(stockTakeDeps(), validation.data.sessionId)
    }
  )

  /**
   * IPC handler that pushes an approved stock take to Shopify — the
   * app's only inventory write.
   *
   * The approver recorded on the session is the id whose PIN
   * `requireAdminPin` just verified here, never a name the renderer
   * supplied. A second approver, required above the configured value
   * threshold, is verified the same way and must be a different
   * manager.
   */
  ipcMain.handle(
    'stocktake:commit',
    async (_event, request: unknown): Promise<ServiceResult<StockTakeCommitSummary>> => {
      const validation = validate(stockTakeCommitSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      const authz = requireAdminPin(db, validation.data.managerId, validation.data.managerPin)
      if (!authz.success) {
        return { success: false, error: authz.error }
      }

      let secondApproverStaffId: number | null = null
      if (validation.data.secondApproverId !== undefined) {
        const secondAuthz = requireAdminPin(
          db,
          validation.data.secondApproverId,
          validation.data.secondApproverPin ?? ''
        )
        if (!secondAuthz.success) {
          return { success: false, error: secondAuthz.error }
        }
        secondApproverStaffId = validation.data.secondApproverId
      }

      return commitStockTake(stockTakeDeps(), {
        sessionId: validation.data.sessionId,
        approverStaffId: validation.data.managerId,
        secondApproverStaffId
      })
    }
  )

  /** IPC handler returning the stock-take approval policy. */
  ipcMain.handle('stocktake:get-settings', (): ServiceResult<StockTakeSettings> => {
    return { success: true, data: resolveStockTakeSettings(db) }
  })

  /**
   * IPC handler saving the stock-take approval policy. Requires a
   * re-verified admin Manager PIN — these values decide how much stock
   * one person can move alone.
   */
  ipcMain.handle(
    'stocktake:save-settings',
    (_event, request: unknown): ServiceResult<void> => {
      const validation = validate(stockTakeSettingsSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      const authz = requireAdminPin(db, validation.data.managerId, validation.data.managerPin)
      if (!authz.success) {
        return authz
      }
      try {
        saveStockTakeSettings(db, {
          varianceThresholdKes: validation.data.varianceThresholdKes,
          allowSelfApproval: validation.data.allowSelfApproval,
          expiryHours: validation.data.expiryHours
        })
        return { success: true }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to save stock take settings'
        }
      }
    }
  )

  flushCartOnWindowClose(createWindow())

  /** Re-create a window when the dock icon is clicked on macOS. */
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) flushCartOnWindowClose(createWindow())
  })
})

/**
 * Quit the app when all windows are closed (except on macOS, where the
 * menu bar stays active until Cmd+ Q).
 */
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
