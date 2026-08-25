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
  fetchFirstLocation,
  createShopifyClient
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
import { voidLocalOrder } from './services/voids.js'
import {
  validate,
  checkoutRequestSchema,
  voidOrderSchema,
  loginRequestSchema,
  staffCreateSchema,
  staffResetPinSchema,
  integrationsSetConfigSchema
} from './lib/ipcValidator.js'
import { requireAdminPin } from './lib/requireAdminPin.js'
import { restrictToOwnerOnly } from './lib/fileSecurity.js'
import {
  loadSecretVault,
  resolveShopifyToken,
  setSecret,
  getSecret,
  SECRET_SERVICE_NAME,
  SHOPIFY_TOKEN_ACCOUNT
} from './services/secretStore.js'
import type { IntegrationProviderName } from './services/database.js'
import { createSyncEngine } from './services/sync-engine.js'
import { createNetworkMonitor } from './services/network.js'
import { pushOrderToShopify } from './services/orders.js'
import { printReceipt, printZReport } from './services/printer.js'
import type { PrinterSettings, ReceiptPrintResult } from './services/printer.js'
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
   * Strict Content-Security-Policy (Phase 5.1 hardening): enforced at the
   * session level so it applies to every response the app loads, not just
   * the initial document — belt-and-braces alongside the BrowserWindow's
   * `webSecurity`/`sandbox` config in `window-factory.ts`.
   *
   * In dev (`electron-vite dev`, unpackaged, `ELECTRON_RENDERER_URL` set),
   * the relaxed {@link buildDevContentSecurityPolicy} is used instead —
   * required for `@vitejs/plugin-react`'s inline Fast Refresh preamble
   * script and the dev server's own origin/WS socket (Phase 14 fix; see
   * docs/phase-14.md). A packaged build never sets `ELECTRON_RENDERER_URL`,
   * so this always resolves to the strict policy in production.
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
   * Global crash safety net (Phase 8): logs uncaught errors, unhandled
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

  /* ── Phase 3 services: SQLite, sync engine, connectivity ───── */

  const dbPath = join(app.getPath('userData'), 'rubis-pos.db')
  const db = createDatabase({ dbPath })
  db.init()

  /**
   * Restricts the SQLite file to owner-only access (Phase 12, Task 4).
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
   * Demo Mode (Phase 11, Task 3): when `VITE_DEMO_MODE=true`, the
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
   * Secure secret storage (Phase 12, Task 1; vault backend replaced by
   * Electron's `safeStorage` in Phase 14 — see `secretStore.ts`): the
   * Shopify Admin API token is resolved from the OS-encrypted vault,
   * never read from `process.env` directly once resolved. In dev, a
   * missing vault entry falls back to `.env` once and is persisted
   * into the vault so every later launch is vault-only — see
   * `secretStore.ts`'s `resolveShopifyToken` (Q1 default). Cached in a
   * mutable binding so `secrets:set-shopify-token` (below) can update
   * it mid-session without a restart.
   */
  const keytar = await loadSecretVault()
  let shopifyToken = (
    await resolveShopifyToken({
      keytar,
      isDev: !app.isPackaged,
      envToken: process.env.VITE_SHOPIFY_ADMIN_API_TOKEN
    })
  ).token

  /**
   * Builds a Shopify client from the resolved store URL + vault-backed
   * token; returns null when either is missing. The store URL is not
   * a secret (a public shop domain) so it's read from `.env` directly.
   */
  const shopifyEnv = () => {
    const storeUrl = process.env.VITE_SHOPIFY_STORE_URL
    const token = shopifyToken
    return storeUrl && token ? { storeUrl, token } : null
  }

  /**
   * Resolves the Shopify location ID for inventory scoping.
   * Priority: env var → settings table → auto-detect from Shopify.
   */
  let locationId = process.env.VITE_SHOPIFY_LOCATION_ID
  if (!locationId) {
    locationId = db.getSetting('location_id') ?? undefined
  }
  if (!locationId) {
    const env = shopifyEnv()
    if (env) {
      const client = createShopifyClient(env.storeUrl, env.token)
      fetchFirstLocation(client).then((loc) => {
        if (loc) {
          locationId = loc.id
          db.setSetting('location_id', loc.id)
          console.warn(
            `[rubis-pos] No VITE_SHOPIFY_LOCATION_ID set; using first location: ${loc.name} (${loc.id})`
          )
        }
      }).catch(() => {
        console.warn('[rubis-pos] Could not auto-detect location')
      })
    }
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
   * M-Pesa / eTIMS integrations (Phase 9 — placeholders). Only mock
   * implementations exist so far, so `VITE_USE_MOCK_INTEGRATIONS`
   * currently gates whether checkout calls them at all rather than
   * choosing between a mock and a real backend — that branch point is
   * ready for Phase 10 to add a `DarajaMpesaProvider` /
   * `EtimsMiddlewareProvider` alongside the mocks without touching this
   * wiring.
   */
  const integrationsEnabled = process.env.VITE_USE_MOCK_INTEGRATIONS === 'true'
  const mpesaProvider: MpesaProvider = new MockMpesaProvider()
  const fiscalizationProvider: FiscalizationProvider = new MockFiscalizationProvider()

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
      if (online) engine.notifyOnline()
    }
  })

  powerMonitor.on('resume', () => monitor.checkNow())
  monitor.start()
  engine.start()

  app.on('will-quit', () => {
    engine.stop()
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
            'Shopify credentials missing — add VITE_SHOPIFY_STORE_URL and VITE_SHOPIFY_ADMIN_API_TOKEN to your .env file'
        }
      }

      const result = await fetchAllProducts(env.storeUrl, env.token, {
        locationId
      })

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
   * Checkout entry point (Phase 3).
   *
   * Always persists the sale locally (`orders` + `sync_queue`), then —
   * if currently online — attempts an immediate sync before answering,
   * so the receipt can say "synced" instead of "queued".
   */
  ipcMain.handle(
    'orders:checkout',
    async (_event, request: unknown): Promise<ServiceResult<CheckoutReceipt>> => {
      const validation = validate(checkoutRequestSchema, request)
      if (!validation.success) {
        return { success: false, error: validation.error }
      }
      const checkout = validation.data
      const { items, total } = checkout

      try {
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
        if (integrationsEnabled && checkout.paymentMethod === 'mpesa' && checkout.referenceNumber) {
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
          cartDiscount: checkout.cartDiscount
        })

        if (monitor.isOnline()) {
          await engine.tick()
        }

        const order = db.getOrder(localId)
        const synced = order?.status === 'synced'

        /**
         * Fiscalization runs best-effort: a failure here logs and is
         * omitted from the receipt rather than blocking the sale — the
         * cash/stock side of the transaction is already committed, and a
         * real middleware would store-and-forward this invoice for retry
         * (see docs/phase-9.md §2) rather than fail the till.
         */
        let fiscal: CheckoutReceipt['fiscal']
        if (integrationsEnabled) {
          const invoice = await fiscalizationProvider.submitInvoice({
            clientOrderUuid,
            items: items.map((item) => ({
              description: item.title,
              quantity: item.quantity,
              unitPrice: item.price,
              taxRate: printerSettings.taxRate
            })),
            total,
            taxAmount: total * printerSettings.taxRate
          })
          if (invoice.success && invoice.data) {
            fiscal = { invoiceNumber: invoice.data.invoiceNumber, qrCode: invoice.data.qrCode }
          } else {
            console.error('[rubis-pos] eTIMS fiscalization failed:', invoice.error)
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
   * half of the hybrid flow in docs/phase-9.md §2). Standalone from
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
   * (Phase 9's `integrations` table) for the Admin screen's
   * Integrations panel.
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
   * re-verified admin Manager PIN (Phase 14) — routing Paybill/Till
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
   * IPC handler that reports whether a Shopify Admin API token is
   * currently stored in the credential vault — never the token value
   * itself (Phase 12, Task 1). Lets the Admin screen show "Configured"
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
   * IPC handler that voids a local `pending_sync` order (Phase 10) —
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
      request: { localId?: number; shiftId?: number; isZReport?: boolean }
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
        return await printReceipt(
          {
            localId: order.local_id,
            createdAt: order.created_at,
            cashierName: payload.staffName,
            paymentMethod: payload.paymentMethod,
            tenderedAmount: payload.tenderedAmount,
            changeDue: payload.changeDue,
            referenceNumber: payload.referenceNumber
          },
          payload.lineItems.map((line) => ({
            title: line.title,
            variantTitle: line.variantTitle ?? '',
            quantity: line.quantity,
            unitPrice: line.unitPrice
          })),
          printerSettings
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
   * Requires a re-verified admin Manager PIN (Phase 14) — creating an
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
   * Requires a re-verified admin Manager PIN (Phase 14) — resetting
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
   * starting cash float. Fails if a shift is already open (one shift
   * at a time — see Q3 in phase-7.md).
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
   * Auto-update wiring (Phase 8): pushes each status change to every
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
