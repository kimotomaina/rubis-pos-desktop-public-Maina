/**
 * Local SQLite database service.
 *
 * Owns the three persistence concerns of the POS:
 *   1. `products`    — last-good product catalog cache (offline browsing)
 *   2. `orders`      — ledger of every checkout made on this terminal
 *   3. `sync_queue`  — pending Shopify pushes with retry/backoff metadata
 *
 * The connection is created through an injectable factory so unit tests
 * can substitute a recording fake without touching the native module.
 */

import BetterSqlite3 from 'better-sqlite3'
import type { Database as SqliteConnection } from 'better-sqlite3'
import type { Discount, OfflineOrderPayload } from './shopify-types.js'
import type { CartItem, ProductSummary } from '../../renderer/src/types/shopify.js'

/** Lifecycle states of a local order row. */
export type OrderStatus = 'pending_sync' | 'synced' | 'failed' | 'voided'

/** Accepted payment methods at checkout. */
export type PaymentMethod = 'cash' | 'mpesa' | 'card'

/** Row shape of the `orders` table. */
export interface OrderRow {
  local_id: number
  shopify_order_id: string | null
  total: number
  status: OrderStatus
  created_at: string
  payload_json: string
  staff_id: number | null
  payment_method: PaymentMethod | null
  tendered_amount: number | null
  change_due: number | null
  reference_number: string | null
  shift_id: number | null
}

/** Role assignable to a staff account. */
export type StaffRole = 'admin' | 'cashier'

/** Full `staff` row, including the PIN hash — main-process only, never sent to the renderer. */
export interface StaffRow {
  id: number
  name: string
  pin_hash: string
  role: StaffRole
  is_active: number
}

/** Renderer-safe view of a staff account (no `pin_hash`). */
export interface StaffSummary {
  id: number
  name: string
  role: StaffRole
}

/** Lifecycle status of a till/register shift. */
export type ShiftStatus = 'open' | 'closed'

/**
 * Row shape of the `shifts` table — a store-wide till/register
 * session (only one may be `open` at a time), not a per-staff
 * attendance record.
 */
export interface ShiftRow {
  id: number
  staff_id: number
  clock_in: string
  clock_out: string | null
  starting_cash: number
  expected_cash: number | null
  ending_cash: number | null
  discrepancy: number | null
  status: ShiftStatus
}

/** Row shape of the `sync_queue` table. */
export interface SyncQueueRow {
  id: number
  entity_type: string
  entity_id: number
  action: string
  payload_json: string
  attempts: number
  last_error: string | null
  created_at: string
  next_attempt_at: number
}

/** A sync-queue row with its JSON payload parsed into a typed object. */
export interface SyncQueueItem extends Omit<SyncQueueRow, 'payload_json'> {
  payload: OfflineOrderPayload
}

/** Shape passed into {@link RubisDatabase.queueOrder}. */
export interface QueueOrderInput {
  items: CartItem[]
  total: number
  clientOrderUuid: string
  staffId: number
  staffName: string
  paymentMethod: PaymentMethod
  tenderedAmount: number
  changeDue: number
  referenceNumber?: string
  shiftId?: number
  /** Cart-level discount, applied on top of the line-item subtotal. */
  cartDiscount?: Discount
}

/** Fiscal (eTIMS) details attached to a receipt once submitted for fiscalization. */
export interface CheckoutFiscalInfo {
  invoiceNumber: string
  qrCode: string
}

/** Receipt returned to the renderer after a checkout attempt. */
export interface CheckoutReceipt {
  localId: number
  mode: 'synced' | 'queued-offline'
  shopifyOrderId?: string
  /** Present when eTIMS fiscalization was attempted and succeeded. */
  fiscal?: CheckoutFiscalInfo
}

/** Payload the renderer sends to `orders:checkout`. */
export interface CheckoutRequest {
  items: CartItem[]
  total: number
  staffId: number
  paymentMethod: PaymentMethod
  tenderedAmount: number
  changeDue: number
  referenceNumber?: string
  shiftId?: number
  cartDiscount?: Discount
}

/** Base delay for exponential backoff between sync attempts. */
export const SYNC_BACKOFF_BASE_MS = 30_000

/** Upper bound on backoff (30 minutes). */
export const SYNC_BACKOFF_CAP_MS = 30 * 60_000

/** Attempts after which an order is marked `failed` and left for review. */
export const SYNC_MAX_ATTEMPTS = 10

/**
 * Computes the exponential backoff delay before retry attempts.
 *
 * `attemptNumber` is the count of *failed* attempts so far (1-based):
 * 1 → 30 s, 2 → 60 s, 3 → 120 s, ... capped at 30 minutes.
 *
 * @param {number} attemptNumber
 * @returns {number} delay in milliseconds
 */
export function computeBackoffMs(attemptNumber: number): number {
  const safe = Math.max(1, Math.floor(attemptNumber))
  return Math.min(SYNC_BACKOFF_BASE_MS * 2 ** (safe - 1), SYNC_BACKOFF_CAP_MS)
}

/**
 * DDL for all database tables.  Kept as named constants so tests can
 * assert the exact schema statements executed at startup.
 */
export const SCHEMA = {
  products: `CREATE TABLE IF NOT EXISTS products (
    id TEXT NOT NULL,
    title TEXT NOT NULL,
    variant_id TEXT PRIMARY KEY,
    variant_title TEXT NOT NULL DEFAULT '',
    price REAL NOT NULL,
    inventory_quantity INTEGER NOT NULL,
    image_url TEXT,
    barcode TEXT
  )`,
  orders: `CREATE TABLE IF NOT EXISTS orders (
    local_id INTEGER PRIMARY KEY AUTOINCREMENT,
    shopify_order_id TEXT,
    total REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending_sync' CHECK (status IN ('pending_sync', 'synced', 'failed', 'voided')),
    created_at TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    staff_id INTEGER,
    payment_method TEXT,
    tendered_amount REAL,
    change_due REAL,
    reference_number TEXT,
    shift_id INTEGER
  )`,
  syncQueue: `CREATE TABLE IF NOT EXISTS sync_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    next_attempt_at INTEGER NOT NULL DEFAULT 0
  )`,
  queueIndex: `CREATE INDEX IF NOT EXISTS idx_sync_queue_next_attempt ON sync_queue (next_attempt_at)`,
  barcodeIndex: `CREATE INDEX IF NOT EXISTS idx_products_barcode ON products (barcode)`,
  settings: `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  staff: `CREATE TABLE IF NOT EXISTS staff (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    pin_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'cashier' CHECK (role IN ('admin', 'cashier')),
    is_active INTEGER NOT NULL DEFAULT 1
  )`,
  shifts: `CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id INTEGER NOT NULL,
    clock_in TEXT NOT NULL,
    clock_out TEXT,
    starting_cash REAL NOT NULL DEFAULT 0,
    expected_cash REAL,
    ending_cash REAL,
    discrepancy REAL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed'))
  )`,
  integrations: `CREATE TABLE IF NOT EXISTS integrations (
    provider TEXT PRIMARY KEY,
    config_json TEXT NOT NULL DEFAULT '{}'
  )`,
  printers: `CREATE TABLE IF NOT EXISTS printers (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('receipt', 'kitchen', 'label')),
    interface TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1
  )`
} as const

/** Options accepted by {@link createDatabase}. */
export interface DatabaseOptions {
  /** Absolute path of the SQLite file. */
  dbPath: string
  /** Alternate constructor for tests (defaults to better-sqlite3). */
  DatabaseFactory?: typeof BetterSqlite3
  /** Attempts before an order is abandoned as `failed`. */
  maxAttempts?: number
}

/** Integration providers configurable via the `integrations` table. */
export type IntegrationProviderName = 'mpesa' | 'etims'

/**
 * Printer role a configured printer serves. `'receipt'` is the customer-facing till
 * printer; `'kitchen'`/`'label'` are additional stations a store can
 * register without any code change.
 */
export type PrinterType = 'receipt' | 'kitchen' | 'label'

/** One configured printer, as read from / written to the `printers` table. */
export interface PrinterConfig {
  /** Stable identifier the Admin screen and printer registry key on. */
  id: string
  type: PrinterType
  /** `tcp://<ip>:<port>` address, matching `PrinterSettings.interfaceName`. */
  interfaceName: string
  /** Disabled printers are skipped by registry lookups without deleting the row. */
  enabled: boolean
}

/** Raw `printers` row shape, before {@link PrinterConfig}'s boolean/name normalization. */
interface PrinterRow {
  id: string
  type: PrinterType
  interface: string
  enabled: number
}

/** Outcome of recording a failed sync attempt. */
export interface SyncFailureResult {
  /** True when the item exhausted all retries and was abandoned. */
  exhausted: boolean
  /** Attempts recorded after this failure. */
  attempts: number
}

/**
 * Thin, typed wrapper around the better-sqlite3 connection.
 *
 * All statements are prepared once in {@link RubisDatabase.init} and
 * reused; multi-step writes run inside transactions.
 */
export class RubisDatabase {
  private readonly dbPath: string
  private readonly factory: typeof BetterSqlite3
  private readonly maxAttempts: number
  private connection: SqliteConnection | null = null

  constructor(options: DatabaseOptions) {
    this.dbPath = options.dbPath
    this.factory = options.DatabaseFactory ?? BetterSqlite3
    this.maxAttempts = options.maxAttempts ?? SYNC_MAX_ATTEMPTS
  }

  /**
   * Opens the connection (WAL mode) and creates the schema when absent.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  init(): void {
    if (this.connection) return
    const connection = new this.factory(this.dbPath)
    connection.pragma('journal_mode = WAL')
    connection.pragma('synchronous = NORMAL')
    connection.exec(SCHEMA.products)
    connection.exec(SCHEMA.orders)
    connection.exec(SCHEMA.syncQueue)
    connection.exec(SCHEMA.queueIndex)
    connection.exec(SCHEMA.barcodeIndex)
    connection.exec(SCHEMA.settings)
    connection.exec(SCHEMA.staff)
    connection.exec(SCHEMA.shifts)
    connection.exec(SCHEMA.integrations)
    connection.exec(SCHEMA.printers)
    this.connection = connection
  }

  /** @returns the live connection, throwing when not initialized. */
  private get conn(): SqliteConnection {
    if (!this.connection) {
      throw new Error('Database not initialized — call init() first')
    }
    return this.connection
  }

  /**
   * Replaces the cached product catalog with the given snapshot.
   * Runs as a single transaction (full-replace semantics).
   *
   * @param {ProductSummary[]} products
   */
  cacheProducts(products: ProductSummary[]): void {
    const deleteAll = this.conn.prepare('DELETE FROM products')
    const insert = this.conn.prepare(
      'INSERT OR REPLACE INTO products (id, title, variant_id, variant_title, price, inventory_quantity, image_url, barcode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    const replace = this.conn.transaction((rows: ProductSummary[]) => {
      deleteAll.run()
      for (const product of rows) {
        for (const variant of product.variants) {
          insert.run(
            product.id,
            product.title,
            variant.id,
            variant.title,
            variant.price,
            variant.inventoryQuantity,
            variant.image ?? product.featuredImage,
            variant.barcode
          )
        }
      }
    })
    replace(products)
  }

  /**
   * Empties the cached product catalog — called whenever this till's
   * confirmed location changes, since a cache built for the previous
   * location's assortment/inventory would otherwise be served as the
   * offline fallback until the next successful live fetch.
   */
  clearProductCache(): void {
    this.conn.prepare('DELETE FROM products').run()
  }

  /**
   * Re-hydrates the cached catalog into renderer-facing
   * {@link ProductSummary} objects (grouped by product id).
   *
   * @returns {ProductSummary[]}
   */
  getCachedProducts(): ProductSummary[] {
    const rows = this.conn
      .prepare('SELECT id, title, variant_id, variant_title, price, inventory_quantity, image_url, barcode FROM products')
      .all() as Array<{
      id: string
      title: string
      variant_id: string
      variant_title: string
      price: number
      inventory_quantity: number
      image_url: string | null
      barcode: string | null
    }>

    const byProduct = new Map<string, ProductSummary>()
    for (const row of rows) {
      const productId = row.id.split('/').pop() ?? row.id
      let product = byProduct.get(row.id)
      if (!product) {
        product = {
          id: row.id,
          title: row.title,
          handle: '',
          featuredImage: null,
          variants: []
        }
        byProduct.set(row.id, product)
      }
      product.variants.push({
        id: row.variant_id,
        productId,
        title: row.variant_title,
        price: row.price,
        availableForSale: row.inventory_quantity > 0,
        inventoryQuantity: row.inventory_quantity,
        image: row.image_url,
        barcode: row.barcode
      })
      if (!product.featuredImage && row.image_url) {
        product.featuredImage = row.image_url
      }
    }
    return [...byProduct.values()]
  }

  /**
   * Persists a checkout as a `pending_sync` order plus a `orderCreate`
   * sync-queue entry, atomically.
   *
   * @param {QueueOrderInput} input
   * @returns local order id and queue id
   */
  queueOrder(input: QueueOrderInput): { localId: number; queueId: number } {
    const createdAt = new Date().toISOString()
    const payload: OfflineOrderPayload = {
      clientOrderUuid: input.clientOrderUuid,
      total: input.total,
      createdAt,
      lineItems: input.items.map((item) => ({
        variantId: item.id,
        title: item.title,
        variantTitle: item.variantTitle,
        quantity: item.quantity,
        unitPrice: item.price,
        discount: item.discount
      })),
      staffId: input.staffId,
      staffName: input.staffName,
      paymentMethod: input.paymentMethod,
      tenderedAmount: input.tenderedAmount,
      changeDue: input.changeDue,
      referenceNumber: input.referenceNumber,
      cartDiscount: input.cartDiscount
    }

    const insertOrder = this.conn.prepare(
      'INSERT INTO orders (total, status, created_at, payload_json, staff_id, payment_method, tendered_amount, change_due, reference_number, shift_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    const insertQueue = this.conn.prepare(
      'INSERT INTO sync_queue (entity_type, entity_id, action, payload_json, attempts, created_at, next_attempt_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    const enqueue = this.conn.transaction(() => {
      const orderInfo = insertOrder.run(
        input.total,
        'pending_sync',
        createdAt,
        JSON.stringify(payload),
        input.staffId,
        input.paymentMethod,
        input.tenderedAmount,
        input.changeDue,
        input.referenceNumber ?? null,
        input.shiftId ?? null
      )
      const localId = Number(orderInfo.lastInsertRowid)
      const queueInfo = insertQueue.run(
        'order',
        localId,
        'orderCreate',
        JSON.stringify(payload),
        0,
        createdAt,
        0
      )
      return { localId, queueId: Number(queueInfo.lastInsertRowid) }
    })
    return enqueue()
  }

  /**
   * Returns sync-queue items eligible for pushing (due date reached).
   *
   * @param {number} now — current timestamp in epoch milliseconds
   * @returns {SyncQueueItem[]} oldest first
   */
  getPendingSyncQueue(now: number): SyncQueueItem[] {
    const rows = this.conn
      .prepare(
        'SELECT id, entity_type, entity_id, action, payload_json, attempts, last_error, created_at, next_attempt_at FROM sync_queue WHERE next_attempt_at <= ? ORDER BY id ASC'
      )
      .all(now) as SyncQueueRow[]

    return rows.map((row) => ({
      ...row,
      payload: JSON.parse(row.payload_json) as OfflineOrderPayload
    }))
  }

  /**
   * Reads one order row by its local id.
   *
   * @param {number} localId
   * @returns the order row, or `undefined` when absent
   */
  getOrder(localId: number): OrderRow | undefined {
    return this.conn
      .prepare(
        'SELECT local_id, shopify_order_id, total, status, created_at, payload_json, staff_id, payment_method, tendered_amount, change_due, reference_number, shift_id FROM orders WHERE local_id = ?'
      )
      .get(localId) as OrderRow | undefined
  }

  /**
   * Returns every order recorded against a given shift (any sync
   * status — the cash was collected regardless of Shopify sync outcome).
   *
   * @param {number} shiftId
   * @returns {OrderRow[]}
   */
  getOrdersForShift(shiftId: number): OrderRow[] {
    return this.conn
      .prepare(
        'SELECT local_id, shopify_order_id, total, status, created_at, payload_json, staff_id, payment_method, tendered_amount, change_due, reference_number, shift_id FROM orders WHERE shift_id = ? ORDER BY created_at ASC'
      )
      .all(shiftId) as OrderRow[]
  }

  /**
   * Returns every order created within an ISO-8601 date range
   * (inclusive of `startIso`, exclusive of `endIso`).
   *
   * @param {string} startIso
   * @param {string} endIso
   * @returns {OrderRow[]}
   */
  getOrdersForDateRange(startIso: string, endIso: string): OrderRow[] {
    return this.conn
      .prepare(
        'SELECT local_id, shopify_order_id, total, status, created_at, payload_json, staff_id, payment_method, tendered_amount, change_due, reference_number, shift_id FROM orders WHERE created_at >= ? AND created_at < ? ORDER BY created_at ASC'
      )
      .all(startIso, endIso) as OrderRow[]
  }

  /**
   * Marks a queue item's order as `synced` with the Shopify order id
   * and removes the item from the queue.
   *
   * @param {number} queueId
   * @param {string} shopifyOrderId
   */
  markQueueItemSynced(queueId: number, shopifyOrderId: string): void {
    const row = this.conn
      .prepare('SELECT entity_id FROM sync_queue WHERE id = ?')
      .get(queueId) as { entity_id: number } | undefined
    if (!row) return

    const settle = this.conn.transaction(() => {
      this.conn
        .prepare(
          'UPDATE orders SET status = ?, shopify_order_id = ? WHERE local_id = ?'
        )
        .run('synced', shopifyOrderId, row.entity_id)
      this.conn.prepare('DELETE FROM sync_queue WHERE id = ?').run(queueId)
    })
    settle()
  }

  /**
   * Records a failed push: increments the attempt counter, stores the
   * last error, and schedules the next attempt with exponential backoff.
   * When the attempt budget is exhausted the order is marked `failed`
   * and the queue entry removed.
   *
   * @param {number} queueId
   * @param {string} error — human-readable failure reason
   * @returns {SyncFailureResult}
   */
  recordQueueFailure(queueId: number, error: string): SyncFailureResult {
    const row = this.conn
      .prepare('SELECT id, entity_id, attempts FROM sync_queue WHERE id = ?')
      .get(queueId) as
      | { id: number; entity_id: number; attempts: number }
      | undefined
    if (!row) return { exhausted: true, attempts: this.maxAttempts }

    const attempts = row.attempts + 1
    const settle = this.conn.transaction(() => {
      if (attempts >= this.maxAttempts) {
        this.conn
          .prepare('UPDATE orders SET status = ? WHERE local_id = ?')
          .run('failed', row.entity_id)
        this.conn.prepare('DELETE FROM sync_queue WHERE id = ?').run(queueId)
      } else {
        this.conn
          .prepare(
            'UPDATE sync_queue SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?'
          )
          .run(attempts, error, Date.now() + computeBackoffMs(attempts), queueId)
      }
    })
    settle()
    return { exhausted: attempts >= this.maxAttempts, attempts }
  }

  /**
   * Reads a value from the settings table.
   *
   * @param {string} key
   * @returns {string | undefined}
   */
  getSetting(key: string): string | undefined {
    const row = this.conn
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(key) as { value: string } | undefined
    return row?.value
  }

  /**
   * Upserts a key-value pair in the settings table.
   *
   * @param {string} key
   * @param {string} value
   */
  setSetting(key: string, value: string): void {
    this.conn
      .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(key, value)
  }

  /**
   * Returns local orders sorted by creation date (newest first).
   *
   * @param {number} [limit=50]
   * @param {number} [offset=0]
   * @returns {OrderRow[]}
   */
  getOrders(limit = 50, offset = 0): OrderRow[] {
    return this.conn
      .prepare(
        'SELECT local_id, shopify_order_id, total, status, created_at FROM orders ORDER BY created_at DESC LIMIT ? OFFSET ?'
      )
      .all(limit, offset) as OrderRow[]
  }

  /**
   * Re-queues a failed or pending order for sync by reading its
   * stored payload and creating a fresh sync-queue entry.
   *
   * @param {number} localId
   * @returns {{ queueId: number }}
   * @throws if the order is already synced or does not exist
   */
  retryOrderSync(localId: number): { queueId: number } {
    const order = this.conn
      .prepare('SELECT local_id, status, payload_json FROM orders WHERE local_id = ?')
      .get(localId) as { local_id: number; status: string; payload_json: string } | undefined

    if (!order) {
      throw new Error(`Order ${localId} not found`)
    }
    if (order.status === 'synced') {
      throw new Error(`Order ${localId} is already synced`)
    }

    const createdAt = new Date().toISOString()
    const settle = this.conn.transaction(() => {
      this.conn
        .prepare('UPDATE orders SET status = ? WHERE local_id = ?')
        .run('pending_sync', localId)

      const queueInfo = this.conn
        .prepare(
          'INSERT INTO sync_queue (entity_type, entity_id, action, payload_json, attempts, created_at, next_attempt_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .run('order', localId, 'orderCreate', order.payload_json, 0, createdAt, 0)

      return { queueId: Number(queueInfo.lastInsertRowid) }
    })
    return settle()
  }

  /**
   * Voids a local `pending_sync` order: reverses each line item's
   * quantity back into the cached `products` inventory, marks the
   * order `voided`, and removes any outstanding `sync_queue` entry so
   * a voided sale is never pushed to Shopify after the fact.
   *
   * Restricted to `pending_sync` orders — see `voids.ts` for the
   * caller-facing validation and {@link RubisDatabase.getOrder} for
   * reading the order first. Inventory reversal is best-effort: a
   * variant no longer in the local cache is silently skipped rather
   * than failing the void (the sale is still reversed; the cache will
   * self-correct on the next `products:fetch`).
   *
   * @param {number} localId
   * @returns {{ voidedAt: string }}
   * @throws if the order does not exist or is not `pending_sync`
   */
  voidOrder(localId: number): { voidedAt: string } {
    const order = this.getOrder(localId)
    if (!order) {
      throw new Error(`Order ${localId} not found`)
    }
    if (order.status !== 'pending_sync') {
      throw new Error(
        `Order ${localId} cannot be voided (status: ${order.status}) — only pending_sync orders may be voided`
      )
    }

    const payload = JSON.parse(order.payload_json) as OfflineOrderPayload
    const voidedAt = new Date().toISOString()

    const incrementInventory = this.conn.prepare(
      'UPDATE products SET inventory_quantity = inventory_quantity + ? WHERE variant_id = ?'
    )
    const markVoided = this.conn.prepare('UPDATE orders SET status = ? WHERE local_id = ?')
    const clearQueue = this.conn.prepare(
      "DELETE FROM sync_queue WHERE entity_type = 'order' AND entity_id = ?"
    )

    const settle = this.conn.transaction(() => {
      for (const line of payload.lineItems) {
        incrementInventory.run(line.quantity, line.variantId)
      }
      markVoided.run('voided', localId)
      clearQueue.run(localId)
    })
    settle()

    return { voidedAt }
  }

  /**
   * Returns every active staff account, without PIN hashes — safe to
   * send to the renderer for the login picker.
   *
   * @returns {StaffSummary[]}
   */
  getActiveStaff(): StaffSummary[] {
    return this.conn
      .prepare('SELECT id, name, role FROM staff WHERE is_active = 1 ORDER BY name ASC')
      .all() as StaffSummary[]
  }

  /**
   * Reads one full staff row, including its PIN hash. Main-process
   * only — never forward this to the renderer.
   *
   * @param {number} id
   * @returns the staff row, or `undefined` when absent
   */
  getStaffById(id: number): StaffRow | undefined {
    return this.conn
      .prepare('SELECT id, name, pin_hash, role, is_active FROM staff WHERE id = ?')
      .get(id) as StaffRow | undefined
  }

  /**
   * Counts staff rows, used at startup to decide whether to seed a
   * default account.
   *
   * @returns {number}
   */
  countStaff(): number {
    const row = this.conn
      .prepare('SELECT COUNT(*) as count FROM staff')
      .get() as { count: number }
    return row.count
  }

  /**
   * Inserts a new staff account.
   *
   * @param {object} input
   * @param {string} input.name
   * @param {string} input.pinHash — pre-hashed PIN (see `auth.ts`)
   * @param {StaffRole} input.role
   * @returns {{ staffId: number }}
   */
  createStaff(input: { name: string; pinHash: string; role: StaffRole }): {
    staffId: number
  } {
    const info = this.conn
      .prepare('INSERT INTO staff (name, pin_hash, role, is_active) VALUES (?, ?, ?, 1)')
      .run(input.name, input.pinHash, input.role)
    return { staffId: Number(info.lastInsertRowid) }
  }

  /**
   * Returns the currently open till shift, if any. There is at most
   * one open shift store-wide at any time.
   *
   * @returns the open shift row, or `undefined` when none is open
   */
  getOpenShift(): ShiftRow | undefined {
    return this.conn
      .prepare("SELECT * FROM shifts WHERE status = 'open' ORDER BY id DESC LIMIT 1")
      .get() as ShiftRow | undefined
  }

  /**
   * Reads one shift row by id.
   *
   * @param {number} id
   * @returns the shift row, or `undefined` when absent
   */
  getShiftById(id: number): ShiftRow | undefined {
    return this.conn.prepare('SELECT * FROM shifts WHERE id = ?').get(id) as
      | ShiftRow
      | undefined
  }

  /**
   * Opens a new store-wide till shift with a starting cash float.
   *
   * @param {number} staffId — the staff member opening the shift
   * @param {number} startingCash
   * @returns {{ shiftId: number }}
   * @throws if a shift is already open
   */
  openShift(staffId: number, startingCash: number): { shiftId: number } {
    if (this.getOpenShift()) {
      throw new Error('A shift is already open')
    }
    const info = this.conn
      .prepare(
        "INSERT INTO shifts (staff_id, clock_in, starting_cash, status) VALUES (?, ?, ?, 'open')"
      )
      .run(staffId, new Date().toISOString(), startingCash)
    return { shiftId: Number(info.lastInsertRowid) }
  }

  /**
   * Closes the open shift, computing expected cash (starting cash +
   * total cash-order revenue for the shift, excluding any order later
   * voided — fix for a shift-close bug where a voided cash sale still
   * counted toward the drawer's expected total) and the discrepancy
   * against the counted ending cash.
   *
   * @param {number} shiftId
   * @param {number} endingCash
   * @returns {{ expectedCash: number; discrepancy: number }}
   * @throws if the shift does not exist or is already closed
   */
  closeShift(
    shiftId: number,
    endingCash: number
  ): { expectedCash: number; discrepancy: number } {
    const shift = this.getShiftById(shiftId)
    if (!shift) {
      throw new Error(`Shift ${shiftId} not found`)
    }
    if (shift.status === 'closed') {
      throw new Error(`Shift ${shiftId} is already closed`)
    }

    const cashTotal = this.getOrdersForShift(shiftId)
      .filter((order) => order.payment_method === 'cash' && order.status !== 'voided')
      .reduce((sum, order) => sum + order.total, 0)

    const expectedCash = shift.starting_cash + cashTotal
    const discrepancy = endingCash - expectedCash

    this.conn
      .prepare(
        "UPDATE shifts SET clock_out = ?, expected_cash = ?, ending_cash = ?, discrepancy = ?, status = 'closed' WHERE id = ?"
      )
      .run(new Date().toISOString(), expectedCash, endingCash, discrepancy, shiftId)

    return { expectedCash, discrepancy }
  }

  /**
   * Updates a staff member's PIN hash.
   *
   * @param {number} staffId
   * @param {string} pinHash — pre-hashed PIN (see `auth.ts`)
   * @throws if the staff account does not exist
   */
  resetStaffPin(staffId: number, pinHash: string): void {
    const info = this.conn
      .prepare('UPDATE staff SET pin_hash = ? WHERE id = ?')
      .run(pinHash, staffId)
    if (info.changes === 0) {
      throw new Error(`Staff ${staffId} not found`)
    }
  }

  /**
   * Reads a provider's stored integration config (Paybill/Till numbers,
   * middleware URLs, etc.) — kept in its own table rather than the
   * generic `settings` key-value store so multi-field provider configs
   * stay grouped and typed at the call site.
   *
   * @param {IntegrationProviderName} provider
   * @returns the parsed config object, or `{}` when unconfigured
   */
  getIntegrationConfig<T extends Record<string, unknown> = Record<string, unknown>>(
    provider: IntegrationProviderName
  ): T {
    const row = this.conn
      .prepare('SELECT config_json FROM integrations WHERE provider = ?')
      .get(provider) as { config_json: string } | undefined
    return row ? (JSON.parse(row.config_json) as T) : ({} as T)
  }

  /**
   * Upserts a provider's integration config.
   *
   * @param {IntegrationProviderName} provider
   * @param {Record<string, unknown>} config
   */
  setIntegrationConfig(provider: IntegrationProviderName, config: Record<string, unknown>): void {
    this.conn
      .prepare(
        'INSERT INTO integrations (provider, config_json) VALUES (?, ?) ON CONFLICT(provider) DO UPDATE SET config_json = excluded.config_json'
      )
      .run(provider, JSON.stringify(config))
  }

  /**
   * Lists every configured printer, including disabled ones — callers
   * building a registry filter those out themselves so the Admin
   * screen can still show and re-enable them.
   *
   * @returns {PrinterConfig[]} ordered by `id`
   */
  getPrinters(): PrinterConfig[] {
    const rows = this.conn
      .prepare('SELECT id, type, interface, enabled FROM printers ORDER BY id ASC')
      .all() as PrinterRow[]
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      interfaceName: row.interface,
      enabled: row.enabled === 1
    }))
  }

  /**
   * Upserts one printer configuration by `id`.
   *
   * @param {PrinterConfig} config
   */
  savePrinter(config: PrinterConfig): void {
    this.conn
      .prepare(
        'INSERT INTO printers (id, type, interface, enabled) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(id) DO UPDATE SET type = excluded.type, interface = excluded.interface, enabled = excluded.enabled'
      )
      .run(config.id, config.type, config.interfaceName, config.enabled ? 1 : 0)
  }

  /**
   * Removes one printer configuration.
   *
   * @param {string} id
   * @returns {boolean} `true` if a row was deleted
   */
  deletePrinter(id: string): boolean {
    const info = this.conn.prepare('DELETE FROM printers WHERE id = ?').run(id)
    return info.changes > 0
  }

  /** Closes the underlying connection. Further calls will throw. */
  close(): void {
    this.connection?.close()
    this.connection = null
  }
}

/**
 * Factory for the singleton used by the main process.
 *
 * @param {DatabaseOptions} options
 * @returns {RubisDatabase}
 */
export function createDatabase(options: DatabaseOptions): RubisDatabase {
  return new RubisDatabase(options)
}
