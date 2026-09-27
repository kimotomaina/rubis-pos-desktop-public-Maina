/**
 * Local SQLite database service.
 *
 * Owns the three persistence concerns of the POS:
 *   1. `products`    — last-good product catalog cache (offline browsing)
 *   2. `orders`      — ledger of every checkout made on this terminal
 *   3. `sync_queue`  — pending Shopify pushes AND pending eTIMS
 *      fiscalization retries, distinguished by `entity_type`
 *      (`'order'` vs `'etims_invoice'`), each with its own
 *      retry/backoff metadata
 *
 * The connection is created through an injectable factory so unit tests
 * can substitute a recording fake without touching the native module.
 */

import BetterSqlite3 from 'better-sqlite3'
import type { Database as SqliteConnection } from 'better-sqlite3'
import type { Discount, OfflineOrderPayload } from './shopify-types.js'
import type { CartItem, ProductSummary } from '../../renderer/src/types/shopify.js'
import type { FiscalFailureKind, FiscalInvoiceRequest, FiscalVatGroupAmounts } from './integrations/etims.js'

/** Lifecycle states of a local order row. */
export type OrderStatus = 'pending_sync' | 'synced' | 'failed' | 'voided'

/** Accepted payment methods at checkout. */
export type PaymentMethod = 'cash' | 'mpesa' | 'card'

/**
 * Three-state fiscalization outcome for an order — `null`/absent means
 * "never attempted" (e.g. the mock provider, or a checkout that hasn't
 * reached fiscalization yet):
 *
 *   - `'fiscalized'`   — the device accepted it; invoice number/QR/serial
 *     are stored.
 *   - `'waiting'`      — a transient/technical problem; `fiscal-engine.ts`
 *     keeps retrying in the background.
 *   - `'needs_fixing'` — the device rejected the sale's data (or an
 *     anomaly in this build) — retrying the same data is pointless, so
 *     it's flagged for a person instead of being queued.
 */
export type FiscalStatus = 'fiscalized' | 'waiting' | 'needs_fixing'

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
  /** KRA/eTIMS invoice number, set once fiscalization succeeds. */
  fiscal_invoice_number: string | null
  /** Base64 QR code payload returned (or generated) at fiscalization time. */
  fiscal_qr_code: string | null
  /** ISO timestamp of a successful fiscalization. */
  fiscal_fiscalized_at: string | null
  /** See {@link FiscalStatus}. `null` = fiscalization never attempted. */
  fiscal_status: FiscalStatus | null
  /** Short plain-language failure reason, e.g. "Wrong client PIN". `null` once fiscalized (or never attempted). */
  fiscal_error_reason: string | null
  /** Classification of `fiscal_error_reason` — see {@link FiscalFailureKind}. `null` once fiscalized (or never attempted). */
  fiscal_error_kind: FiscalFailureKind | null
  /**
   * A small, stable tag identifying a `needs_fixing`/`'data'` rejection
   * that can be fixed on the spot — currently only `'wrong-pin'`
   * (phase-88/Step 4). Persisted (unlike `CheckoutReceipt.fiscalDataIssue`,
   * which is deliberately in-memory-only for the immediate post-checkout
   * notice) so the back-office list can recognize a fixable rejection
   * read back from a stored order, not just one from a live attempt.
   * Set by {@link RubisDatabase.setOrderFiscalFailure}, cleared by
   * {@link RubisDatabase.setOrderFiscalInfo} on success.
   */
  fiscal_data_issue: 'wrong-pin' | null
  /**
   * The last-used {@link FiscalInvoiceRequest}, JSON-serialized —
   * written once fiscalization is first attempted, kept afterward
   * regardless of outcome (success, queued, or `needs_fixing`) so a
   * manual resend (phase-76) always has the sale's stored request to
   * resubmit rather than reconstructing one. `null` until a first
   * fiscalization attempt is made.
   */
  fiscal_request_json: string | null
  /**
   * The device's five per-VAT-group subtotal amounts from
   * `ReadCurrentReceiptInfo` (Step 5), JSON-serialized from a
   * {@link FiscalVatGroupAmounts}, exactly as the device returned them —
   * for the fiscal reconciliation report (docs/phase-163). `null` when
   * fiscalization never attempted, when the device wasn't read at Step 5
   * (a failed attempt, or the mock provider), or when a retry recovered
   * an already-filed invoice via `ReadCUinvoiceNumber` rather than
   * running Step 5 itself.
   */
  fiscal_vat_groups_json: string | null
  /**
   * Where {@link fiscal_fiscalized_at} came from (docs/phase-164): `'device'`
   * when the control unit's own `ReadDateTime` reply was stored verbatim
   * (`dd-MM-yyyy HH:mm:ss`), `'local-fallback'` when the device gave no
   * timestamp and the till's own clock was stored instead (ISO-8601), or
   * `null` for an order fiscalized before this column existed, or by the
   * already-filed recovery path, which always uses the local fallback but
   * predates this column's introduction on some rows.
   */
  fiscal_fiscalized_at_source: 'device' | 'local-fallback' | null
  /**
   * The Control Unit's own serial number (`ReadCUnumbers`), stored once at
   * fiscalization time per the VIL G03 manual's printed-invoice detail set
   * (docs/phase-164). `null` when the device's serial read failed at that
   * time, or the order was fiscalized before this column existed.
   */
  fiscal_cu_serial: string | null
  /**
   * When this sale's receipt was first successfully printed (physical
   * print OR the PDF fallback — either counts, since both produce a real
   * receipt), or `null` if never printed (docs/phase-164). Write-once,
   * like the fiscal fields above: the FIRST successful print sets it, and
   * every later print of the same sale sees it already set, so it can be
   * stamped "DUPLICATE" rather than mistaken for the original. Set by
   * {@link RubisDatabase.markReceiptPrinted}, read by
   * {@link RubisDatabase.hasReceiptPrinted}. Applies to every sale
   * receipt, fiscalized or not — unrelated to fiscal status.
   */
  receipt_printed_at: string | null
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

/** A `sync_queue` row of `entity_type = 'etims_invoice'`, payload parsed into a typed object. */
export interface FiscalQueueItem extends Omit<SyncQueueRow, 'payload_json'> {
  payload: FiscalInvoiceRequest
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
  /** Customer's KRA PIN, when captured for a B2B eTIMS invoice — omitted for a walk-in B2C sale. */
  customerPin?: string
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
  /**
   * This sale's fiscalization outcome (phase-77) — read back from the
   * order row after `runCheckout`'s fiscalization block finishes, so it
   * always reflects what was actually persisted. `null` only in the
   * pathological case where even the fallback DB write failed (see
   * `checkout.ts`'s outer fiscalization `catch`) — fiscalization was
   * never recorded at all.
   */
  fiscalStatus: FiscalStatus | null
  /** Plain-language failure reason, set when `fiscalStatus` is `'waiting'` or `'needs_fixing'`. Never a code. */
  fiscalErrorReason: string | null
  /** Classification of `fiscalErrorReason` — see {@link FiscalFailureKind}. */
  fiscalErrorKind: FiscalFailureKind | null
  /**
   * A small, stable tag identifying a `needs_fixing`/`'data'` rejection
   * the till can offer an on-the-spot fix for (phase-77) — sourced from
   * THIS attempt's {@link FiscalSubmitOutcome}. Also persisted onto the
   * order row's `fiscal_data_issue` column as of phase-88/Step 4 (see
   * {@link OrderRow.fiscal_data_issue}), so the back-office list can
   * recognize the same fixable rejection later, from a stored order
   * rather than only a live attempt. `null` for every outcome except a
   * recognized fixable rejection.
   */
  fiscalDataIssue: 'wrong-pin' | null
}

/**
 * Result of a manual fiscalization resend (phase-78, Part C) — the
 * same fiscal-outcome fields `CheckoutReceipt` carries, without the
 * checkout-specific `mode`/`shopifyOrderId` a resend has no opinion on.
 * The renderer merges this into its stored `lastReceipt` so the till
 * notice reflects the sale's new outcome.
 */
export type FiscalResendResult = Pick<
  CheckoutReceipt,
  'localId' | 'fiscal' | 'fiscalStatus' | 'fiscalErrorReason' | 'fiscalErrorKind' | 'fiscalDataIssue'
>

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
  /** Customer's KRA PIN, when captured for a B2B eTIMS invoice — omitted for a walk-in B2C sale. */
  customerPin?: string
  /** Customer's company/trading name, when captured for a B2B eTIMS invoice. */
  companyName?: string
  cartDiscount?: Discount
  /**
   * Set **only by the `orders:checkout` IPC handler**, when this sale is
   * being completed on a manually entered M-Pesa code.
   *
   * There is no field for this on `checkoutRequestSchema`, so a renderer
   * cannot supply it — the same structural guarantee the stock-take
   * commit gets by having no `locationId` in its payload. As of
   * docs/phase-150.md step 3 (the client's POC decision), this needs no
   * manager PIN at sale time — the control is the cashier's own
   * attestation plus attribution, with a manager's approval deferred to
   * the end-of-day report (Step 4), not re-verified per sale.
   */
  manualApproval?: ManualMpesaApproval
}

/**
 * A manually entered M-Pesa code, as the renderer sends it.
 *
 * No manager credentials travel with it (docs/phase-150.md step 3 —
 * per-sale manager approval was removed; see `ManualMpesaApproval`). The
 * cashier attesting to it is the till's own logged-in staff member,
 * established server-side from `staffId`, never from this object.
 */
export interface ManualMpesaEntry {
  /** The 10-character code the cashier read off the customer's message. */
  code: string
  /** Must be `true`: the cashier's positive attestation that they saw the confirmation message on the customer's phone. */
  confirmUnverified: true
}

/**
 * What the renderer may send to `orders:checkout`.
 *
 * `manualApproval` is deliberately absent — that is established in the
 * main process, never asserted by a caller.
 */
export type CheckoutIpcRequest = Omit<CheckoutRequest, 'manualApproval'> & {
  mpesaManual?: ManualMpesaEntry
}

/**
 * The cashier's attestation for one manually entered M-Pesa payment.
 *
 * No `approvedByStaffId` field: as of docs/phase-150.md step 3, manual
 * entries are never approved at sale time — the row is written with
 * `approved_by_staff_id = NULL` and only a manager's later end-of-day
 * approval (Step 4) sets it. This type only carries what a cashier
 * attests to at the till.
 */
export interface ManualMpesaApproval {
  /**
   * The cashier's explicit, positive attestation that they saw the
   * M-Pesa confirmation message on the customer's phone. Carried through
   * rather than assumed so the gate can refuse a request that skipped
   * it, however it reached the main process.
   */
  acknowledgedUnverified: boolean
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
 * Adds the `fiscal_*` columns to a pre-existing `orders` table (added
 * after the table was first shipped). `CREATE TABLE IF NOT EXISTS`
 * only covers a fresh database, so an upgrade from an older install
 * needs an explicit `ALTER TABLE`; failures are swallowed since
 * `better-sqlite3` throws when a column already exists and there is
 * no portable `ADD COLUMN IF NOT EXISTS` in SQLite.
 */
function migrateOrdersFiscalColumns(connection: SqliteConnection): void {
  const fiscalColumns = [
    'fiscal_invoice_number',
    'fiscal_qr_code',
    'fiscal_fiscalized_at',
    'fiscal_status',
    'fiscal_error_reason',
    'fiscal_error_kind',
    'fiscal_request_json',
    'fiscal_data_issue',
    // docs/phase-163 — the device's per-VAT-group amounts, for the fiscal
    // reconciliation report. Same additive/idempotent pattern as every
    // column above: a fresh database already has it via SCHEMA.orders.
    'fiscal_vat_groups_json',
    // docs/phase-164 — the control unit's own date/time source tag and
    // serial number, for the printed receipt's fiscal block. Added as
    // plain TEXT here (no CHECK), same as fiscal_status/fiscal_error_kind
    // above on an upgraded database — SQLite can't add a CHECK constraint
    // via ALTER TABLE ADD COLUMN, only a fresh table gets one.
    'fiscal_fiscalized_at_source',
    'fiscal_cu_serial'
  ]
  for (const column of fiscalColumns) {
    try {
      connection.exec(`ALTER TABLE orders ADD COLUMN ${column} TEXT`)
    } catch {
      // Column already exists — table was created with the current schema.
    }
  }
}

/**
 * Adds `receipt_printed_at` to a pre-existing `orders` table (docs/
 * phase-164) — kept separate from {@link migrateOrdersFiscalColumns}
 * since it is not a fiscal column (it applies to every sale receipt,
 * fiscalized or not); same idempotent `ALTER TABLE` pattern.
 */
function migrateOrdersReceiptColumns(connection: SqliteConnection): void {
  try {
    connection.exec('ALTER TABLE orders ADD COLUMN receipt_printed_at TEXT')
  } catch {
    // Column already exists — table was created with the current schema.
  }
}

/**
 * Adds `excluded_count` to a `mpesa_day_approvals` table created before
 * docs/phase-153 introduced per-entry exclusions — a fresh table already
 * has the column via {@link SCHEMA.mpesaDayApprovals}, so this is a no-op
 * there; the `try/catch` is the same idempotent pattern
 * {@link migrateOrdersFiscalColumns} uses.
 */
function migrateMpesaDayApprovalsColumns(connection: SqliteConnection): void {
  try {
    connection.exec('ALTER TABLE mpesa_day_approvals ADD COLUMN excluded_count INTEGER NOT NULL DEFAULT 0')
  } catch {
    // Column already exists.
  }
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
    shift_id INTEGER,
    fiscal_invoice_number TEXT,
    fiscal_qr_code TEXT,
    fiscal_fiscalized_at TEXT,
    fiscal_status TEXT CHECK (fiscal_status IN ('fiscalized', 'waiting', 'needs_fixing')),
    fiscal_error_reason TEXT,
    fiscal_error_kind TEXT CHECK (fiscal_error_kind IN ('data', 'system', 'technical')),
    fiscal_request_json TEXT,
    fiscal_data_issue TEXT,
    fiscal_vat_groups_json TEXT,
    fiscal_fiscalized_at_source TEXT CHECK (fiscal_fiscalized_at_source IN ('device', 'local-fallback')),
    fiscal_cu_serial TEXT,
    receipt_printed_at TEXT
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
  fiscalInvoiceIndex: `CREATE INDEX IF NOT EXISTS idx_orders_fiscal_invoice_number ON orders (fiscal_invoice_number)`,
  /**
   * Every date-range report (`generateDailySummary`/`generateEndOfDayReport`/
   * `generateSalesSummary`/`generateFiscalStatusByDay`, and the invoice list
   * — docs/phase-158) filters and sorts `orders` on `created_at`; this was
   * a full table scan before (docs/phase-157 Part 2's "Indexes" finding).
   */
  ordersCreatedAtIndex: `CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders (created_at)`,
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
  )`,
  mpesaTransactions: `CREATE TABLE IF NOT EXISTS mpesa_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_local_id INTEGER,
    checkout_request_id TEXT NOT NULL,
    merchant_request_id TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    amount INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed')),
    mpesa_receipt_number TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  mpesaTransactionsCheckoutRequestIndex: `CREATE INDEX IF NOT EXISTS idx_mpesa_transactions_checkout_request_id ON mpesa_transactions (checkout_request_id)`,
  /**
   * M-Pesa confirmation messages read off the modem, and whether each
   * has already paid for a sale.
   *
   * `transaction_code` is `UNIQUE` and that is the whole point: it is
   * what stops one payment being spent twice. The inbox folder is read
   * every few seconds and gammu's files are never deleted, so the same
   * message is parsed over and over — dedup has to live in the database,
   * not in a set in memory that a restart would empty. An emptied set
   * would let an already-spent payment be approved a second time.
   *
   * `raw_text` keeps the message verbatim. This is money: the parsed
   * fields are an interpretation, and the original has to survive for
   * anyone who later needs to check that interpretation.
   */
  mpesaSmsMessages: `CREATE TABLE IF NOT EXISTS mpesa_sms_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_code TEXT NOT NULL UNIQUE,
    amount REAL NOT NULL,
    payer_name TEXT,
    payer_alias TEXT,
    masked_phone TEXT,
    account_reference TEXT,
    occurred_at TEXT NOT NULL,
    source_file TEXT NOT NULL,
    raw_text TEXT NOT NULL,
    matched_order_local_id INTEGER,
    approved_by_staff_id INTEGER,
    approved_at TEXT,
    created_at TEXT NOT NULL
  )`,
  mpesaSmsMessagesUnmatchedIndex: `CREATE INDEX IF NOT EXISTS idx_mpesa_sms_messages_unmatched ON mpesa_sms_messages (matched_order_local_id, created_at)`,
  appConfigurations: `CREATE TABLE IF NOT EXISTS app_configurations (
    key TEXT PRIMARY KEY,
    value TEXT,
    encrypted INTEGER NOT NULL DEFAULT 0,
    requires_restart INTEGER NOT NULL DEFAULT 0,
    category TEXT NOT NULL DEFAULT 'general' CHECK (category IN ('shopify', 'mpesa', 'etims', 'printer', 'general')),
    last_updated DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  /**
   * One physical stock take. **History, never stock** — see the file
   * header of `stock-take.ts`. Nothing here is a live quantity and
   * nothing here may be read as one.
   *
   * `session_uuid` is `UNIQUE` and does double duty: it is the
   * `referenceDocumentUri` Shopify records against the adjustment, and
   * the seed of the `@idempotent` key the mutation carries.
   *
   * `committed_reference_uri` is `UNIQUE` and is the layer of
   * idempotency this app owns. Shopify forgets an idempotency key after
   * 24 hours; this column refuses a second commit of the same session
   * for ever. Same reasoning as `mpesa_sms_messages.transaction_code`:
   * dedup lives in the database, not in memory a restart would empty.
   *
   * `opening_levels_json` is the verbatim location-scoped read taken at
   * `opened_at`, frozen. It exists so a count started online can be
   * continued offline and so an auditor can see what Shopify claimed
   * when the counter started disagreeing with it. It is read for
   * exactly one purpose — stamping a newly counted row's
   * `system_snapshot_qty` — and never as current stock.
   */
  stockTakeSessions: `CREATE TABLE IF NOT EXISTS stock_take_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_uuid TEXT NOT NULL UNIQUE,
    location_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'counting', 'awaiting_approval', 'committed', 'abandoned')),
    opened_at TEXT NOT NULL,
    committed_at TEXT,
    counted_by_staff_id INTEGER NOT NULL,
    approved_by_staff_id INTEGER,
    second_approver_staff_id INTEGER,
    opening_levels_json TEXT NOT NULL,
    shopify_response_json TEXT,
    committed_reference_uri TEXT UNIQUE
  )`,
  /**
   * One counted variant within a stock take. A row exists **because it
   * was counted** — `counted_qty` is `NOT NULL` and there is no
   * "uncounted" state. That is what makes this build's subset-per-session
   * scope structurally safe: an item nobody scanned has no row, so it
   * can never be mistaken for a shelf counted as empty and pushed as a
   * negative delta.
   *
   * `inventory_item_id` lives here rather than on `products` on purpose:
   * the variant → inventory-item mapping belongs to the session about to
   * commit and dies with it, instead of becoming a permanent local
   * shadow of Shopify's inventory model.
   *
   * `system_snapshot_qty`, `fresh_qty_at_commit` and `delta_pushed` are
   * all stored so the arithmetic is independently auditable without
   * trusting this app's code.
   */
  stockTakeItems: `CREATE TABLE IF NOT EXISTS stock_take_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    variant_id TEXT NOT NULL,
    inventory_item_id TEXT NOT NULL,
    variant_label TEXT NOT NULL DEFAULT '',
    unit_price_at_count REAL NOT NULL DEFAULT 0,
    system_snapshot_qty INTEGER NOT NULL,
    snapshot_taken_at TEXT NOT NULL,
    counted_qty INTEGER NOT NULL,
    variance INTEGER NOT NULL,
    fresh_qty_at_commit INTEGER,
    delta_pushed INTEGER,
    commit_status TEXT CHECK (commit_status IN ('applied', 'rejected', 'skipped')),
    commit_error TEXT,
    UNIQUE (session_id, variant_id)
  )`,
  stockTakeItemsSessionIndex: `CREATE INDEX IF NOT EXISTS idx_stock_take_items_session ON stock_take_items (session_id)`,
  /**
   * One row per M-Pesa payment that **settled a sale**, across all three
   * modes.
   *
   * Distinct from the two tables beside it, and deliberately additive to
   * them: `mpesa_transactions` records *an STK attempt this till made*
   * and `mpesa_sms_messages` records *a message this till received*.
   * Neither is a record of a payment that paid for something, and
   * neither reliably names the sale — `mpesa_transactions.order_local_id`
   * has never once been populated, because both its callers run before
   * the order exists. Hence `order_local_id NOT NULL` here: an attempt
   * is not a payment, and a payment nobody can trace to a sale is not an
   * audit trail.
   *
   * `verification_status` is the point of the table. It is set in
   * `checkout.ts` from **which gate branch actually ran**, never from
   * anything the renderer sent, and `manual_unverified` is a first-class
   * value rather than an absence — a manually entered code completes a
   * sale but has been confirmed by nobody, and the record has to say so
   * in as many words. See `docs/phase-120.md` §5.
   *
   * `UNIQUE (mode, reference)` follows `mpesa_sms_messages.transaction_code`:
   * dedup belongs in the database, not in memory a restart would empty.
   * It is enforced strictly for manual entry (a repeated code is refused)
   * and permissively for the two confirming modes, which must keep
   * behaving exactly as they did — see
   * {@link RubisDatabase.queueOrderRecordingMpesaPayment}.
   */
  mpesaPayments: `CREATE TABLE IF NOT EXISTS mpesa_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_local_id INTEGER NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('daraja', 'sms', 'manual')),
    verification_status TEXT NOT NULL CHECK (verification_status IN ('confirmed', 'matched', 'manual_unverified')),
    reference TEXT NOT NULL,
    amount REAL NOT NULL,
    entered_by_staff_id INTEGER NOT NULL,
    approved_by_staff_id INTEGER,
    reconciled_at TEXT,
    reconciled_by_staff_id INTEGER,
    reconciliation_note TEXT,
    source_transaction_id INTEGER,
    source_sms_message_id INTEGER,
    created_at TEXT NOT NULL,
    UNIQUE (mode, reference)
  )`,
  mpesaPaymentsUnreconciledIndex: `CREATE INDEX IF NOT EXISTS idx_mpesa_payments_unreconciled ON mpesa_payments (verification_status, reconciled_at)`,
  /**
   * One manager's end-of-day sign-off (docs/phase-151/152) covering a
   * batch of manual M-Pesa entries. `mpesa_payments` rows it covers point
   * back at it through their own `reconciliation_note` (see
   * {@link RubisDatabase.approveMpesaEntries}) rather than this table
   * holding a list of ids — the entries are the many side, this is the
   * one, and SQLite has no array column to hold the reverse cheaply.
   */
  mpesaDayApprovals: `CREATE TABLE IF NOT EXISTS mpesa_day_approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    local_day TEXT NOT NULL,
    approved_by_staff_id INTEGER NOT NULL,
    approved_at TEXT NOT NULL,
    entry_count INTEGER NOT NULL,
    excluded_count INTEGER NOT NULL DEFAULT 0,
    total_amount REAL NOT NULL,
    note TEXT
  )`,
  mpesaDayApprovalsLocalDayIndex: `CREATE INDEX IF NOT EXISTS idx_mpesa_day_approvals_local_day ON mpesa_day_approvals (local_day)`,
  /**
   * One manual entry a manager reviewed and deliberately left out of an
   * approval (docs/phase-153) — e.g. a code not on the M-Pesa statement.
   * `mpesa_payments` is untouched for these: `reconciled_at` stays NULL,
   * so the entry surfaces again, still pending, on the next report's
   * carry-over — this table only records *why* it was skipped and by
   * which approval review, so that history isn't silently lost.
   */
  mpesaDayExclusions: `CREATE TABLE IF NOT EXISTS mpesa_day_exclusions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    approval_id INTEGER NOT NULL REFERENCES mpesa_day_approvals(id),
    payment_id INTEGER NOT NULL,
    reason TEXT
  )`,
  mpesaDayExclusionsPaymentIndex: `CREATE INDEX IF NOT EXISTS idx_mpesa_day_exclusions_payment ON mpesa_day_exclusions (payment_id)`
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

/** Grouping shown in the Admin screen's configuration list. */
export type AppConfigCategory = 'shopify' | 'mpesa' | 'etims' | 'printer' | 'general'

/** Row shape of the `app_configurations` table. */
export interface AppConfigRow {
  key: string
  value: string | null
  encrypted: boolean
  requires_restart: boolean
  category: AppConfigCategory
  last_updated: string
}

/** Options accepted by {@link RubisDatabase.setConfig}. */
export interface SetConfigOptions {
  /** Marks the value as sensitive for display purposes only — the value itself is still stored as given; encrypt it before calling this for anything actually secret (see `secretStore.ts`). */
  encrypted?: boolean
  /** Whether picking up this value requires an app restart (surfaced by `getRestartRequiredConfigs`). */
  requiresRestart?: boolean
  category?: AppConfigCategory
}

/** Lifecycle status of a logged M-Pesa STK Push transaction. */
export type MpesaTransactionStatus = 'pending' | 'success' | 'failed'

/** Row shape of the `mpesa_transactions` table. */
export interface MpesaTransactionRow {
  id: number
  /** Local order this payment belongs to, when known at logging time. */
  order_local_id: number | null
  checkout_request_id: string
  merchant_request_id: string
  phone_number: string
  amount: number
  status: MpesaTransactionStatus
  /** M-Pesa confirmation code, set once `status` resolves to `'success'`. */
  mpesa_receipt_number: string | null
  created_at: string
  updated_at: string
}

/**
 * Thrown inside an order-and-payment transaction to roll the order back
 * when the payment it depends on cannot be taken — already spent on
 * another sale, or already recorded under the same code.
 *
 * Never escapes the method that throws it: a control signal, not an
 * error the caller handles.
 */
class PaymentUnavailableError extends Error {}

/** Row shape of the `mpesa_sms_messages` table. */
export interface MpesaSmsMessageRow {
  id: number
  transaction_code: string
  amount: number
  payer_name: string | null
  payer_alias: string | null
  masked_phone: string | null
  account_reference: string | null
  /** ISO-8601, as stated by the message itself. */
  occurred_at: string
  /** The inbox file, or files, this was read from. */
  source_file: string
  /** The message verbatim. */
  raw_text: string
  /** The sale this payment has already paid for. `null` means still available. */
  matched_order_local_id: number | null
  approved_by_staff_id: number | null
  approved_at: string | null
  created_at: string
}

/** Shape passed into {@link RubisDatabase.insertMpesaSmsMessage}. */
export interface InsertMpesaSmsMessageInput {
  transactionCode: string
  amount: number
  payerName: string | null
  payerAlias: string | null
  maskedPhone: string | null
  accountReference: string | null
  occurredAt: string
  sourceFile: string
  rawText: string
  /** ISO-8601 timestamp of when this till read the message. */
  createdAt: string
}

/**
 * How long a `waiting` sale must sit unfiled before the back-office
 * list (phase-88/Step 4) surfaces it as stuck — even though
 * `fiscal-engine.ts` is still automatically retrying it in the
 * background. Keyed off the sale's OWN `created_at`, not the retry
 * queue's bookkeeping: `sync_queue`'s own abandonment signal
 * (`attempts >= SYNC_MAX_ATTEMPTS`) can take roughly 2.5 hours to reach
 * given the backoff curve (`computeBackoffMs`, capped at 30 minutes per
 * attempt) — far too long a blind spot for a screen whose whole point
 * is "don't lose sight of an unfiled sale." 15 minutes surfaces trouble
 * well before that, at the cost of occasionally showing a sale that's
 * still retrying normally and might resolve on its own — an
 * acceptable trade for visibility over a multi-hour gap.
 */
export const STUCK_WAITING_THRESHOLD_MS = 15 * 60_000

/**
 * One row of the back-office "needs attention" list (phase-88/Step 4):
 * every `needs_fixing` order, plus every `waiting` order that's been
 * unfiled longer than {@link STUCK_WAITING_THRESHOLD_MS}. `fiscal_status`
 * itself is what distinguishes the two categories — a `'waiting'` row
 * appearing here is, by construction of the query, already past the
 * threshold; a still-actively-retrying `waiting` order is excluded
 * entirely, not included with a "not yet stuck" flag.
 */
export interface NeedsAttentionRow {
  local_id: number
  created_at: string
  total: number
  /** The staff member who rang up the sale, or `null` if the account was later removed. */
  staff_name: string | null
  fiscal_status: Exclude<FiscalStatus, 'fiscalized'>
  fiscal_error_reason: string | null
  fiscal_error_kind: FiscalFailureKind | null
  fiscal_data_issue: 'wrong-pin' | null
}

/** Shape passed into {@link RubisDatabase.logMpesaTransaction}. */
export interface LogMpesaTransactionInput {
  orderLocalId?: number
  checkoutRequestId: string
  merchantRequestId: string
  phoneNumber: string
  amount: number
  /** Initial status. Defaults to `'pending'` — pass `'failed'` when logging a rejected STK Push attempt. */
  status?: MpesaTransactionStatus
}

/** How an M-Pesa payment was taken. */
export type MpesaPaymentMode = 'daraja' | 'sms' | 'manual'

/**
 * How well a payment is actually proven.
 *
 * `confirmed` — this till's own record of Daraja's STK status response.
 * `matched` — a confirmation message Safaricom sent to this till's SIM.
 * `manual_unverified` — **nobody confirmed it.** A cashier typed a code
 * and a manager authorized completing the sale on it. It is not a lesser
 * shade of confirmed; it is the absence of confirmation, recorded.
 */
export type MpesaVerificationStatus = 'confirmed' | 'matched' | 'manual_unverified'

/** Row shape of the `mpesa_payments` table. */
export interface MpesaPaymentRow {
  id: number
  order_local_id: number
  mode: MpesaPaymentMode
  verification_status: MpesaVerificationStatus
  reference: string
  amount: number
  entered_by_staff_id: number
  approved_by_staff_id: number | null
  reconciled_at: string | null
  reconciled_by_staff_id: number | null
  reconciliation_note: string | null
  source_transaction_id: number | null
  source_sms_message_id: number | null
  created_at: string
}

/**
 * Shape passed into the order-and-payment transactions.
 *
 * Deliberately carries no `orderLocalId`: the order row does not exist
 * until the transaction that writes it, and the id is filled in there.
 * A caller cannot therefore attach a payment to the wrong sale.
 */
export interface RecordMpesaPaymentInput {
  mode: MpesaPaymentMode
  verificationStatus: MpesaVerificationStatus
  reference: string
  amount: number
  enteredByStaffId: number
  approvedByStaffId?: number | null
}

/**
 * Row shape of the `mpesa_day_approvals` table — one manager's
 * end-of-day sign-off on a batch of manual M-Pesa entries.
 */
export interface MpesaDayApprovalRow {
  id: number
  local_day: string
  approved_by_staff_id: number
  approved_at: string
  entry_count: number
  excluded_count: number
  total_amount: number
  note: string | null
}

/**
 * Row shape of the `mpesa_day_exclusions` table — one manual entry a
 * manager deliberately left pending during a day review (docs/phase-153),
 * with an optional reason.
 */
export interface MpesaDayExclusionRow {
  id: number
  approval_id: number
  payment_id: number
  reason: string | null
}

/**
 * Result of {@link RubisDatabase.approveMpesaEntries}. `approval` is
 * `null` only when every given id was already reconciled by the older
 * per-payment Reconciliation flow rather than by a day approval — real
 * and honest ("nobody's day-approval record covers this"), not an error:
 * `alreadyApproved`/`approvedCount: 0` still tell the caller nothing was
 * left to do.
 */
export interface ApproveMpesaEntriesResult {
  approval: MpesaDayApprovalRow | null
  approvedCount: number
  excludedCount: number
  alreadyApproved: boolean
}

/** Outcome of recording a failed sync attempt. */
export interface SyncFailureResult {
  /** True when the item exhausted all retries and was abandoned. */
  exhausted: boolean
  /** Attempts recorded after this failure. */
  attempts: number
}

/** Lifecycle state of a stock-take session. */
export type StockTakeStatus =
  | 'open'
  | 'counting'
  | 'awaiting_approval'
  | 'committed'
  | 'abandoned'

/** Per-item outcome of a stock-take commit. */
export type StockTakeCommitStatus = 'applied' | 'rejected' | 'skipped'

/** Raw `stock_take_sessions` row. */
export interface StockTakeSessionRow {
  id: number
  session_uuid: string
  location_id: string
  status: StockTakeStatus
  opened_at: string
  committed_at: string | null
  counted_by_staff_id: number
  approved_by_staff_id: number | null
  second_approver_staff_id: number | null
  opening_levels_json: string
  shopify_response_json: string | null
  committed_reference_uri: string | null
}

/** Raw `stock_take_items` row. */
export interface StockTakeItemRow {
  id: number
  session_id: number
  variant_id: string
  inventory_item_id: string
  variant_label: string
  unit_price_at_count: number
  system_snapshot_qty: number
  snapshot_taken_at: string
  counted_qty: number
  variance: number
  fresh_qty_at_commit: number | null
  delta_pushed: number | null
  commit_status: StockTakeCommitStatus | null
  commit_error: string | null
}

/**
 * One variant's frozen opening observation, as held in
 * `stock_take_sessions.opening_levels_json`.
 *
 * Audit reference only — see the `stockTakeSessions` schema comment.
 */
export interface StockTakeOpeningLevel {
  inventoryItemId: string
  systemSnapshotQty: number
}

/** Shape passed into {@link RubisDatabase.createStockTakeSession}. */
export interface CreateStockTakeSessionInput {
  sessionUuid: string
  locationId: string
  countedByStaffId: number
  openedAt: string
  openingLevels: Record<string, StockTakeOpeningLevel>
}

/** Shape passed into {@link RubisDatabase.recordStockTakeCount}. */
export interface RecordStockTakeCountInput {
  sessionId: number
  variantId: string
  inventoryItemId: string
  variantLabel: string
  unitPriceAtCount: number
  systemSnapshotQty: number
  snapshotTakenAt: string
  countedQty: number
}

/** One item's commit outcome, written by {@link RubisDatabase.commitStockTakeSession}. */
export interface StockTakeItemOutcome {
  variantId: string
  freshQtyAtCommit: number | null
  deltaPushed: number | null
  commitStatus: StockTakeCommitStatus
  commitError: string | null
}

/** Shape passed into {@link RubisDatabase.commitStockTakeSession}. */
export interface CommitStockTakeSessionInput {
  sessionId: number
  committedAt: string
  committedReferenceUri: string
  approvedByStaffId: number
  secondApproverStaffId: number | null
  shopifyResponseJson: string
  outcomes: StockTakeItemOutcome[]
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
    connection.exec(SCHEMA.mpesaTransactions)
    connection.exec(SCHEMA.mpesaTransactionsCheckoutRequestIndex)
    connection.exec(SCHEMA.mpesaSmsMessages)
    connection.exec(SCHEMA.mpesaSmsMessagesUnmatchedIndex)
    connection.exec(SCHEMA.appConfigurations)
    connection.exec(SCHEMA.stockTakeSessions)
    connection.exec(SCHEMA.stockTakeItems)
    connection.exec(SCHEMA.stockTakeItemsSessionIndex)
    connection.exec(SCHEMA.mpesaPayments)
    connection.exec(SCHEMA.mpesaPaymentsUnreconciledIndex)
    connection.exec(SCHEMA.mpesaDayApprovals)
    connection.exec(SCHEMA.mpesaDayApprovalsLocalDayIndex)
    migrateMpesaDayApprovalsColumns(connection)
    connection.exec(SCHEMA.mpesaDayExclusions)
    connection.exec(SCHEMA.mpesaDayExclusionsPaymentIndex)
    migrateOrdersFiscalColumns(connection)
    migrateOrdersReceiptColumns(connection)
    connection.exec(SCHEMA.fiscalInvoiceIndex)
    connection.exec(SCHEMA.ordersCreatedAtIndex)
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
      customerPin: input.customerPin,
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
   * Returns `entity_type = 'order'` sync-queue items eligible for
   * pushing to Shopify (due date reached). Scoped to `'order'` so the
   * Shopify sync engine never picks up `'etims_invoice'` rows sharing
   * this table and tries to parse/push them as Shopify orders.
   *
   * @param {number} now — current timestamp in epoch milliseconds
   * @returns {SyncQueueItem[]} oldest first
   */
  getPendingSyncQueue(now: number): SyncQueueItem[] {
    const rows = this.conn
      .prepare(
        "SELECT id, entity_type, entity_id, action, payload_json, attempts, last_error, created_at, next_attempt_at FROM sync_queue WHERE entity_type = 'order' AND next_attempt_at <= ? ORDER BY id ASC"
      )
      .all(now) as SyncQueueRow[]

    return rows.map((row) => ({
      ...row,
      payload: JSON.parse(row.payload_json) as OfflineOrderPayload
    }))
  }

  /**
   * Queues a fiscalization retry for an order whose immediate
   * `submitInvoice()` attempt at checkout failed — the eTIMS
   * store-and-forward counterpart to {@link queueOrder}'s Shopify
   * queuing. Reuses `sync_queue` rather than a parallel table: the
   * `(entity_type, entity_id, payload_json, attempts, next_attempt_at)`
   * shape is identical, just scoped to `entity_type = 'etims_invoice'`.
   *
   * @param {number} localId
   * @param {FiscalInvoiceRequest} request — resent verbatim on every
   *   retry, including `clientOrderUuid`, so the fiscal device can
   *   recognize a retried request as a duplicate of one that may have
   *   already succeeded on-device without acknowledging.
   * @returns {{ queueId: number }}
   */
  queueFiscalInvoice(localId: number, request: FiscalInvoiceRequest): { queueId: number } {
    const createdAt = new Date().toISOString()
    const info = this.conn
      .prepare(
        'INSERT INTO sync_queue (entity_type, entity_id, action, payload_json, attempts, created_at, next_attempt_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run('etims_invoice', localId, 'fiscalizeInvoice', JSON.stringify(request), 0, createdAt, 0)
    return { queueId: Number(info.lastInsertRowid) }
  }

  /**
   * Returns `entity_type = 'etims_invoice'` sync-queue items eligible
   * for a retried fiscalization attempt (due date reached).
   *
   * @param {number} now — current timestamp in epoch milliseconds
   * @returns {FiscalQueueItem[]} oldest first
   */
  getPendingFiscalQueue(now: number): FiscalQueueItem[] {
    const rows = this.conn
      .prepare(
        "SELECT id, entity_type, entity_id, action, payload_json, attempts, last_error, created_at, next_attempt_at FROM sync_queue WHERE entity_type = 'etims_invoice' AND next_attempt_at <= ? ORDER BY id ASC"
      )
      .all(now) as SyncQueueRow[]

    return rows.map((row) => ({
      ...row,
      payload: JSON.parse(row.payload_json) as FiscalInvoiceRequest
    }))
  }

  /**
   * Records a successful retried fiscalization: saves the invoice
   * number/QR code onto the order and removes the queue entry.
   *
   * @param {number} queueId
   * @param {string} invoiceNumber
   * @param {string} qrCode
   * @param {FiscalVatGroupAmounts} [vatGroups] see {@link setOrderFiscalInfo}
   * @param {string} [fiscalizedAt] see {@link setOrderFiscalInfo}
   * @param {'device' | 'local-fallback'} [fiscalizedAtSource] see {@link setOrderFiscalInfo}
   * @param {string} [cuSerial] see {@link setOrderFiscalInfo}
   */
  markFiscalQueueItemSynced(
    queueId: number,
    invoiceNumber: string,
    qrCode: string,
    vatGroups?: FiscalVatGroupAmounts,
    fiscalizedAt?: string,
    fiscalizedAtSource?: 'device' | 'local-fallback',
    cuSerial?: string
  ): void {
    const row = this.conn
      .prepare('SELECT entity_id FROM sync_queue WHERE id = ?')
      .get(queueId) as { entity_id: number } | undefined
    if (!row) return

    const settle = this.conn.transaction(() => {
      this.setOrderFiscalInfo(
        row.entity_id,
        invoiceNumber,
        qrCode,
        vatGroups,
        fiscalizedAt,
        fiscalizedAtSource,
        cuSerial
      )
      this.conn.prepare('DELETE FROM sync_queue WHERE id = ?').run(queueId)
    })
    settle()
  }

  /**
   * Records a failed retried fiscalization attempt: increments the
   * attempt counter, stores the last error, and schedules the next
   * attempt with exponential backoff. Unlike
   * {@link recordQueueFailure}, an exhausted row is never deleted —
   * fiscalization is a compliance obligation, not a best-effort sync,
   * so an abandoned invoice is left in `sync_queue` (its
   * `last_error` prefixed `ABANDONED`, `next_attempt_at` pushed
   * effectively to never) for IT to find and handle manually rather
   * than silently disappearing.
   *
   * @param {number} queueId
   * @param {string} error — human-readable failure reason
   * @returns {{ exhausted: boolean }}
   */
  recordFiscalQueueFailure(queueId: number, error: string): { exhausted: boolean } {
    const row = this.conn
      .prepare('SELECT id, attempts FROM sync_queue WHERE id = ?')
      .get(queueId) as { id: number; attempts: number } | undefined
    if (!row) return { exhausted: true }

    const attempts = row.attempts + 1
    const exhausted = attempts >= this.maxAttempts
    const lastError = exhausted ? `ABANDONED after ${attempts} attempts: ${error}` : error
    const nextAttemptAt = exhausted ? Number.MAX_SAFE_INTEGER : Date.now() + computeBackoffMs(attempts)

    this.conn
      .prepare('UPDATE sync_queue SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?')
      .run(attempts, lastError, nextAttemptAt, queueId)

    return { exhausted }
  }

  /**
   * Removes one `sync_queue` row without touching the order it belongs
   * to — the counterpart to {@link recordFiscalQueueFailure} for a
   * retry that comes back non-retryable (`data`/`system`): the order
   * moves to `needs_fixing` via {@link setOrderFiscalFailure} and stops
   * being retried, so its queue row is deleted outright rather than
   * backed off again. Unlike {@link markFiscalQueueItemSynced}, this
   * never writes `fiscal_invoice_number`/`fiscal_qr_code`/
   * `fiscal_status` — the caller does that separately, since "why it
   * stopped retrying" (needs_fixing) is a different write than "it
   * succeeded" (fiscalized).
   *
   * @param {number} queueId
   */
  removeFiscalQueueItem(queueId: number): void {
    this.conn.prepare('DELETE FROM sync_queue WHERE id = ?').run(queueId)
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
        'SELECT local_id, shopify_order_id, total, status, created_at, payload_json, staff_id, payment_method, tendered_amount, change_due, reference_number, shift_id, fiscal_invoice_number, fiscal_qr_code, fiscal_fiscalized_at, fiscal_status, fiscal_error_reason, fiscal_error_kind, fiscal_request_json, fiscal_data_issue, fiscal_vat_groups_json, fiscal_fiscalized_at_source, fiscal_cu_serial, receipt_printed_at FROM orders WHERE local_id = ?'
      )
      .get(localId) as OrderRow | undefined
  }

  /**
   * Whether this sale's receipt has already been printed once
   * (docs/phase-164) — the "original vs duplicate" question the
   * `receipt:print` IPC handler asks before rendering, since it is the
   * single call site for every print of a sale's receipt (the very first
   * one and any later reprint alike; see docs/phase-164's audit — there
   * is no separate "print on checkout" code path to tell them apart by).
   *
   * @param {number} localId
   * @returns {boolean}
   */
  hasReceiptPrinted(localId: number): boolean {
    const row = this.conn
      .prepare('SELECT receipt_printed_at FROM orders WHERE local_id = ?')
      .get(localId) as { receipt_printed_at: string | null } | undefined
    return !!row?.receipt_printed_at
  }

  /**
   * Records this sale's receipt as printed — write-once via
   * `COALESCE(receipt_printed_at, ?)`, so calling this again after a
   * reprint leaves the original print's timestamp in place. The caller
   * (`main/index.ts`) calls this only AFTER a print actually succeeds
   * (physical print or the PDF fallback) — a failed attempt (printer
   * offline AND the PDF fallback also failed) leaves this unset, so the
   * next attempt is still correctly treated as the original.
   *
   * @param {number} localId
   */
  markReceiptPrinted(localId: number): void {
    this.conn
      .prepare('UPDATE orders SET receipt_printed_at = COALESCE(receipt_printed_at, ?) WHERE local_id = ?')
      .run(new Date().toISOString(), localId)
  }

  /**
   * Records a successful fiscalization against an order — the
   * standard POS pattern of persisting the fiscal result locally so
   * {@link getOrderByFiscalInvoiceNumber} can serve read-backs without
   * re-querying the fiscal device's Electronic Journal. Also sets
   * `fiscal_status = 'fiscalized'` and clears any previously stored
   * failure reason/kind/data-issue tag — the single writer for both the
   * immediate checkout attempt (`main/index.ts`) and a successful queued
   * retry (see {@link markFiscalQueueItemSynced}), so both paths converge
   * on the same status transition.
   *
   * `vatGroups` (docs/phase-163) is the device's five per-VAT-group
   * amounts from Step 5, stored verbatim as JSON for the fiscal
   * reconciliation report — `undefined` (the `already-filed` recovery
   * path, which never runs Step 5 again) stores `NULL`, never a guessed
   * or re-fetched value.
   *
   * `fiscalizedAt`/`fiscalizedAtSource`/`cuSerial` (docs/phase-164) are the
   * control unit's own date/time stamp, where it came from, and its serial
   * number — all three already computed by `submitInvoice` but, before this
   * phase, discarded by every caller before reaching this function (see
   * docs/phase-163-2's audit). `fiscalizedAt` is stored VERBATIM, in
   * whichever shape it arrives in (the device's own `dd-MM-yyyy HH:mm:ss`,
   * or the till's ISO-8601 fallback) — never reformatted or reparsed here.
   * `cuSerial` is present on both the normal success return AND the
   * already-filed recovery return (it's read once per session via
   * `ReadCUnumbers`, before either branch), so it is never specially
   * omitted here the way `vatGroups` is — `undefined` only when the
   * provider itself never surfaced one (e.g. the mock, or a failed
   * session-level serial read), in which case this stores `NULL`.
   *
   * WRITE-ONCE (docs/phase-163-1, extended docs/phase-164):
   * `fiscal_invoice_number`, `fiscal_qr_code`, `fiscal_fiscalized_at`,
   * `fiscal_vat_groups_json`, `fiscal_fiscalized_at_source` and
   * `fiscal_cu_serial` are each guarded with `COALESCE(column, ?)`, so once
   * one is set it can never be replaced by a later call — only a
   * still-`NULL` column accepts the new value. This function is the single
   * writer for BOTH a genuine first success AND `fiscal-engine.ts`'s
   * "already fiscalized (race with a resend)" replay (`attemptFiscalRetry`'s
   * short-circuit, which echoes the order's OWN already-stored
   * `invoiceNumber`/`qrCode` back as if it were a fresh result, carrying no
   * `vatGroups` at all). Without the guard, that replay would silently
   * overwrite a correct, stored fiscalization timestamp with "now" and a
   * stored `fiscal_vat_groups_json` with `NULL` — see docs/phase-163-1's
   * audit. `fiscal_status`/`fiscal_error_*`/`fiscal_data_issue` need no such
   * guard: setting an already-`'fiscalized'` row to `'fiscalized'` again,
   * or nulling out fields that are already `NULL` on any fiscalized row,
   * changes nothing either way.
   *
   * @param {number} localId
   * @param {string} invoiceNumber
   * @param {string} qrCode
   * @param {FiscalVatGroupAmounts} [vatGroups]
   * @param {string} [fiscalizedAt] the control unit's own date/time stamp, verbatim — falls back to `new Date().toISOString()` when absent
   * @param {'device' | 'local-fallback'} [fiscalizedAtSource]
   * @param {string} [cuSerial] the control unit's serial number
   */
  setOrderFiscalInfo(
    localId: number,
    invoiceNumber: string,
    qrCode: string,
    vatGroups?: FiscalVatGroupAmounts,
    fiscalizedAt?: string,
    fiscalizedAtSource?: 'device' | 'local-fallback',
    cuSerial?: string
  ): void {
    this.conn
      .prepare(
        `UPDATE orders SET fiscal_invoice_number = COALESCE(fiscal_invoice_number, ?),
         fiscal_qr_code = COALESCE(fiscal_qr_code, ?),
         fiscal_fiscalized_at = COALESCE(fiscal_fiscalized_at, ?),
         fiscal_status = 'fiscalized', fiscal_error_reason = NULL, fiscal_error_kind = NULL,
         fiscal_data_issue = NULL, fiscal_vat_groups_json = COALESCE(fiscal_vat_groups_json, ?),
         fiscal_fiscalized_at_source = COALESCE(fiscal_fiscalized_at_source, ?),
         fiscal_cu_serial = COALESCE(fiscal_cu_serial, ?)
         WHERE local_id = ?`
      )
      .run(
        invoiceNumber,
        qrCode,
        fiscalizedAt ?? new Date().toISOString(),
        vatGroups ? JSON.stringify(vatGroups) : null,
        fiscalizedAtSource ?? null,
        cuSerial ?? null,
        localId
      )
  }

  /**
   * Records a failed fiscalization attempt against an order — the
   * counterpart to {@link setOrderFiscalInfo} for the two non-success
   * routes a checkout's `submitInvoice` call can take: a
   * transient/technical problem (`status: 'waiting'`, kept in
   * `sync_queue` for `fiscal-engine.ts` to retry) or a rejection of the
   * sale's own data (`status: 'needs_fixing'`, deliberately never
   * queued — see `main/index.ts`'s checkout handler). Never touches
   * `fiscal_invoice_number`/`fiscal_qr_code`/`fiscal_fiscalized_at` —
   * those stay `NULL` until (if ever) {@link setOrderFiscalInfo} runs.
   *
   * `dataIssue` (phase-88/Step 4) persists the same fixable-rejection tag
   * `CheckoutReceipt.fiscalDataIssue` carries in-memory for the immediate
   * post-checkout notice — passing it here is what lets the back-office
   * list recognize a wrong-PIN row read back later, not just one from a
   * live attempt. Defaults `null` (every non-wrong-PIN failure, and the
   * thrown-exception fallback, which has no classified code to tag).
   *
   * @param {number} localId
   * @param {Exclude<FiscalStatus, 'fiscalized'>} status
   * @param {string} reason short plain-language failure reason
   * @param {FiscalFailureKind} kind
   * @param {'wrong-pin' | null} [dataIssue]
   */
  setOrderFiscalFailure(
    localId: number,
    status: Exclude<FiscalStatus, 'fiscalized'>,
    reason: string,
    kind: FiscalFailureKind,
    dataIssue: 'wrong-pin' | null = null
  ): void {
    this.conn
      .prepare(
        'UPDATE orders SET fiscal_status = ?, fiscal_error_reason = ?, fiscal_error_kind = ?, fiscal_data_issue = ? WHERE local_id = ?'
      )
      .run(status, reason, kind, dataIssue, localId)
  }

  /**
   * Stores the {@link FiscalInvoiceRequest} last used to attempt this
   * order's fiscalization — written once, on the first attempt,
   * regardless of outcome (phase-76). A manual resend
   * ({@link resendFiscalization} in `fiscal-retry.ts`) reads it back so
   * it can resubmit the sale's ORIGINAL request rather than
   * reconstructing one from the order's `payload_json` (a different
   * shape — cart items, not the fiscal line/customer-block shape) or
   * from whatever the cashier's screen happens to hold at resend time.
   *
   * @param {number} localId
   * @param {FiscalInvoiceRequest} request
   */
  setOrderFiscalRequest(localId: number, request: FiscalInvoiceRequest): void {
    this.conn
      .prepare('UPDATE orders SET fiscal_request_json = ? WHERE local_id = ?')
      .run(JSON.stringify(request), localId)
  }

  /**
   * Looks up an order by its previously stored eTIMS invoice number —
   * the local-DB fallback `getInvoiceDetails` uses instead of querying
   * the fiscal device directly.
   *
   * @param {string} invoiceNumber
   * @returns the order row, or `undefined` when no order was fiscalized with that number
   */
  getOrderByFiscalInvoiceNumber(invoiceNumber: string): OrderRow | undefined {
    return this.conn
      .prepare(
        'SELECT local_id, shopify_order_id, total, status, created_at, payload_json, staff_id, payment_method, tendered_amount, change_due, reference_number, shift_id, fiscal_invoice_number, fiscal_qr_code, fiscal_fiscalized_at, fiscal_status, fiscal_error_reason, fiscal_error_kind, fiscal_request_json, fiscal_data_issue, fiscal_vat_groups_json, fiscal_fiscalized_at_source, fiscal_cu_serial, receipt_printed_at FROM orders WHERE fiscal_invoice_number = ?'
      )
      .get(invoiceNumber) as OrderRow | undefined
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
   * Selects the full column set (fiscal fields included, docs/phase-158)
   * so `generateFiscalStatusByDay` can read `fiscal_status` off the same
   * rows the revenue reports already fetch, rather than a second query —
   * every existing caller already used `OrderRow`, so this widens what
   * was fetched, not what was typed.
   *
   * @param {string} startIso
   * @param {string} endIso
   * @returns {OrderRow[]}
   */
  getOrdersForDateRange(startIso: string, endIso: string): OrderRow[] {
    return this.conn
      .prepare(
        `SELECT local_id, shopify_order_id, total, status, created_at, payload_json, staff_id, payment_method,
                tendered_amount, change_due, reference_number, shift_id, fiscal_invoice_number, fiscal_qr_code,
                fiscal_fiscalized_at, fiscal_status, fiscal_error_reason, fiscal_error_kind, fiscal_request_json,
                fiscal_data_issue, fiscal_vat_groups_json, fiscal_fiscalized_at_source, fiscal_cu_serial,
                receipt_printed_at
         FROM orders WHERE created_at >= ? AND created_at < ? ORDER BY created_at ASC`
      )
      .all(startIso, endIso) as OrderRow[]
  }

  /**
   * One page of orders within an ISO-8601 date range, newest first, plus
   * the total row count for pagination — the Admin Reports invoice list
   * and CSV export (docs/phase-158). Distinct from
   * {@link getOrdersForDateRange}: that one is used for aggregation
   * (every row, no pagination, since a revenue sum needs all of them
   * anyway), this one is for display/export of a page at a time.
   *
   * @param {string} startIso
   * @param {string} endIso
   * @param {number} limit
   * @param {number} offset
   * @returns {{ rows: OrderRow[]; total: number }}
   */
  getOrderRowsForRange(
    startIso: string,
    endIso: string,
    limit: number,
    offset: number
  ): { rows: OrderRow[]; total: number } {
    const rows = this.conn
      .prepare(
        `SELECT local_id, shopify_order_id, total, status, created_at, payload_json, staff_id, payment_method,
                tendered_amount, change_due, reference_number, shift_id, fiscal_invoice_number, fiscal_qr_code,
                fiscal_fiscalized_at, fiscal_status, fiscal_error_reason, fiscal_error_kind, fiscal_request_json,
                fiscal_data_issue, fiscal_vat_groups_json, fiscal_fiscalized_at_source, fiscal_cu_serial,
                receipt_printed_at
         FROM orders WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT ? OFFSET ?`
      )
      .all(startIso, endIso, limit, offset) as OrderRow[]
    const { count } = this.conn
      .prepare('SELECT COUNT(*) as count FROM orders WHERE created_at >= ? AND created_at < ?')
      .get(startIso, endIso) as { count: number }
    return { rows, total: count }
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
        'SELECT local_id, shopify_order_id, total, status, created_at, payload_json, fiscal_invoice_number, fiscal_qr_code, fiscal_fiscalized_at, fiscal_status, fiscal_error_reason, fiscal_error_kind, fiscal_request_json, fiscal_data_issue, fiscal_vat_groups_json, fiscal_fiscalized_at_source, fiscal_cu_serial, receipt_printed_at FROM orders ORDER BY created_at DESC LIMIT ? OFFSET ?'
      )
      .all(limit, offset) as OrderRow[]
  }

  /**
   * The back-office "needs attention" list (phase-88/Step 4): every
   * `needs_fixing` order, plus every `waiting` order whose OWN
   * `created_at` is older than `now - stuckWaitingThresholdMs` — see
   * {@link STUCK_WAITING_THRESHOLD_MS}'s doc for why this is keyed off
   * the sale's own age rather than the retry queue's bookkeeping.
   * Oldest first, so the sale that's waited longest surfaces first.
   * Voided orders are excluded — they must never be filed (phase-131).
   * `now`/`stuckWaitingThresholdMs` are explicit parameters (not read
   * from `Date.now()` internally) so tests can drive the threshold
   * deterministically, matching {@link getPendingFiscalQueue}'s own
   * `now` convention.
   *
   * @param {number} now
   * @param {number} stuckWaitingThresholdMs
   * @returns {NeedsAttentionRow[]}
   */
  getOrdersNeedingAttention(now: number, stuckWaitingThresholdMs: number): NeedsAttentionRow[] {
    const cutoff = new Date(now - stuckWaitingThresholdMs).toISOString()
    return this.conn
      .prepare(
        `SELECT o.local_id, o.created_at, o.total, s.name AS staff_name,
                o.fiscal_status, o.fiscal_error_reason, o.fiscal_error_kind, o.fiscal_data_issue
         FROM orders o
         LEFT JOIN staff s ON s.id = o.staff_id
         WHERE (o.fiscal_status = 'needs_fixing'
            OR (o.fiscal_status = 'waiting' AND o.created_at <= ?))
           AND o.status != 'voided'
         ORDER BY o.created_at ASC, o.local_id ASC`
      )
      .all(cutoff) as NeedsAttentionRow[]
  }

  /**
   * The Rule-3 safety-net number: every completed sale not yet filed
   * with eTIMS, `waiting` or `needs_fixing`, regardless of how long —
   * unlike {@link getOrdersNeedingAttention}, not gated on the stuck
   * threshold, so this always reflects the true total. Voided orders are
   * excluded, so a historical void can never hold the count above zero.
   *
   * @returns {number}
   */
  getUnfiledOrderCount(): number {
    const row = this.conn
      .prepare(
        `SELECT COUNT(*) as count FROM orders WHERE fiscal_status IN ('waiting', 'needs_fixing') AND status != 'voided'`
      )
      .get() as { count: number }
    return row.count
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
   * Voids a local `pending_sync` order: marks the order `voided` and
   * removes any outstanding `sync_queue` entries (both `'order'` and
   * `'etims_invoice'`) so a voided sale is never pushed to Shopify or
   * retried for fiscalization after the fact.
   *
   * Deliberately does **not** touch `products.inventory_quantity`.
   * Shopify is the only source of truth for stock: a `pending_sync`
   * order has not reached Shopify, so Shopify's quantity was never
   * decremented and there is nothing to reverse. The increment this
   * method used to run had no matching decrement anywhere in the app
   * (a sale leaves the cache alone — `orderCreate`'s
   * `inventoryBehaviour` makes Shopify do the arithmetic), so it only
   * ever inflated the cached figure above Shopify's until the next
   * `products:fetch` overwrote it.
   *
   * Restricted to `pending_sync` orders — see `voids.ts` for the
   * caller-facing validation and {@link RubisDatabase.getOrder} for
   * reading the order first.
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

    const voidedAt = new Date().toISOString()

    const markVoided = this.conn.prepare('UPDATE orders SET status = ? WHERE local_id = ?')
    const clearQueue = this.conn.prepare(
      "DELETE FROM sync_queue WHERE entity_type = 'order' AND entity_id = ?"
    )
    const clearFiscalQueue = this.conn.prepare(
      "DELETE FROM sync_queue WHERE entity_type = 'etims_invoice' AND entity_id = ?"
    )

    const settle = this.conn.transaction(() => {
      markVoided.run('voided', localId)
      clearQueue.run(localId)
      clearFiscalQueue.run(localId)
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
   * One page of shift history, most recently opened first — the Admin
   * Reports shift-history screen (docs/phase-158); previously nothing
   * queried more than the single open shift (`getOpenShift`) or one shift
   * by id (docs/phase-157 Part 3, G1).
   *
   * @param {number} limit
   * @param {number} offset
   * @returns {ShiftRow[]}
   */
  listShifts(limit: number, offset: number): ShiftRow[] {
    return this.conn
      .prepare('SELECT * FROM shifts ORDER BY id DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as ShiftRow[]
  }

  /**
   * Total number of shifts ever opened — the shift-history screen's page
   * count.
   *
   * @returns {number}
   */
  countShifts(): number {
    const row = this.conn.prepare('SELECT COUNT(*) as count FROM shifts').get() as {
      count: number
    }
    return row.count
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

  /**
   * Logs a newly initiated M-Pesa STK Push attempt as `'pending'` —
   * {@link updateMpesaTransactionStatus} records the eventual outcome
   * once a "Check Status" query resolves it (no callback receiver
   * exists yet to update this automatically).
   *
   * @param {LogMpesaTransactionInput} data
   * @returns {{ id: number }}
   */
  logMpesaTransaction(data: LogMpesaTransactionInput): { id: number } {
    const info = this.conn
      .prepare(
        'INSERT INTO mpesa_transactions (order_local_id, checkout_request_id, merchant_request_id, phone_number, amount, status) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        data.orderLocalId ?? null,
        data.checkoutRequestId,
        data.merchantRequestId,
        data.phoneNumber,
        data.amount,
        data.status ?? 'pending'
      )
    return { id: Number(info.lastInsertRowid) }
  }

  /**
   * Records one M-Pesa confirmation message read off the modem.
   *
   * Deliberately idempotent: the inbox folder is re-read every few
   * seconds and its files are never deleted, so the overwhelmingly
   * common case is a message this till has already stored.
   * `ON CONFLICT DO NOTHING` on the unique transaction code makes that
   * free, and makes it impossible for one payment to become two
   * approvable rows however many times its message is read.
   *
   * A conflict never overwrites the stored row. If the same code somehow
   * arrives with different details, the first reading wins and stays
   * beside its `raw_text`, rather than a later re-read silently
   * rewriting a payment a cashier may already have approved.
   *
   * @param {InsertMpesaSmsMessageInput} data
   * @returns {{ inserted: boolean }} `false` when this code was already stored
   */
  insertMpesaSmsMessage(data: InsertMpesaSmsMessageInput): { inserted: boolean } {
    const info = this.conn
      .prepare(
        'INSERT INTO mpesa_sms_messages (transaction_code, amount, payer_name, payer_alias, masked_phone, account_reference, occurred_at, source_file, raw_text, created_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(transaction_code) DO NOTHING'
      )
      .run(
        data.transactionCode,
        data.amount,
        data.payerName,
        data.payerAlias,
        data.maskedPhone,
        data.accountReference,
        data.occurredAt,
        data.sourceFile,
        data.rawText,
        data.createdAt
      )
    return { inserted: info.changes > 0 }
  }

  /**
   * Looks up one confirmation message by its transaction code — the
   * cashier's type-or-scan flow, and the code lookup the SMS payment
   * provider verifies against.
   *
   * @param {string} transactionCode compared case-insensitively, since a cashier types it
   * @returns {MpesaSmsMessageRow | undefined}
   */
  getMpesaSmsMessageByCode(transactionCode: string): MpesaSmsMessageRow | undefined {
    return this.conn
      .prepare(
        'SELECT id, transaction_code, amount, payer_name, payer_alias, masked_phone, account_reference, occurred_at, source_file, raw_text, matched_order_local_id, approved_by_staff_id, approved_at, created_at FROM mpesa_sms_messages WHERE transaction_code = ? COLLATE NOCASE'
      )
      .get(transactionCode.trim()) as MpesaSmsMessageRow | undefined
  }

  /**
   * Returns recent confirmation messages that have not yet paid for a
   * sale, newest first — the list the cashier picks from.
   *
   * Matched messages are excluded outright rather than shown greyed:
   * a payment that has already been spent is not a candidate for this
   * sale, and offering it invites a double-credit.
   *
   * @param {string} since ISO-8601 lower bound on `created_at`
   * @param {number} [limit=20]
   * @returns {MpesaSmsMessageRow[]}
   */
  listUnmatchedMpesaSmsMessages(since: string, limit = 20): MpesaSmsMessageRow[] {
    return this.conn
      .prepare(
        'SELECT id, transaction_code, amount, payer_name, payer_alias, masked_phone, account_reference, occurred_at, source_file, raw_text, matched_order_local_id, approved_by_staff_id, approved_at, created_at FROM mpesa_sms_messages WHERE matched_order_local_id IS NULL AND created_at >= ? ORDER BY created_at DESC LIMIT ?'
      )
      .all(since, limit) as MpesaSmsMessageRow[]
  }

  /**
   * Returns recent M-Pesa transactions, newest first, for the M-Pesa
   * Logs screen.
   *
   * @param {number} [limit=50]
   * @returns {MpesaTransactionRow[]}
   */
  getMpesaTransactions(limit = 50): MpesaTransactionRow[] {
    return this.conn
      .prepare(
        'SELECT id, order_local_id, checkout_request_id, merchant_request_id, phone_number, amount, status, mpesa_receipt_number, created_at, updated_at FROM mpesa_transactions ORDER BY created_at DESC LIMIT ?'
      )
      .all(limit) as MpesaTransactionRow[]
  }

  /**
   * Queues an order and, in the **same transaction**, claims the M-Pesa
   * confirmation message that paid for it.
   *
   * The two facts have to land together. If the order were queued first
   * and the claim written after, a failure in between would leave a
   * completed sale whose payment still reads as unspent — free for the
   * next cashier to pick off the list and spend again. Claiming first
   * and queueing after has the mirror problem: a real payment consumed
   * by no sale. One transaction makes both true or neither.
   *
   * The claim is also the real gate, not a bookkeeping step after one.
   * `verifyTransactionCode` checked availability moments earlier, but
   * two checkouts can interleave across an `await` in between; the
   * conditional `UPDATE` here is what actually settles who gets the
   * payment, and the loser's order is rolled back rather than written.
   *
   * Idempotent: re-running with the same `localId` re-claims cleanly, so
   * a retry cannot double-mark or un-mark. A claim for a *different*
   * sale fails.
   *
   * @param {QueueOrderInput} input
   * @param {{ transactionCode: string; staffId: number }} claim
   * @param {RecordMpesaPaymentInput} [payment] — the unified payment record, written in the same transaction
   * @returns {{ localId: number; queueId: number } | null} `null` when another sale already used that payment
   */
  queueOrderClaimingSmsPayment(
    input: QueueOrderInput,
    claim: { transactionCode: string; staffId: number },
    payment?: RecordMpesaPaymentInput
  ): { localId: number; queueId: number } | null {
    const claimStatement = this.conn.prepare(
      'UPDATE mpesa_sms_messages SET matched_order_local_id = ?, approved_by_staff_id = ?, approved_at = ? ' +
        'WHERE transaction_code = ? COLLATE NOCASE AND (matched_order_local_id IS NULL OR matched_order_local_id = ?)'
    )

    const run = this.conn.transaction(() => {
      const queued = this.queueOrder(input)
      const info = claimStatement.run(
        queued.localId,
        claim.staffId,
        new Date().toISOString(),
        claim.transactionCode.trim(),
        queued.localId
      )
      if (info.changes === 0) {
        // Rolls the order back with it: no sale is recorded for a
        // payment this till could not claim.
        throw new PaymentUnavailableError()
      }
      if (payment) this.insertMpesaPayment(queued.localId, payment)
      return queued
    })

    try {
      return run()
    } catch (error) {
      if (error instanceof PaymentUnavailableError) return null
      throw error
    }
  }

  /**
   * Writes one `mpesa_payments` row against an order id.
   *
   * `ON CONFLICT DO NOTHING` rather than a hard failure, and the caller
   * decides whether that silence matters. A confirming mode must not
   * have its sale aborted by a bookkeeping row — and a duplicate there
   * means the pre-existing Daraja re-use residual
   * (`docs/phase-120.md` §10.2) has fired, which this change records but
   * does not attempt to fix. Manual entry treats the same conflict as
   * fatal, because for manual a repeated code is the abuse case rather
   * than a symptom.
   *
   * Private to the transactions below: a payment row may only be written
   * together with the sale it settled.
   *
   * @param {number} orderLocalId
   * @param {RecordMpesaPaymentInput} payment
   * @returns {boolean} `false` when `(mode, reference)` was already recorded
   */
  private insertMpesaPayment(orderLocalId: number, payment: RecordMpesaPaymentInput): boolean {
    const info = this.conn
      .prepare(
        'INSERT INTO mpesa_payments (order_local_id, mode, verification_status, reference, amount, entered_by_staff_id, approved_by_staff_id, created_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (mode, reference) DO NOTHING'
      )
      .run(
        orderLocalId,
        payment.mode,
        payment.verificationStatus,
        payment.reference,
        payment.amount,
        payment.enteredByStaffId,
        payment.approvedByStaffId ?? null,
        new Date().toISOString()
      )
    return info.changes > 0
  }

  /**
   * Queues an order and records the payment that settled it, in one
   * transaction — the confirming modes' path (Daraja, and a message-based
   * till that is not claiming a stored payment).
   *
   * A duplicate `(mode, reference)` is tolerated here; see
   * {@link RubisDatabase.insertMpesaPayment}.
   *
   * @param {QueueOrderInput} input
   * @param {RecordMpesaPaymentInput} payment
   * @returns {{ localId: number; queueId: number }}
   */
  queueOrderRecordingMpesaPayment(
    input: QueueOrderInput,
    payment: RecordMpesaPaymentInput
  ): { localId: number; queueId: number } {
    const run = this.conn.transaction(() => {
      const queued = this.queueOrder(input)
      this.insertMpesaPayment(queued.localId, payment)
      return queued
    })
    return run()
  }

  /**
   * Queues an order and records a **manually entered, unverified**
   * M-Pesa payment, in one transaction.
   *
   * The same atomicity argument as the SMS claim above: an unverified
   * sale whose payment record failed to write would be indistinguishable
   * from a confirmed one, which is the single thing this whole path must
   * never allow. Either both rows exist or neither does.
   *
   * Unlike the confirming modes, a duplicate code is **refused** and the
   * order rolled back with it. Nobody confirmed this payment, so a code
   * already used on another sale is the case most worth stopping.
   *
   * @param {QueueOrderInput} input
   * @param {RecordMpesaPaymentInput} payment
   * @returns {{ localId: number; queueId: number } | null} `null` when that code was already recorded
   */
  queueOrderRecordingManualPayment(
    input: QueueOrderInput,
    payment: RecordMpesaPaymentInput
  ): { localId: number; queueId: number } | null {
    const run = this.conn.transaction(() => {
      const queued = this.queueOrder(input)
      if (!this.insertMpesaPayment(queued.localId, payment)) {
        throw new PaymentUnavailableError()
      }
      return queued
    })

    try {
      return run()
    } catch (error) {
      if (error instanceof PaymentUnavailableError) return null
      throw error
    }
  }

  /**
   * Whether this reference has already settled a sale, **in any mode**.
   *
   * The manual route's cross-mode guard. `UNIQUE (mode, reference)`
   * alone would let the same M-Pesa code be typed in manually after it
   * had already been confirmed by Daraja or matched from a message, and
   * pay for a second sale — the codes are the same payment, so they must
   * not both settle.
   *
   * Used only by manual entry. The confirming modes keep the behaviour
   * they had, including the pre-existing Daraja re-use residual
   * (`docs/phase-120.md` §10.2), which this change records but does not
   * attempt to fix.
   *
   * @param {string} reference
   * @returns {boolean}
   */
  hasRecordedMpesaPayment(reference: string): boolean {
    const trimmed = reference.trim()
    if (!trimmed) return false
    const row = this.conn
      .prepare('SELECT 1 AS found FROM mpesa_payments WHERE reference = ? COLLATE NOCASE LIMIT 1')
      .get(trimmed) as { found: number } | undefined
    return row !== undefined
  }

  /**
   * Returns recent unified payment records, newest first.
   *
   * @param {number} [limit=100]
   * @returns {MpesaPaymentRow[]}
   */
  listMpesaPayments(limit = 100): MpesaPaymentRow[] {
    return this.conn
      .prepare('SELECT * FROM mpesa_payments ORDER BY id DESC LIMIT ?')
      .all(limit) as MpesaPaymentRow[]
  }

  /**
   * Returns every manually entered payment nobody has yet checked
   * against the M-Pesa statement — the reconciliation queue.
   *
   * Only `manual_unverified` rows appear: a Daraja or message-confirmed
   * payment was proven when it was taken and has nothing to reconcile.
   *
   * @returns {MpesaPaymentRow[]}
   */
  listUnreconciledMpesaPayments(): MpesaPaymentRow[] {
    return this.conn
      .prepare(
        "SELECT * FROM mpesa_payments WHERE verification_status = 'manual_unverified' AND reconciled_at IS NULL ORDER BY id ASC"
      )
      .all() as MpesaPaymentRow[]
  }

  /**
   * Marks one manual payment as checked against the M-Pesa statement.
   *
   * Deliberately does **not** change `verification_status`. The sale
   * completed on an unverified code and that stays true for ever;
   * reconciliation records that somebody later looked, not that the
   * original payment was confirmed at the till. Rewriting the status
   * would erase the only evidence that this sale took the exception
   * route.
   *
   * @param {number} paymentId
   * @param {number} reconciledByStaffId — the manager whose PIN was re-verified
   * @param {string | null} note
   * @returns {boolean} `false` when the row is absent or already reconciled
   */
  markMpesaPaymentReconciled(
    paymentId: number,
    reconciledByStaffId: number,
    note: string | null
  ): boolean {
    const info = this.conn
      .prepare(
        'UPDATE mpesa_payments SET reconciled_at = ?, reconciled_by_staff_id = ?, reconciliation_note = ? WHERE id = ? AND reconciled_at IS NULL'
      )
      .run(new Date().toISOString(), reconciledByStaffId, note, paymentId)
    return info.changes > 0
  }

  /**
   * Every M-Pesa payment (any mode) whose order was created within an
   * ISO-8601 range `[startIso, endIso)`, with the order's own status
   * carried along as `status` — the same field name `excludeVoided` in
   * `reports.ts` already filters on, so the end-of-day report reuses that
   * one voided-order rule instead of re-deriving it here.
   *
   * @param {string} startIso
   * @param {string} endIso
   * @returns {Array<MpesaPaymentRow & { status: OrderStatus }>}
   */
  getMpesaPaymentsForDateRange(
    startIso: string,
    endIso: string
  ): Array<MpesaPaymentRow & { status: OrderStatus }> {
    return this.conn
      .prepare(
        `SELECT mp.*, o.status as status FROM mpesa_payments mp
         JOIN orders o ON o.local_id = mp.order_local_id
         WHERE o.created_at >= ? AND o.created_at < ?
         ORDER BY o.created_at ASC`
      )
      .all(startIso, endIso) as Array<MpesaPaymentRow & { status: OrderStatus }>
  }

  /**
   * Every M-Pesa payment (any mode) whose order belongs to `shiftId`,
   * with the order's own status carried along as `status` — the
   * Z-report's manual/Daraja split (docs/phase-158), mirroring
   * {@link getMpesaPaymentsForDateRange}'s join exactly, keyed by shift
   * instead of by date range.
   *
   * @param {number} shiftId
   * @returns {Array<MpesaPaymentRow & { status: OrderStatus }>}
   */
  getMpesaPaymentsForShift(shiftId: number): Array<MpesaPaymentRow & { status: OrderStatus }> {
    return this.conn
      .prepare(
        `SELECT mp.*, o.status as status FROM mpesa_payments mp
         JOIN orders o ON o.local_id = mp.order_local_id
         WHERE o.shift_id = ?
         ORDER BY o.created_at ASC`
      )
      .all(shiftId) as Array<MpesaPaymentRow & { status: OrderStatus }>
  }

  /**
   * Manual M-Pesa entries recorded before `beforeIso` that no approval —
   * neither the old per-payment reconciliation nor an end-of-day
   * approval — has ever covered. The carry-over an end-of-day report
   * keeps surfacing until a manager approves it, however many days that
   * takes.
   *
   * @param {string} beforeIso
   * @returns {Array<MpesaPaymentRow & { status: OrderStatus }>}
   */
  getUnapprovedManualPaymentsBefore(
    beforeIso: string
  ): Array<MpesaPaymentRow & { status: OrderStatus }> {
    return this.conn
      .prepare(
        `SELECT mp.*, o.status as status FROM mpesa_payments mp
         JOIN orders o ON o.local_id = mp.order_local_id
         WHERE mp.mode = 'manual' AND mp.reconciled_at IS NULL AND o.created_at < ?
         ORDER BY o.created_at ASC`
      )
      .all(beforeIso) as Array<MpesaPaymentRow & { status: OrderStatus }>
  }

  /**
   * @param {number} id
   * @returns {MpesaDayApprovalRow | undefined}
   */
  getMpesaDayApprovalById(id: number): MpesaDayApprovalRow | undefined {
    return this.conn
      .prepare('SELECT * FROM mpesa_day_approvals WHERE id = ?')
      .get(id) as MpesaDayApprovalRow | undefined
  }

  /**
   * The most recent exclusion recorded for each of the given payment ids
   * (docs/phase-153), if any — carry-over uses this to show why an entry
   * was left out last time, and by which day/approval. `id = MAX(id)`
   * per `payment_id` picks the latest one when an entry has been left
   * out more than once across several review cycles.
   *
   * @param {number[]} paymentIds
   * @returns {Array<{ payment_id: number; reason: string | null; local_day: string; approved_by_staff_id: number }>}
   */
  getLatestExclusionsForPayments(
    paymentIds: number[]
  ): Array<{ payment_id: number; reason: string | null; local_day: string; approved_by_staff_id: number }> {
    if (paymentIds.length === 0) return []
    const placeholders = paymentIds.map(() => '?').join(', ')
    return this.conn
      .prepare(
        `SELECT e.payment_id, e.reason, a.local_day, a.approved_by_staff_id
         FROM mpesa_day_exclusions e
         JOIN mpesa_day_approvals a ON a.id = e.approval_id
         WHERE e.payment_id IN (${placeholders})
           AND e.id = (SELECT MAX(id) FROM mpesa_day_exclusions e2 WHERE e2.payment_id = e.payment_id)`
      )
      .all(...paymentIds) as Array<{
      payment_id: number
      reason: string | null
      local_day: string
      approved_by_staff_id: number
    }>
  }

  /**
   * Applies one approval's UPDATE to the manual payments it approved.
   *
   * Split out from {@link RubisDatabase.approveMpesaEntries} only so a
   * test can force a mid-transaction failure right here and prove the
   * whole review — including the `mpesa_day_approvals` row
   * `approveMpesaEntries` inserts just before calling this, and any
   * `mpesa_day_exclusions` rows it inserts just after — rolls back
   * together. better-sqlite3's `transaction()` wrapper rolls back
   * everything since the last commit on any throw, not only the
   * statement that threw; this method's only job is to be that
   * throwable statement in a test.
   *
   * @param {number[]} paymentIds
   * @param {number} managerId
   * @param {string} reconciliationNote
   * @param {string} nowIso
   */
  private markMpesaPaymentsApproved(
    paymentIds: number[],
    managerId: number,
    reconciliationNote: string,
    nowIso: string
  ): void {
    const placeholders = paymentIds.map(() => '?').join(', ')
    this.conn
      .prepare(
        `UPDATE mpesa_payments SET reconciled_at = ?, reconciled_by_staff_id = ?, reconciliation_note = ? ` +
          `WHERE id IN (${placeholders}) AND reconciled_at IS NULL`
      )
      .run(nowIso, managerId, reconciliationNote, ...paymentIds)
  }

  /**
   * Looks up the earlier day approval that already covers every one of
   * `ids` — the phase-152 "already approved, nothing to redo" path,
   * unchanged by phase-153's per-entry exclusions. `null` when those ids
   * were instead settled one-by-one on the older per-payment
   * Reconciliation page, which writes no `Approved in day report #…`
   * note this can trace back to.
   *
   * @param {number[]} ids
   * @returns {ApproveMpesaEntriesResult}
   */
  private lookupPriorDayApproval(ids: number[]): ApproveMpesaEntriesResult {
    const placeholders = ids.map(() => '?').join(', ')
    const priorNoteRow = this.conn
      .prepare(
        `SELECT reconciliation_note FROM mpesa_payments WHERE id IN (${placeholders}) AND reconciliation_note LIKE 'Approved in day report #%' ORDER BY reconciled_at DESC LIMIT 1`
      )
      .get(...ids) as { reconciliation_note: string } | undefined

    const priorApprovalId = priorNoteRow
      ? Number(priorNoteRow.reconciliation_note.replace('Approved in day report #', ''))
      : null
    const priorApproval =
      priorApprovalId !== null ? (this.getMpesaDayApprovalById(priorApprovalId) ?? null) : null

    return { approval: priorApproval, approvedCount: 0, excludedCount: 0, alreadyApproved: true }
  }

  /**
   * A manager's end-of-day review of a batch of manual M-Pesa entries
   * (docs/phase-150.md deferred approval to this; docs/phase-151/152
   * built the day approval; docs/phase-153 lets the manager leave
   * individual entries out) — the only check these entries get, since
   * Step 3 removed the per-sale manager PIN.
   *
   * Bound to exactly the ids passed in — the ids an end-of-day report
   * actually displayed — never "every unapproved manual entry as of
   * now". An entry recorded after that report was generated is
   * therefore never swept in by it; it stays pending and appears on the
   * next report instead. Left-out entries stay pending too, by design —
   * `mpesa_payments` is never touched for them — but the exclusion
   * itself, and why, is recorded so that decision isn't silently lost.
   *
   * Every id in `approvedIds`/`excluded` must currently be a manual,
   * still-pending entry, or the whole call is refused — **except** the
   * one case phase-152 already handled: `excluded` empty and every
   * `approvedId` already reconciled, which is reported as already
   * approved (see {@link RubisDatabase.lookupPriorDayApproval}) rather
   * than refused, so a manager re-opening an already-approved report and
   * pressing the button again doesn't hit an error.
   *
   * `approvedIds` and `excluded` may not both be empty — the caller
   * (`approveDayReportSchema`) already enforces this, along with no id
   * appearing twice or in both lists; this method still refuses an empty
   * call defensively, since it is also reachable directly (as tests do).
   *
   * @param {number[]} approvedIds — exactly the ids to approve
   * @param {Array<{ paymentId: number; reason: string | null }>} excluded — entries deliberately left pending, with why
   * @param {number} managerId — the re-verified admin's id
   * @param {string} localDay — which day's report this review is for
   * @param {string | null} note — optional manager note, stored once on the approval, not repeated per row
   * @returns {ApproveMpesaEntriesResult}
   * @throws if both `approvedIds` and `excluded` are empty, or if any
   *   given id is not a currently-pending manual entry (outside the
   *   already-approved exception above)
   */
  approveMpesaEntries(
    approvedIds: number[],
    excluded: Array<{ paymentId: number; reason: string | null }>,
    managerId: number,
    localDay: string,
    note: string | null
  ): ApproveMpesaEntriesResult {
    const uniqueApprovedIds = Array.from(new Set(approvedIds))
    const uniqueExcludedIds = Array.from(new Set(excluded.map((entry) => entry.paymentId)))

    if (uniqueApprovedIds.length === 0 && uniqueExcludedIds.length === 0) {
      throw new Error('No entries given to record')
    }

    const allIds = Array.from(new Set([...uniqueApprovedIds, ...uniqueExcludedIds]))
    const placeholders = allIds.map(() => '?').join(', ')
    const rows = this.conn
      .prepare(`SELECT id, mode, reconciled_at, amount FROM mpesa_payments WHERE id IN (${placeholders})`)
      .all(...allIds) as Array<{
      id: number
      mode: MpesaPaymentMode
      reconciled_at: string | null
      amount: number
    }>
    const byId = new Map(rows.map((row) => [row.id, row]))

    const isPendingManual = (id: number): boolean => {
      const row = byId.get(id)
      return row !== undefined && row.mode === 'manual' && row.reconciled_at === null
    }

    const everyApprovedAlreadyDone =
      uniqueApprovedIds.length > 0 &&
      uniqueApprovedIds.every((id) => {
        const row = byId.get(id)
        return row !== undefined && row.mode === 'manual' && row.reconciled_at !== null
      })

    if (uniqueExcludedIds.length === 0 && everyApprovedAlreadyDone) {
      return this.lookupPriorDayApproval(uniqueApprovedIds)
    }

    if (!allIds.every(isPendingManual)) {
      throw new Error(
        'One or more entries are not a manual, still-pending payment — refresh the report and try again'
      )
    }

    const run = this.conn.transaction(() => {
      const nowIso = new Date().toISOString()
      const totalAmount = uniqueApprovedIds.reduce((sum, id) => sum + (byId.get(id)?.amount ?? 0), 0)

      const insert = this.conn
        .prepare(
          'INSERT INTO mpesa_day_approvals (local_day, approved_by_staff_id, approved_at, entry_count, excluded_count, total_amount, note) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          localDay,
          managerId,
          nowIso,
          uniqueApprovedIds.length,
          uniqueExcludedIds.length,
          totalAmount,
          note
        )
      const approvalId = Number(insert.lastInsertRowid)

      if (uniqueApprovedIds.length > 0) {
        this.markMpesaPaymentsApproved(
          uniqueApprovedIds,
          managerId,
          `Approved in day report #${approvalId}`,
          nowIso
        )
      }

      if (excluded.length > 0) {
        const insertExclusion = this.conn.prepare(
          'INSERT INTO mpesa_day_exclusions (approval_id, payment_id, reason) VALUES (?, ?, ?)'
        )
        for (const entry of excluded) {
          insertExclusion.run(approvalId, entry.paymentId, entry.reason)
        }
      }

      return approvalId
    })

    const approvalId = run()
    const approval = this.getMpesaDayApprovalById(approvalId)
    if (!approval) {
      throw new Error(`Approval ${approvalId} vanished immediately after being recorded`)
    }
    return {
      approval,
      approvedCount: uniqueApprovedIds.length,
      excludedCount: uniqueExcludedIds.length,
      alreadyApproved: false
    }
  }

  /**
   * Whether this till's own record shows the given reference as a
   * completed STK Push payment.
   *
   * The payment gate for a Daraja till. Daraja has no receipt-lookup
   * endpoint, so a reference cannot be checked against Safaricom at
   * checkout time — but it can be checked against what this process
   * already wrote down: `mpesa:query-status` persists `status` and
   * `mpesa_receipt_number` straight from Daraja's own status response.
   * Matching against that is a real confirmation, sourced from
   * Safaricom, rather than trusting a string the renderer sent.
   *
   * Both identifiers are accepted because `PaymentModal` falls back to
   * the `checkoutRequestId` when a successful status query carries no
   * receipt number.
   *
   * @param {string} reference the receipt number or checkout request id
   * @returns {boolean}
   */
  hasConfirmedStkPayment(reference: string): boolean {
    const trimmed = reference.trim()
    if (!trimmed) return false

    const row = this.conn
      .prepare(
        "SELECT 1 AS found FROM mpesa_transactions WHERE status = 'success' AND (mpesa_receipt_number = ? COLLATE NOCASE OR checkout_request_id = ? COLLATE NOCASE) LIMIT 1"
      )
      .get(trimmed, trimmed) as { found: number } | undefined
    return row !== undefined
  }

  /**
   * Records the outcome of an STK Push status query against its
   * logged transaction. Safe to call repeatedly with the same
   * `status` — each call simply overwrites the row rather than
   * accumulating state, so re-checking an already-resolved
   * transaction is a no-op in effect.
   *
   * @param {string} checkoutRequestId
   * @param {MpesaTransactionStatus} status
   * @param {string} [mpesaReceiptNumber]
   * @returns {boolean} `true` if a matching transaction was updated
   */
  updateMpesaTransactionStatus(
    checkoutRequestId: string,
    status: MpesaTransactionStatus,
    mpesaReceiptNumber?: string
  ): boolean {
    const info = this.conn
      .prepare(
        'UPDATE mpesa_transactions SET status = ?, mpesa_receipt_number = ?, updated_at = CURRENT_TIMESTAMP WHERE checkout_request_id = ?'
      )
      .run(status, mpesaReceiptNumber ?? null, checkoutRequestId)
    return info.changes > 0
  }

  /**
   * Reads one `app_configurations` value.
   *
   * @param {string} key
   * @returns the stored value, or `null` when unset
   */
  getConfig(key: string): string | null {
    const row = this.conn
      .prepare('SELECT value FROM app_configurations WHERE key = ?')
      .get(key) as { value: string | null } | undefined
    return row ? (row.value ?? null) : null
  }

  /**
   * Upserts one `app_configurations` value. Metadata (`encrypted`,
   * `requiresRestart`, `category`) is only applied on first insert or
   * when explicitly passed — omitting `options` on an update leaves
   * the row's existing metadata untouched rather than resetting it to
   * defaults.
   *
   * @param {string} key
   * @param {string} value
   * @param {SetConfigOptions} [options]
   */
  setConfig(key: string, value: string, options: SetConfigOptions = {}): void {
    const existing = this.conn
      .prepare('SELECT encrypted, requires_restart, category FROM app_configurations WHERE key = ?')
      .get(key) as { encrypted: number; requires_restart: number; category: AppConfigCategory } | undefined

    const encrypted = options.encrypted ?? (existing ? existing.encrypted === 1 : false)
    const requiresRestart = options.requiresRestart ?? (existing ? existing.requires_restart === 1 : false)
    const category = options.category ?? existing?.category ?? 'general'

    this.conn
      .prepare(
        'INSERT INTO app_configurations (key, value, encrypted, requires_restart, category, last_updated) ' +
          'VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value, encrypted = excluded.encrypted, ' +
          'requires_restart = excluded.requires_restart, category = excluded.category, last_updated = excluded.last_updated'
      )
      .run(key, value, encrypted ? 1 : 0, requiresRestart ? 1 : 0, category)
  }

  /**
   * Returns every `app_configurations` value as a flat key/value map,
   * optionally scoped to one category.
   *
   * @param {AppConfigCategory} [category]
   * @returns {Record<string, string>}
   */
  getAllConfigs(category?: AppConfigCategory): Record<string, string> {
    const rows = (
      category
        ? this.conn
            .prepare('SELECT key, value FROM app_configurations WHERE category = ?')
            .all(category)
        : this.conn.prepare('SELECT key, value FROM app_configurations').all()
    ) as Array<{ key: string; value: string | null }>
    const result: Record<string, string> = {}
    for (const row of rows) {
      if (row.value !== null) result[row.key] = row.value
    }
    return result
  }

  /**
   * Returns every `app_configurations` row flagged `requires_restart`
   * — used to warn the Admin screen that a just-saved change won't
   * take effect until the app relaunches.
   *
   * @returns {AppConfigRow[]}
   */
  getRestartRequiredConfigs(): AppConfigRow[] {
    const rows = this.conn
      .prepare(
        'SELECT key, value, encrypted, requires_restart, category, last_updated FROM app_configurations WHERE requires_restart = 1'
      )
      .all() as Array<{
      key: string
      value: string | null
      encrypted: number
      requires_restart: number
      category: AppConfigCategory
      last_updated: string
    }>
    return rows.map((row) => ({
      ...row,
      encrypted: row.encrypted === 1,
      requires_restart: row.requires_restart === 1
    }))
  }

  /**
   * Opens a stock-take session with its frozen opening observation.
   *
   * @param {CreateStockTakeSessionInput} input
   * @returns {{ sessionId: number }}
   */
  createStockTakeSession(input: CreateStockTakeSessionInput): { sessionId: number } {
    const info = this.conn
      .prepare(
        'INSERT INTO stock_take_sessions (session_uuid, location_id, status, opened_at, counted_by_staff_id, opening_levels_json) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        input.sessionUuid,
        input.locationId,
        'open',
        input.openedAt,
        input.countedByStaffId,
        JSON.stringify(input.openingLevels)
      )
    return { sessionId: Number(info.lastInsertRowid) }
  }

  /**
   * Returns the one session that is still being worked on, if any.
   *
   * A till runs at most one stock take at a time: two concurrent
   * sessions would each snapshot the same shelf and each push a delta
   * for it, double-correcting the variance.
   *
   * @returns {StockTakeSessionRow | undefined}
   */
  getActiveStockTakeSession(): StockTakeSessionRow | undefined {
    return this.conn
      .prepare(
        "SELECT * FROM stock_take_sessions WHERE status IN ('open', 'counting', 'awaiting_approval') ORDER BY id DESC LIMIT 1"
      )
      .get() as StockTakeSessionRow | undefined
  }

  /**
   * Reads one stock-take session by local id.
   *
   * @param {number} sessionId
   * @returns {StockTakeSessionRow | undefined}
   */
  getStockTakeSession(sessionId: number): StockTakeSessionRow | undefined {
    return this.conn
      .prepare('SELECT * FROM stock_take_sessions WHERE id = ?')
      .get(sessionId) as StockTakeSessionRow | undefined
  }

  /**
   * Returns stock-take sessions, newest first.
   *
   * @param {number} [limit=20]
   * @returns {StockTakeSessionRow[]}
   */
  listStockTakeSessions(limit = 20): StockTakeSessionRow[] {
    return this.conn
      .prepare('SELECT * FROM stock_take_sessions ORDER BY id DESC LIMIT ?')
      .all(limit) as StockTakeSessionRow[]
  }

  /**
   * Returns one session's counted items, in scan order.
   *
   * @param {number} sessionId
   * @returns {StockTakeItemRow[]}
   */
  getStockTakeItems(sessionId: number): StockTakeItemRow[] {
    return this.conn
      .prepare('SELECT * FROM stock_take_items WHERE session_id = ? ORDER BY id ASC')
      .all(sessionId) as StockTakeItemRow[]
  }

  /**
   * Records (or corrects) one counted variant and moves the session to
   * `counting`.
   *
   * Re-counting the same variant replaces the row rather than adding a
   * second one — a recount before close is a correction, not a new
   * fact. Once the session closes nothing here is writable again;
   * corrections are a whole new session.
   *
   * @param {RecordStockTakeCountInput} input
   */
  recordStockTakeCount(input: RecordStockTakeCountInput): void {
    const upsert = this.conn.prepare(
      `INSERT INTO stock_take_items (session_id, variant_id, inventory_item_id, variant_label, unit_price_at_count, system_snapshot_qty, snapshot_taken_at, counted_qty, variance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (session_id, variant_id) DO UPDATE SET
         counted_qty = excluded.counted_qty,
         variance = excluded.variance,
         unit_price_at_count = excluded.unit_price_at_count,
         variant_label = excluded.variant_label`
    )
    const touchStatus = this.conn.prepare(
      "UPDATE stock_take_sessions SET status = 'counting' WHERE id = ? AND status = 'open'"
    )
    const settle = this.conn.transaction(() => {
      upsert.run(
        input.sessionId,
        input.variantId,
        input.inventoryItemId,
        input.variantLabel,
        input.unitPriceAtCount,
        input.systemSnapshotQty,
        input.snapshotTakenAt,
        input.countedQty,
        input.countedQty - input.systemSnapshotQty
      )
      touchStatus.run(input.sessionId)
    })
    settle()
  }

  /**
   * Drops one counted row from an uncommitted session — a mis-scan
   * removed before the count is submitted.
   *
   * @param {number} sessionId
   * @param {string} variantId
   */
  removeStockTakeCount(sessionId: number, variantId: string): void {
    this.conn
      .prepare('DELETE FROM stock_take_items WHERE session_id = ? AND variant_id = ?')
      .run(sessionId, variantId)
  }

  /**
   * Moves a session between its pre-commit states.
   *
   * Never reaches `committed` — that transition belongs to
   * {@link RubisDatabase.commitStockTakeSession}, which writes the
   * reference uri in the same transaction.
   *
   * @param {number} sessionId
   * @param {Exclude<StockTakeStatus, 'committed'>} status
   */
  setStockTakeStatus(sessionId: number, status: Exclude<StockTakeStatus, 'committed'>): void {
    this.conn
      .prepare("UPDATE stock_take_sessions SET status = ? WHERE id = ? AND status != 'committed'")
      .run(status, sessionId)
  }

  /**
   * Closes a session as committed and records what Shopify did.
   *
   * One transaction, and `committed_reference_uri` is `UNIQUE`: a
   * second commit of the same session fails at the database rather
   * than at a check some later caller might forget to run.
   *
   * @param {CommitStockTakeSessionInput} input
   * @throws if the session was already committed (uniqueness violation)
   */
  commitStockTakeSession(input: CommitStockTakeSessionInput): void {
    const closeSession = this.conn.prepare(
      `UPDATE stock_take_sessions
       SET status = 'committed', committed_at = ?, committed_reference_uri = ?,
           approved_by_staff_id = ?, second_approver_staff_id = ?, shopify_response_json = ?
       WHERE id = ? AND status != 'committed'`
    )
    const recordOutcome = this.conn.prepare(
      'UPDATE stock_take_items SET fresh_qty_at_commit = ?, delta_pushed = ?, commit_status = ?, commit_error = ? WHERE session_id = ? AND variant_id = ?'
    )
    const settle = this.conn.transaction(() => {
      const info = closeSession.run(
        input.committedAt,
        input.committedReferenceUri,
        input.approvedByStaffId,
        input.secondApproverStaffId,
        input.shopifyResponseJson,
        input.sessionId
      )
      if (info.changes === 0) {
        throw new Error(`Stock take ${input.sessionId} has already been committed`)
      }
      for (const outcome of input.outcomes) {
        recordOutcome.run(
          outcome.freshQtyAtCommit,
          outcome.deltaPushed,
          outcome.commitStatus,
          outcome.commitError,
          input.sessionId,
          outcome.variantId
        )
      }
    })
    settle()
  }

  /**
   * Reads one variant's cached selling price, used to value a counted
   * variance in shillings.
   *
   * Read server-side rather than taken from the renderer so the figure
   * the variance threshold is judged against cannot be understated by
   * the caller. Price is not stock — reading it implies nothing about
   * the cached quantity, which the stock take never touches.
   *
   * @param {string} variantId
   * @returns {number | undefined}
   */
  getCachedVariantPrice(variantId: string): number | undefined {
    const row = this.conn
      .prepare('SELECT price FROM products WHERE variant_id = ?')
      .get(variantId) as { price: number } | undefined
    return row?.price
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
