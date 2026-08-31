import { app, BrowserWindow, shell, ipcMain, net, powerMonitor, dialog, session } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { appendFileSync, chmodSync } from 'node:fs'
import { config as loadEnvFile } from 'dotenv'
import electronUpdater from 'electron-updater'

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
import { initAutoUpdater, checkForUpdates } from './services/updater.js'
import type { UpdateStatus } from './services/updater.js'
import { createFileErrorLogger, installGlobalErrorHandlers } from './services/errorHandler.js'
import {
  fetchAllProducts,
  createShopifyClient,
  resolveShopifyStoreUrl,
  validateAndFetchLocations
} from './services/shopify.js'
import { createDatabase } from './services/database.js'
import { DEMO_PRODUCTS } from './services/demoData.js'
import type {
  CheckoutReceipt,
  StaffSummary,
  ShiftRow
} from './services/database.js'
import { MockMpesaProvider } from './services/integrations/mpesa.js'
import type {
  MpesaProvider,
  StkPushRequest,
  StkPushResult,
  ManualCodeVerification,
  ManualCodeVerificationResult
} from './services/integrations/mpesa.js'
import { MockFiscalizationProvider } from './services/integrations/etims.js'
import type { FiscalizationProvider } from './services/integrations/etims.js'
import { RealFiscalizationProvider } from './services/integrations/real-etims-provider.js'
import type { FiscalEndpointPaths } from './services/integrations/real-etims-provider.js'
import { voidLocalOrder } from './services/voids.js'
import {
  validate,
  checkoutRequestSchema,
  voidOrderSchema,
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
  locationSetSchema
} from './lib/ipcValidator.js'
import { requireAdminPin } from './lib/requireAdminPin.js'
import { restrictToOwnerOnly } from './lib/fileSecurity.js'
import {
  loadSecretVault,
  resolveShopifyToken,
  setSecret,
  getSecret,
  deleteSecret,
  SECRET_SERVICE_NAME,
  SHOPIFY_TOKEN_ACCOUNT
} from './services/secretStore.js'
import type { IntegrationProviderName, PrinterConfig, PrinterType } from './services/database.js'
import { createSyncEngine } from './services/sync-engine.js'
import { createFiscalEngine } from './services/fiscal-engine.js'
import { createNetworkMonitor } from './services/network.js'
import { pushOrderToShopify } from './services/orders.js'
import {
  printReceiptToType,
  printZReport,
  printTestPage,
  buildPrinterRegistry
} from './services/printer.js'
import type { PrinterSettings, ReceiptPrintResult, PrinterRegistry } from './services/printer.js'
import { hashPin, authenticateStaff } from './services/auth.js'
import { generateZReport, generateDailySummary } from './services/reports.js'
import type { ZReport, DailySummary } from './services/reports.js'
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
    mainWindow.maximize()
  })

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
    storeName: process.env.VITE_STORE_NAME || 'RUBIS',
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
   * while M-Pesa is still mocked, or vice versa. Both **default to
   * mock** when unset (only the literal string `'false'` turns mock
   * off), so a fresh checkout — including this one — never talks to a
   * real Shopify-adjacent integration or physical fiscal device by
   * accident. M-Pesa has no real provider implementation yet (this
   * branch point is ready for a `DarajaMpesaProvider` alongside the
   * mock); `mockMpesaEnabled` currently only gates whether checkout
   * verifies a manually-entered M-Pesa code at all, not which provider
   * class is used. eTIMS's `mockEtimsEnabled` does select the provider
   * class: `MockFiscalizationProvider` or a real,
   * `RealFiscalizationProvider` talking to the local ZFPLabServer over
   * HTTP (its base URL comes from the `integrations` table). Either
   * way, a fiscalization failure is queued for retry rather than
   * blocking the sale (see the `orders:checkout` handler below).
   */
  const mockMpesaEnabled = process.env.VITE_USE_MOCK_MPESA !== 'false'
  const mockEtimsEnabled = process.env.VITE_USE_MOCK_ETIMS !== 'false'
  const mpesaProvider: MpesaProvider = new MockMpesaProvider()
  const etimsConfig = db.getIntegrationConfig<{
    baseUrl?: string
    endpoints?: Partial<FiscalEndpointPaths>
    defaultVatClass?: string
    password?: string
  }>('etims')
  const fiscalizationProvider: FiscalizationProvider = mockEtimsEnabled
    ? new MockFiscalizationProvider()
    : new RealFiscalizationProvider({
        baseUrl: etimsConfig.baseUrl,
        endpoints: etimsConfig.endpoints,
        defaultVatClass: etimsConfig.defaultVatClass,
        password: etimsConfig.password,
        lookupInvoice: (invoiceNumber) => {
          const order = db.getOrderByFiscalInvoiceNumber(invoiceNumber)
          if (!order?.fiscal_invoice_number) return undefined
          return {
            invoiceNumber: order.fiscal_invoice_number,
            qrCode: order.fiscal_qr_code ?? '',
            fiscalizedAt: order.fiscal_fiscalized_at ?? order.created_at
          }
        }
      })
  console.log(
    `[DEBUG-ETIMS] Startup: mockMpesaEnabled = ${mockMpesaEnabled}, mockEtimsEnabled = ${mockEtimsEnabled}`
  )
  console.log(
    mockEtimsEnabled
      ? '[DEBUG-ETIMS] Startup: using MockFiscalizationProvider'
      : `[DEBUG-ETIMS] Startup: using RealFiscalizationProvider, baseUrl = ${etimsConfig.baseUrl ?? '(default) http://localhost:4444'}, endpoints = ${JSON.stringify(etimsConfig.endpoints)}`
  )

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
      return pushOrderToShopify(createShopifyClient(env.storeUrl, env.token), payload)
    },
    intervalMs: 30_000
  })

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
    intervalMs: 30_000
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
      if (online) {
        engine.notifyOnline()
        fiscalEngine.notifyOnline()
      }
    }
  })

  powerMonitor.on('resume', () => monitor.checkNow())
  monitor.start()
  engine.start()
  fiscalEngine.start()

  app.on('will-quit', () => {
    engine.stop()
    fiscalEngine.stop()
    monitor.stop()
    db.close()
  })

  /**
   * IPC handler for the renderer `ping()` test channel.
   * Returns a simple pong string to verify the bridge works.
   */
  ipcMain.handle('ping', () => 'pong')

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
      const t0 = Date.now()
      const elapsed = (): string => `+${Date.now() - t0}ms`
      try {
        console.log(`[DEBUG-ETIMS] ========== CHECKOUT STARTED ========== ${elapsed()}`)
        console.log(
          `[DEBUG-ETIMS] 1. mockMpesaEnabled = ${mockMpesaEnabled}, mockEtimsEnabled = ${mockEtimsEnabled}`
        )

        console.log('[DEBUG-ETIMS] 2. Getting eTIMS config...')
        const etimsConfig = db.getIntegrationConfig('etims')
        console.log('[DEBUG-ETIMS] 3. Config:', etimsConfig, elapsed())

        console.log('[DEBUG-ETIMS] 4. Request payload:', JSON.stringify(request, null, 2))

        const validation = validate(checkoutRequestSchema, request)
        if (!validation.success) {
          return { success: false, error: validation.error }
        }
        const checkout = validation.data
        const { items, total } = checkout

        const staff = db.getStaffById(checkout.staffId)
        if (!staff) {
          return { success: false, error: 'No staff member is logged in' }
        }

        /**
         * When paying by M-Pesa manual code entry (a reference number was
         * captured at the till rather than via a completed STK Push), the
         * code is verified before the order is persisted — an unverified
         * code should never reach the ledger as a completed sale.
         */
        if (mockMpesaEnabled && checkout.paymentMethod === 'mpesa' && checkout.referenceNumber) {
          const verification = await mpesaProvider.verifyTransactionCode({
            transactionCode: checkout.referenceNumber,
            amount: total
          })
          if (!verification.success) {
            return { success: false, error: verification.error ?? 'M-Pesa verification failed' }
          }
          if (!verification.data?.verified) {
            return {
              success: false,
              error: verification.data?.reason ?? 'M-Pesa transaction code could not be verified'
            }
          }
        }

        const openShift = db.getOpenShift()
        const clientOrderUuid = randomUUID()

        console.log('[DEBUG-ETIMS] 5. About to call db.queueOrder...')
        const { localId } = db.queueOrder({
          items,
          total,
          clientOrderUuid,
          staffId: staff.id,
          staffName: staff.name,
          paymentMethod: checkout.paymentMethod,
          tenderedAmount: checkout.tenderedAmount,
          changeDue: checkout.changeDue,
          referenceNumber: checkout.referenceNumber,
          shiftId: openShift?.id,
          customerPin: checkout.customerPin,
          cartDiscount: checkout.cartDiscount
        })
        console.log('[DEBUG-ETIMS] 6. db.queueOrder result: SUCCESS, localId =', localId, elapsed())

        console.log(
          '[DEBUG-ETIMS] 6b. Kicking off Shopify sync tick (non-blocking). monitor.isOnline() =',
          monitor.isOnline(),
          elapsed()
        )
        if (monitor.isOnline()) {
          void engine
            .tick()
            .then(() => console.log('[DEBUG-ETIMS] 6c. Background Shopify sync tick finished', elapsed()))
            .catch((tickError) => {
              console.error('[DEBUG-ETIMS] Shopify sync tick failed:', tickError)
            })
        }

        const order = db.getOrder(localId)
        const synced = order?.status === 'synced'
        console.log('[DEBUG-ETIMS] 6d. db.getOrder read back, status =', order?.status, elapsed())

        /**
         * Fiscalization never blocks the sale — the cash/stock side of
         * the transaction is already committed. An immediate failure
         * (device unreachable, rejected request, or an unexpected
         * throw) queues the same request in `sync_queue` for
         * `fiscalEngine` to retry in the background instead of losing
         * it, mirroring how a failed Shopify push falls back to
         * `sync_queue` above rather than failing checkout.
         */
        let fiscal: CheckoutReceipt['fiscal']
        console.log(`[DEBUG-ETIMS] ========== ATTEMPTING FISCALIZATION ========== ${elapsed()}`)
        console.log(
          '[DEBUG-ETIMS] 7. Checking fiscalizationProvider:',
          typeof fiscalizationProvider
        )
        if (!fiscalizationProvider) {
          console.error('[DEBUG-ETIMS] CRITICAL: fiscalizationProvider is UNDEFINED!')
        }

        let fiscalRequest: Parameters<typeof fiscalizationProvider.submitInvoice>[0] | undefined
        try {
          console.log('[DEBUG-ETIMS] 8. Building fiscalRequest...')
          fiscalRequest = {
            clientOrderUuid,
            items: items.map((item) => ({
              description: item.title,
              quantity: item.quantity,
              unitPrice: item.price,
              taxRate: printerSettings.taxRate,
              pluCode: item.id
            })),
            total,
            taxAmount: total * printerSettings.taxRate,
            paymentMethod: checkout.paymentMethod,
            amountTendered: checkout.tenderedAmount,
            buyerPin: checkout.customerPin
          }
          console.log(
            '[DEBUG-ETIMS] 9. fiscalRequest built successfully:',
            JSON.stringify(fiscalRequest, null, 2)
          )

          console.log(`[DEBUG-ETIMS] 10. Attempting fiscalizationProvider.submitInvoice... ${elapsed()}`)
          const invoice = await fiscalizationProvider.submitInvoice(fiscalRequest)
          console.log(
            '[DEBUG-ETIMS] 11. Fiscalization result:',
            JSON.stringify(invoice, null, 2),
            elapsed()
          )

          if (invoice.success && invoice.data) {
            console.log('[DEBUG-ETIMS] 12. Saving fiscal info to DB...')
            fiscal = { invoiceNumber: invoice.data.invoiceNumber, qrCode: invoice.data.qrCode }
            db.setOrderFiscalInfo(localId, invoice.data.invoiceNumber, invoice.data.qrCode)
            console.log('[DEBUG-ETIMS] 13. Fiscal info saved successfully.')
          } else {
            console.warn(
              '[rubis-pos] eTIMS fiscalization failed, queued for retry:',
              invoice.error
            )
            db.queueFiscalInvoice(localId, fiscalRequest)
            fiscalEngine.onCheckoutMade()
          }
        } catch (fiscalError) {
          console.error('[DEBUG-ETIMS] CRITICAL: Fiscalization threw an unhandled exception!')
          console.error(
            '[DEBUG-ETIMS] Error name:',
            fiscalError instanceof Error ? fiscalError.name : typeof fiscalError
          )
          console.error(
            '[DEBUG-ETIMS] Error message:',
            fiscalError instanceof Error ? fiscalError.message : String(fiscalError)
          )
          console.error(
            '[DEBUG-ETIMS] Stack trace:',
            fiscalError instanceof Error ? fiscalError.stack : undefined
          )

          try {
            db.queueFiscalInvoice(
              localId,
              fiscalRequest ?? {
                clientOrderUuid,
                items: items.map((item) => ({
                  description: item.title,
                  quantity: item.quantity,
                  unitPrice: item.price,
                  taxRate: printerSettings.taxRate,
                  pluCode: item.id
                })),
                total,
                taxAmount: total * printerSettings.taxRate,
                paymentMethod: checkout.paymentMethod,
                amountTendered: checkout.tenderedAmount,
                buyerPin: checkout.customerPin
              }
            )
            fiscalEngine.onCheckoutMade()
            console.log('[DEBUG-ETIMS] Fallback: Order queued for fiscalization despite error.')
          } catch (queueError) {
            console.error('[DEBUG-ETIMS] Fallback queue also failed:', queueError)
          }
        }

        return {
          success: true,
          data: {
            localId,
            mode: synced ? 'synced' : 'queued-offline',
            shopifyOrderId: synced
              ? (order?.shopify_order_id ?? undefined)
              : undefined,
            fiscal
          }
        }
      } catch (err) {
        console.error('[DEBUG-ETIMS] CRITICAL: Unhandled exception in checkout!')
        console.error('[DEBUG-ETIMS] Error name:', err instanceof Error ? err.name : typeof err)
        console.error(
          '[DEBUG-ETIMS] Error message:',
          err instanceof Error ? err.message : String(err)
        )
        console.error('[DEBUG-ETIMS] Stack trace:', err instanceof Error ? err.stack : undefined)
        return {
          success: false,
          error:
            err instanceof Error ? err.message : 'Failed to record checkout'
        }
      }
    }
  )

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
   * IPC handler that reads a provider's stored integration config
   * for the Admin screen's Integrations panel.
   */
  ipcMain.handle(
    'integrations:get-config',
    (_event, provider: IntegrationProviderName): ServiceResult<Record<string, unknown>> => {
      try {
        return { success: true, data: db.getIntegrationConfig(provider) }
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
      try {
        db.setIntegrationConfig(validation.data.provider, validation.data.config)
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
   * IPC handler that lists every configured printer for the
   * Admin screen's Peripherals tab.
   */
  ipcMain.handle(
    'printers:list',
    (): ServiceResult<PrinterConfig[]> => {
      try {
        return { success: true, data: db.getPrinters() }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to load printers'
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
          enabled: validation.data.enabled
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
   * IPC handler that sends a test page to a given printer interface
   * — read-only diagnostic, no manager re-authorization
   * needed (see `printerTestSchema`).
   */
  ipcMain.handle(
    'printers:test',
    async (_event, request: unknown): Promise<ServiceResult<ReceiptPrintResult>> => {
      const validation = validate(printerTestSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
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
   * Fetches this till's already-resolved Shopify store URL/token
   * (nothing re-entered) and returns its available locations for the
   * location-confirmation screen (both first-run onboarding and the
   * post-login gate). Read-only — no manager PIN required, mirrors
   * `config:validate`'s risk class.
   */
  ipcMain.handle(
    'location:list',
    async (): Promise<
      ServiceResult<{ shopName: string; locations: { id: string; name: string }[] }>
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
    ): Promise<ServiceResult<{ shopName: string; locations: { id: string; name: string }[] }>> => {
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
   * IPC handler that voids a local `pending_sync` order —
   * reverses inventory, marks the order `voided`, and drops it from
   * the sync queue. Manager PIN authorization is enforced in the
   * renderer before this channel is invoked (see PaymentModal/
   * OrderHistory's use of `auth:login`); the main process itself does
   * not re-check role here, matching how `shifts:*` trusts the caller
   * has already gated the action in the UI.
   */
  ipcMain.handle(
    'orders:void',
    (_event, request: unknown): ServiceResult<{ localId: number; voidedAt: string }> => {
      const validation = validate(voidOrderSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      try {
        return voidLocalOrder(db, validation.data)
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to void order' }
      }
    }
  )

  /**
   * Lets the renderer read connectivity synchronously at startup,
   * before the first `network:status` event has fired.
   */
  ipcMain.handle('network:get-status', () => ({
    online: monitor.isOnline()
  }))

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
   * IPC handler that prints (or, in mock mode, logs) either a local
   * order's receipt or — when `isZReport` is set — a shift's Z-report.
   * Reconstructs receipt line items from the order's stored
   * offline-order payload.
   */
  ipcMain.handle(
    'receipt:print',
    async (
      _event,
      request: {
        localId?: number
        shiftId?: number
        isZReport?: boolean
        printerType?: PrinterType
      }
    ): Promise<ServiceResult<ReceiptPrintResult>> => {
      if (request?.isZReport) {
        if (!request.shiftId) {
          return { success: false, error: 'No shift specified for Z-report' }
        }
        try {
          const report = generateZReport(db, request.shiftId, printerSettings.taxRate)
          return await printZReport(report, printerSettings)
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : 'Failed to print Z-report'
          }
        }
      }

      const localId = request?.localId
      if (!localId) {
        return { success: false, error: 'No order specified' }
      }

      const order = db.getOrder(localId)
      if (!order) {
        return { success: false, error: `Order ${localId} not found` }
      }

      try {
        const payload = JSON.parse(order.payload_json) as OfflineOrderPayload
        return await printReceiptToType(
          {
            localId: order.local_id,
            createdAt: order.created_at,
            cashierName: payload.staffName,
            paymentMethod: payload.paymentMethod,
            tenderedAmount: payload.tenderedAmount,
            changeDue: payload.changeDue,
            referenceNumber: payload.referenceNumber,
            customerPin: payload.customerPin,
            fiscalInvoiceNumber: order.fiscal_invoice_number ?? undefined,
            fiscalQrCode: order.fiscal_qr_code ?? undefined
          },
          payload.lineItems.map((line) => ({
            title: line.title,
            variantTitle: line.variantTitle ?? '',
            quantity: line.quantity,
            unitPrice: line.unitPrice
          })),
          printerRegistry,
          printerSettings,
          request.printerType ?? 'receipt'
        )
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
    (
      _event,
      request: { staffId: number; startingCash: number }
    ): ServiceResult<{ shiftId: number }> => {
      try {
        const data = db.openShift(request?.staffId, Number(request?.startingCash) || 0)
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
    (
      _event,
      request: { shiftId: number; endingCash: number }
    ): ServiceResult<{ expectedCash: number; discrepancy: number }> => {
      try {
        const data = db.closeShift(request?.shiftId, Number(request?.endingCash) || 0)
        return { success: true, data }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to close shift'
        }
      }
    }
  )

  /**
   * IPC handler that generates the Z-report for a shift.
   */
  ipcMain.handle(
    'reports:z-report',
    (_event, shiftId: number): ServiceResult<ZReport> => {
      try {
        return { success: true, data: generateZReport(db, shiftId, printerSettings.taxRate) }
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
   */
  ipcMain.handle(
    'reports:daily-summary',
    (): ServiceResult<DailySummary> => {
      try {
        return { success: true, data: generateDailySummary(db, printerSettings.taxRate) }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to generate daily summary'
        }
      }
    }
  )

  /**
   * IPC handler for the app version (used by @electron-toolkit/preload).
   */
  ipcMain.handle('app:get-version', () => app.getVersion())

  /**
   * Auto-update wiring: pushes each status change to every
   * open window as `updater:status`, driving the renderer's toast.
   */
  initAutoUpdater(autoUpdater, (status: UpdateStatus) => broadcast('updater:status', status))

  /**
   * IPC handler that triggers an update check, invoked from the Admin
   * screen's "Check for Updates" button.
   */
  ipcMain.handle('updater:check', async (): Promise<ServiceResult<void>> => {
    await checkForUpdates(autoUpdater)
    return { success: true }
  })

  /**
   * IPC handler that restarts the app to apply a downloaded update.
   */
  ipcMain.handle('updater:install', (): ServiceResult<void> => {
    autoUpdater.quitAndInstall()
    return { success: true }
  })

  createWindow()

  /** Re-create a window when the dock icon is clicked on macOS. */
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

/**
 * Quit the app when all windows are closed (except on macOS, where the
 * menu bar stays active until Cmd+ Q).
 */
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
