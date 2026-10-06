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

import type { VatReconcileOrderRow } from './vat-reconcile.js'
import { sameWindow, shiftWindowOf, type ShiftType, type ShiftWindowInstance } from '../lib/shiftWindows.js'
import { findOverlappingShift } from '../lib/pastShift.js'
import { describePayment, methodTotalOf, type PaymentLeg, type SalePayment } from '../lib/paymentLegs.js'
import { planAutoAssignment } from '../lib/autoAssign.js'
import {
  AUTO_MERGE_REASON,
  AUTO_SHIFT_REASON,
  closedShiftKeepsSalesMessage,
  frozenShiftMessage,
  OPENED_WITH_EARLIER_SALES_REASON,
  OVERRIDE_ADMIN_ONLY_MESSAGE,
  OVERRIDE_REASON_MESSAGE,
  OVERRIDE_REASON_MIN_LENGTH,
  OVERRIDE_REASON_PREFIX,
  STALE_EARLIER_SALES_MESSAGE,
  drawerBelowEarlierMessage,
  mpesaBelowEarlierMessage,
  startedAtZeroReason,
  windowHasShiftMessage
} from '../lib/shiftRules.js'
import {
  sameEnteredFigures,
  workShiftFigures,
  type ShiftEnteredFigures,
  type ShiftWorkedFigures
} from '../lib/shiftFigures.js'
import { UNVERIFIABLE_RETRY_REASON } from './integrations/real-etims-provider.js'
import { buildLocationTraderInvNum, nextTraderSeq } from '../lib/traderSystemInvoiceNumber.js'
import { MAX_HELD_LABEL_LENGTH, MAX_HELD_SALES } from '../lib/heldSaleRules.js'

/** The `settings` key holding the last trader sequence value this till used (docs/phase-211). */
const TRADER_SEQ_SETTING_KEY = 'last_trader_seq'
import BetterSqlite3 from 'better-sqlite3'
import type { Database as SqliteConnection } from 'better-sqlite3'
import type { Discount, OfflineOrderPayload } from './shopify-types.js'
import type { CartItem, ProductSummary } from '../../renderer/src/types/shopify.js'
import type {
  FiscalFailureKind,
  FiscalInvoiceRequest,
  FiscalInvoiceResult,
  FiscalVatGroupAmounts
} from './integrations/etims.js'

/** Lifecycle states of a local order row. */
export type OrderStatus = 'pending_sync' | 'synced' | 'failed' | 'voided'

/** Accepted payment methods at checkout, and the method of each payment of a sale. */
export type PaymentMethod = 'cash' | 'mpesa' | 'card'

/** How a sale was paid, as `orders.payment_method` holds it: one method, or `split` for more than one payment (docs/phase-252). */
export type OrderPaymentMethod = PaymentMethod | 'split'

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
  payment_method: OrderPaymentMethod | null
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
   * The fiscal receipt physically printed at — set only when BOTH: the
   * print was a real physical print (never the PDF fallback), AND the
   * order was fiscalised, so the printed page actually carried the CU
   * block (docs/phase-164-1; narrowed from docs/phase-164's original
   * "any successful print, PDF fallback included" meaning — a PDF or a
   * plain, unfiled sale's slip is never THE fiscal receipt going out on
   * paper, so neither one may claim to be "the original"). `null` until
   * that happens, however many times the sale is printed before then.
   * Write-once: the FIRST such print sets it, and every later print of
   * the same sale (of any kind) sees it already set, so it can be
   * stamped "DUPLICATE" rather than mistaken for the original. Set by
   * {@link RubisDatabase.markReceiptPrinted}, read by
   * {@link RubisDatabase.hasReceiptPrinted}.
   */
  receipt_printed_at: string | null
  /**
   * The trader invoice number the till sent to the device for this sale, stored
   * when it was sent (docs/phase-198). Write-once, never recomputed; `null` for a
   * sale that was never sent and for every sale filed before this column existed.
   */
  fiscal_trader_inv_num?: string | null
  /**
   * Set when a sale was filed later by the fiscal queue and its fiscal slip could not
   * be printed (docs/phase-198). Cleared when that slip is printed. Never retried.
   */
  fiscal_slip_unprinted_at?: string | null
  /**
   * When the Enjoy customer slip first physically reached paper (docs/phase-198-1).
   * Write-once; a PDF fallback or a failed print never sets it. The slip is
   * stamped DUPLICATE only when this is already set at the time of printing.
   */
  customer_slip_printed_at?: string | null
}

/** Which slip of a sale a reprint was (docs/phase-198). */
export type ReceiptReprintSlip = 'fiscal' | 'enjoy'

/** One row of `receipt_reprints` (docs/phase-198). */
export interface ReceiptReprintRow {
  id: number
  order_id: number
  slip: ReceiptReprintSlip
  /** The cashier signed in when the slip was reprinted, or `null` when the request carried none. */
  staff_id: number | null
  at: string
}

/** A filed sale whose fiscal slip never reached paper, for the Needs Attention list (docs/phase-198). */
export interface UnprintedFiscalSlipRow {
  local_id: number
  created_at: string
  total: number
  staff_name: string | null
  fiscal_slip_unprinted_at: string
}

/** The one saved cart on this till (docs/phase-197) - a draft, never pushed anywhere. */
export interface CartDraftRow {
  payload_json: string
  updated_at: string
}

/** Where a held sale stands (docs/phase-217). `held` and `resumed` are the open ones. */
export type HeldSaleStatus = 'held' | 'resumed' | 'completed' | 'discarded'

/** One held sale as the renderer lists it: no lines, which come back only on resume. */
export interface HeldSaleSummary {
  id: number
  cartToken: string
  label: string
  /** Display only; the sale's real total is recomputed when it is checked out. */
  total: number
  lineCount: number
  unitCount: number
  heldAt: string
  heldByStaffId: number
  status: HeldSaleStatus
}

/** What a hold stores: the lines, the discounts, who the sale is for. Never payment state. */
export interface HoldSaleInput {
  cartToken: string
  /** The cart as JSON: `{ items, cartDiscount, customerPin, companyName }`. */
  payloadJson: string
  total: number
  lineCount: number
  unitCount: number
  staffId: number
  /** Omitted: the till names it "Customer N". */
  label?: string
}

/** A discarded held sale, as the End of Day page lists it (docs/phase-217). */
export interface DiscardedHeldSale {
  id: number
  label: string
  total: number
  lineCount: number
  heldAt: string
  discardedAt: string
  heldByName: string | null
  discardedByName: string | null
  managerName: string | null
  reason: string
}

/** One manager-approved removal or reduction of a cart line (docs/phase-197). */
export interface CartLineRemovalInput {
  /** Identifies the cart this happened in, so checkout can stamp only that cart's rows. */
  cart_token: string
  variant_id: string
  qty_before: number
  /** `0` when the line was removed outright. */
  qty_after: number
  /** The cashier signed in when it happened. */
  staff_id: number
  /** The manager whose PIN approved it. */
  manager_id: number
  at: string
}

/** One row of `cart_line_removals`. */
export interface CartLineRemovalRow extends CartLineRemovalInput {
  id: number
  /** `NULL` until the cart is checked out, and for ever for a cart that never was. */
  order_local_id: number | null
}

/** Result recorded for one request to print an order's receipt at the fiscal device. */
export type FiscalDuplicatePrintResult = 'sent' | 'refused' | 'error'

/** One row of `fiscal_duplicate_prints` (docs/phase-196-2). */
export interface FiscalDuplicatePrintRow {
  id: number
  order_id: number
  /** The manager who authorised the print. */
  staff_id: number
  requested_at: string
  /** The device's last CU invoice number read before the send, or `null` when none was read. */
  device_last_cu_inv: string | null
  /** The same read after the send, or `null` when nothing was sent or the read failed. */
  device_last_cu_inv_after: string | null
  result: FiscalDuplicatePrintResult
  error: string | null
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
  /** Day or night, as chosen when the shift was opened (docs/phase-199); `NULL` on a shift opened before then. */
  shift_type?: ShiftType | null
  /**
   * The M-Pesa till balance read from the portal or statement when the shift opened and when it closed
   * (docs/phase-222). `NULL` when not recorded, which is not the same as 0: it is always optional, and
   * every shift from before this phase has `NULL`.
   */
  mpesa_opening_balance?: number | null
  mpesa_closing_balance?: number | null
  /** `mpesa_opening_balance` + the shift's M-Pesa sales, stored at close; only when both balances were recorded. */
  mpesa_expected?: number | null
  /** `mpesa_closing_balance` − `mpesa_expected`: a prompt to check the statement, not a shortage. */
  mpesa_difference?: number | null
  /**
   * The card settlement read from the PDQ at close (docs/phase-246, R5), the shift's card sales, and the counted figure
   * less them. `NULL` when not recorded, which is not 0; expected and difference are stored only with a counted figure.
   */
  card_closing_balance?: number | null
  card_expected?: number | null
  card_difference?: number | null
  /**
   * `'retrospective'` for a shift recorded after the fact for sales that had none (docs/phase-223);
   * `'normal'` for every other shift, including every shift from before this phase.
   */
  kind?: ShiftKind
  /** The manager who recorded a retrospective shift; `NULL` on a normal shift. */
  created_by_staff_id?: number | null
  /** When a retrospective shift was recorded (its `clock_in` is the period start); `NULL` on a normal shift. */
  created_at?: string | null
  /** Why a retrospective shift was recorded; required for one, `NULL` on a normal shift. */
  reason?: string | null
  /**
   * `1` when nobody counted the drawer for a shift recorded after the fact (docs/phase-227): `starting_cash` is 0 and
   * means nothing, and `ending_cash`, `expected_cash` and `discrepancy` are `NULL`. `0` for every other shift,
   * including every shift from before this phase.
   */
  cash_not_counted?: 0 | 1
  /**
   * The window `clock_in` falls in (docs/phase-232, W4), added when a shift is read for the screens and never stored:
   * the type is the window's whatever `shift_type` says. `labelled_as` is the stored label, only when it differs.
   */
  window_type?: ShiftType
  window_date?: string
  labelled_as?: ShiftType
  /** How many shifts hold this shift's window (docs/phase-232); more than 1 only for older data. */
  window_shift_count?: number
  /** The shift this one was merged into (docs/phase-239), read from `shift_merges`; absent otherwise. */
  merged_into?: number | null
  /** The shifts merged into this one (docs/phase-242), oldest first; added by `listVisibleShifts`. */
  absorbed_shifts?: Array<{ id: number; clock_in: string; clock_out: string | null }>
  /**
   * `true` for a closed shift that is not the latest closed one (docs/phase-243): people cannot correct it or give it sales.
   * Added when a shift is read for the screens; absent otherwise.
   */
  frozen?: true
}

/** Row shape of the `shift_merges` table (docs/phase-239): one append-only record of a shift absorbed by another. */
export interface ShiftMergeRow {
  id: number
  absorbed_shift_id: number
  into_shift_id: number
  by_staff_id: number
  at: string
  reason: string
  sales_count: number
}

/** What merging one shift into another needs (docs/phase-239); the caller has already checked the admin's PIN. */
export interface MergeShiftsInput {
  absorbedShiftId: number
  intoShiftId: number
  managerId: number
  reason: string
}

/** What a merge would do, before anything is written (docs/phase-239). */
export interface ShiftMergePreview {
  absorbedShiftId: number
  intoShiftId: number
  salesCount: number
  salesTotal: number
  /** The surviving shift's figures afterwards; `null` when it is open or its cash was not counted. */
  into: ShiftWorkedFigures | null
  /** Why the merge is refused, or `null` when it may go ahead. */
  problem: string | null
}

/** How a shift came to exist: opened and closed at the till, or recorded afterwards by a manager. */
export type ShiftKind = 'normal' | 'retrospective'

/** What closing a shift returns: the cash figures as before, plus the M-Pesa ones (docs/phase-222), `null` when not recorded. */
export interface ShiftCloseResult {
  expectedCash: number
  discrepancy: number
  mpesaExpected: number | null
  mpesaDifference: number | null
  /** Present only when a card figure was counted (docs/phase-246, R5). */
  cardExpected?: number
  cardDifference?: number
}

/** One sale with no shift, as the past-shift screens list it (docs/phase-223). */
export interface UnattachedSaleRow {
  local_id: number
  created_at: string
  total: number
  payment_method: PaymentMethod | null
}

/** Why a shift's sales changed after it was opened (docs/phase-232). */
export type ShiftAdjustmentKind = 'opening' | 'auto' | 'reassign_in' | 'reassign_out'

/** Row shape of the `shift_adjustments` table (docs/phase-232): one append-only record of sales joining or leaving a shift. */
export interface ShiftAdjustmentRow {
  id: number
  shift_id: number
  kind: ShiftAdjustmentKind
  at: string
  /** `NULL` when the till did it by itself. */
  by_staff_id: number | null
  reason: string
  /** For a reassignment, the shift the sale came from or went to. */
  peer_shift_id: number | null
  sales_count: number
  sales_total: number
  cash_total: number
  mpesa_total: number
  card_total: number
  first_sale_at: string | null
  last_sale_at: string | null
  /** For an `opening` record: the cash counted in the drawer when the shift opened. */
  opening_drawer_cash: number | null
  /** The figures as they stood once this record was written; `NULL` for an open shift or one whose cash was not counted. */
  starting_cash: number | null
  ending_cash: number | null
  expected_cash: number | null
  discrepancy: number | null
  mpesa_opening_balance: number | null
  mpesa_closing_balance: number | null
  mpesa_expected: number | null
  mpesa_difference: number | null
  /** The card settlement figures (docs/phase-246, R5); `NULL` when not recorded, which is not 0. */
  card_closing_balance?: number | null
  card_expected?: number | null
  card_difference?: number | null
}

/** One sale named by an adjustment, with what the reports need to add it up. */
export interface ShiftAdjustmentSaleRow {
  adjustment_id: number
  kind: ShiftAdjustmentKind
  order_id: number
  total: number
  payment_method: PaymentMethod | null
  status: OrderStatus
}

/** The sales already made in a window with no shift in it, as the Open Shift form shows them (docs/phase-232). */
export interface EarlierSalesShown {
  count: number
  cash: number
  mpesa: number
}

/** The extra things opening a shift can carry (docs/phase-232). */
export interface OpenShiftOptions {
  /** What the form showed. If the sales now differ, the shift is not opened. */
  earlierShown?: EarlierSalesShown
  /** An admin's choice when the drawer holds less than the earlier cash sales: start at 0. */
  startAtZero?: boolean
}

/** What one run of automatic assignment did to one shift. */
export interface AutoAssignTouched {
  shiftId: number
  created: boolean
  windowType: ShiftType
  windowDate: string
  count: number
}

/** What a run of automatic merging did (docs/phase-242): each shift absorbed into the shift that holds its window. */
export interface AutoMergeResult {
  merged: Array<{ absorbedShiftId: number; intoShiftId: number; salesCount: number }>
  /** Another run was already in progress, so this one did nothing. */
  skipped?: boolean
}

/** What a run of automatic assignment did. */
export interface AutoAssignResult {
  touched: AutoAssignTouched[]
  /** Sales left waiting for the current window's shift. */
  waiting: number
  /** Another run was already in progress, so this one did nothing. */
  skipped?: boolean
  /** The shifts merged by the automatic merge that runs just before (docs/phase-242); absent when none ran. */
  merged?: AutoMergeResult['merged']
}

/** What moving a sale to another shift needs (docs/phase-232); the caller has already checked the admin's PIN. */
export interface ReassignSaleInput {
  orderId: number
  toShiftId: number
  managerId: number
  reason: string
  /** Required when the sale was made in a different window from the shift it goes to. */
  acknowledgeDifferentWindow?: boolean
  /** An admin forcing the move past the closed-shift rules (docs/phase-244); needs a reason of 10 or more characters. */
  override?: boolean
}

/** The figures one shift would show after a sale moves, `null` when it has none (open, or cash not counted). */
export interface MoveFigures {
  expectedCash: number
  discrepancy: number
  mpesaExpected: number | null
  mpesaDifference: number | null
}

/** What moving a sale would do (docs/phase-232), read-only; `problem` says why it cannot be done, or is `null`. */
export interface SaleMovePreview {
  orderId: number
  total: number
  /** How the sale was paid, in words: the method, or `split: …` with the payments (docs/phase-252). */
  paymentMethod: string | null
  createdAt: string | null
  fromShiftId: number | null
  toShiftId: number
  /** The sale was made outside the target shift's window and times: moving it needs a tick. */
  differentWindow: boolean
  from: MoveFigures | null
  to: MoveFigures | null
  problem: string | null
  /** `problem` is only a closed-shift rule, so an admin's override would lift it (docs/phase-244). */
  overridable: boolean
  /** The preview was asked with the override and a closed-shift rule had to be lifted for the move (docs/phase-244). */
  overridden: boolean
}

/**
 * Row shape of the `shift_corrections` table (docs/phase-224): one correction of the figures typed in for a
 * closed shift. The shift's own row is never changed; the latest correction is the current figures.
 */
export interface ShiftCorrectionRow {
  id: number
  shift_id: number
  corrected_by_staff_id: number
  corrected_at: string
  reason: string
  starting_cash: number
  ending_cash: number
  /** Worked out when the correction was made, from the shift's sales then, and stored. */
  expected_cash: number
  discrepancy: number
  mpesa_opening_balance: number | null
  mpesa_closing_balance: number | null
  mpesa_expected: number | null
  mpesa_difference: number | null
  /** The card settlement figures (docs/phase-246, R5); `NULL` when not recorded, which is not 0. */
  card_closing_balance?: number | null
  card_expected?: number | null
  card_difference?: number | null
}

/** What a correction needs (docs/phase-224); the caller has already checked the manager's PIN. */
export interface AddShiftCorrectionInput extends ShiftEnteredFigures {
  shiftId: number
  managerId: number
  reason: string
  /** An admin correcting a closed shift that is not the latest (docs/phase-244); needs a reason of 10 or more characters. */
  override?: boolean
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
  paymentMethod: OrderPaymentMethod
  tenderedAmount: number
  changeDue: number
  referenceNumber?: string
  /**
   * The sale's payments (docs/phase-252), written to `order_payments` in the sale's transaction. When absent, a sale
   * paid one way gets one payment built from `paymentMethod` and `total`. Required for `split`, and then also stored in
   * the order payload, where the receipt and the Shopify note read the payments.
   */
  payments?: SalePayment[]
  shiftId?: number
  /** Customer's KRA PIN, when captured for a B2B eTIMS invoice — omitted for a walk-in B2C sale. */
  customerPin?: string
  /** Cart-level discount, applied on top of the line-item subtotal. */
  cartDiscount?: Discount
  /** The till's Shopify location at sale time, stored in the order payload (docs/phase-210). */
  locationId?: string
  locationName?: string
  /**
   * Builds the sale's fiscal request once its `localId` exists. When
   * given, {@link RubisDatabase.queueOrder} stores the request, marks the
   * sale `waiting` and queues its fiscal row in the same transaction as
   * the order, so a stop at any later point leaves the sale where the
   * fiscal queue retries it (docs/phase-185.md §4.1). A function because
   * the request carries `localId`, which only exists after the INSERT, and
   * the trader number (docs/phase-211), allocated in the same transaction
   * when the sale has a location.
   */
  buildFiscalRequest?: (localId: number, traderInvNum?: string) => FiscalInvoiceRequest
  /**
   * The key the screen made for this checkout (docs/phase-249). When an order already holds it, {@link
   * RubisDatabase.queueOrder} returns that order and writes nothing. Absent for a caller with no checkout.
   */
  checkoutKey?: string
  /**
   * The cart this sale came from (docs/phase-197). When present, the
   * sale's own transaction stamps that cart's removal rows with the new
   * order id. Absent for any caller that has no cart.
   */
  cartToken?: string
}

/**
 * What {@link RubisDatabase.queueOrder} and its M-Pesa wrappers return.
 * `fiscalQueueId` is set only when the input carried
 * `buildFiscalRequest`.
 */
export interface QueuedOrder {
  localId: number
  queueId: number
  /** The trader number allocated in the sale's transaction (docs/phase-211); absent for a sale with no location. */
  traderInvNum?: string
  fiscalQueueId?: number
  /**
   * `true` when an order already held this checkout's key (docs/phase-249): `localId` and `traderInvNum` are that order's,
   * nothing was written, and `queueId` is 0 because no Shopify queue row was made.
   */
  existing?: boolean
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
  /** Failure reason, set when `fiscalStatus` is `'waiting'` or `'needs_fixing'`: the device's message (with its code for a device refusal) and, when a device step failed, "Refused while <step> (<Command>)." — docs/phase-184 §3. */
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
  /** One method, or `split` with {@link CheckoutRequest.payments} (docs/phase-252). */
  paymentMethod: OrderPaymentMethod
  tenderedAmount: number
  changeDue: number
  referenceNumber?: string
  /** A split sale's payments, in the order recorded (docs/phase-252). Present only with `paymentMethod: 'split'`. */
  payments?: CheckoutPaymentLeg[]
  shiftId?: number
  /** Customer's KRA PIN, when captured for a B2B eTIMS invoice — omitted for a walk-in B2C sale. */
  customerPin?: string
  /** Customer's company/trading name, when captured for a B2B eTIMS invoice. */
  companyName?: string
  cartDiscount?: Discount
  /** Identifies the cart this sale came from (docs/phase-197), so its approved removals are stamped with the order. */
  cartToken?: string
  /**
   * The key the screen made for this checkout (docs/phase-249): every submit of the same checkout carries it, and a
   * repeat returns the order the first one made. Required on the IPC channel (`checkoutRequestSchema`); optional here so
   * a direct caller with no screen behind it keeps working.
   */
  checkoutKey?: string
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
  /**
   * Set **only by the `orders:checkout` IPC handler**, when this sale is
   * a card (PDQ) tender — same structural guarantee as `manualApproval`:
   * no field on `checkoutRequestSchema` lets a renderer assert this
   * directly (see `cardManual` on {@link CheckoutIpcRequest} instead).
   * Unlike manual M-Pesa, the reference travels on this object rather
   * than on `referenceNumber` — `runCheckout`'s card gate (docs/
   * phase-176.md Part 2 §2) derives `referenceNumber`/`tenderedAmount`/
   * `changeDue` from here, never from the top-level fields, since a PDQ
   * sale has no confirming provider to check either against.
   */
  cardApproval?: CardApproval
  /**
   * Set **only by the `orders:checkout` IPC handler** from the till's own
   * confirmed Shopify location (docs/phase-210); never taken from the
   * renderer. Stored in the order payload so the Shopify order carries the
   * shop that sold it, even if the till's location is changed before the
   * order is pushed.
   */
  locationId?: string
  locationName?: string
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
 * A manually recorded card (PDQ) reference, as the renderer sends it.
 *
 * No manager credentials travel with it, matching manual M-Pesa entry
 * (docs/phase-150.md step 3) — the cashier attesting to it is the till's
 * own logged-in staff member, established server-side from `staffId`,
 * never from this object.
 */
export interface CardManualEntry {
  /**
   * The reference the cashier read off the PDQ slip. 1-12 uppercase
   * letters/digits is a working assumption (docs/phase-176.md Part 2
   * §1) until Rubis Finance confirms which PDQ slip number this till is
   * meant to reconcile against.
   */
  reference: string
  /** Must be `true`: the cashier's positive attestation that the PDQ slip shows Approved for this amount. */
  confirmRecorded: true
}

/**
 * What the renderer may send to `orders:checkout`.
 *
 * `manualApproval`/`cardApproval` are deliberately absent — those are
 * established in the main process, never asserted by a caller.
 */
export type CheckoutIpcRequest = Omit<
  CheckoutRequest,
  'manualApproval' | 'cardApproval' | 'locationId' | 'locationName' | 'payments'
> & {
  mpesaManual?: ManualMpesaEntry
  cardManual?: CardManualEntry
  payments?: CheckoutIpcPaymentLeg[]
}

/**
 * One payment of a split sale (docs/phase-252), as `runCheckout` checks it. `manualApproval` and `cardApproval` are set
 * only by the `orders:checkout` handler, from the leg's `mpesaManual` and `cardManual`, exactly as for a sale paid one
 * way.
 */
export interface CheckoutPaymentLeg {
  method: PaymentMethod
  /** The part of the total this payment covers. */
  amount: number
  /** Cash only: what the customer handed over. */
  tendered?: number
  /** M-Pesa only: the code or the STK reference. */
  referenceNumber?: string
  manualApproval?: ManualMpesaApproval
  cardApproval?: CardApproval
}

/** One payment of a split sale, as the renderer sends it (docs/phase-252). */
export type CheckoutIpcPaymentLeg = Omit<CheckoutPaymentLeg, 'manualApproval' | 'cardApproval'> & {
  mpesaManual?: ManualMpesaEntry
  cardManual?: CardManualEntry
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

/**
 * The cashier's attestation for one manually recorded card (PDQ)
 * payment, derived server-side from `cardManual` (see
 * {@link CheckoutIpcRequest}).
 *
 * Carries the reference itself — unlike {@link ManualMpesaApproval},
 * where the reference travels on `CheckoutRequest.referenceNumber` —
 * because a card sale has no confirming provider to have already set
 * that field correctly; `runCheckout`'s card gate reads the reference
 * from here alone.
 */
export interface CardApproval {
  /** The reference the cashier read off the PDQ slip, as sent by `cardManual`. */
  reference: string
  /** The cashier's explicit, positive attestation that the PDQ slip showed Approved for this amount. */
  confirmRecorded: boolean
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
 * phase-164, meaning narrowed docs/phase-164-1) — kept in its own
 * migration, separate from {@link migrateOrdersFiscalColumns}'s array,
 * since the column itself was never part of that array's original set;
 * same idempotent `ALTER TABLE` pattern.
 */
function migrateOrdersReceiptColumns(connection: SqliteConnection): void {
  // `fiscal_trader_inv_num` and `fiscal_slip_unprinted_at` (docs/phase-198) and `customer_slip_printed_at` (docs/phase-198-1) join here for the same reason.
  for (const column of ['receipt_printed_at', 'fiscal_trader_inv_num', 'fiscal_slip_unprinted_at', 'customer_slip_printed_at']) {
    try {
      connection.exec(`ALTER TABLE orders ADD COLUMN ${column} TEXT`)
    } catch {
      // Column already exists — table was created with the current schema.
    }
  }
}

/**
 * Adds `shift_type` (docs/phase-199) to a pre-existing `shifts` table. Nullable
 * with no default and no backfill, so an older shift keeps `NULL` and displays
 * as it did; same idempotent `ALTER TABLE` pattern as the migrations around it.
 */
function migrateShiftsColumns(connection: SqliteConnection): void {
  try {
    connection.exec("ALTER TABLE shifts ADD COLUMN shift_type TEXT CHECK (shift_type IN ('day', 'night'))")
  } catch {
    // Column already exists — table was created with the current schema.
  }
  // docs/phase-222: the four M-Pesa balance columns, nullable with no default and no backfill, so a shift
  // from before keeps NULL ("not recorded") and its Z report is unchanged.
  for (const column of ['mpesa_opening_balance', 'mpesa_closing_balance', 'mpesa_expected', 'mpesa_difference']) {
    try {
      connection.exec(`ALTER TABLE shifts ADD COLUMN ${column} REAL`)
    } catch {
      // Column already exists — table was created with the current schema.
    }
  }
  // docs/phase-223: how a shift came to exist, and for a retrospective one who recorded it, when and why. Every
  // shift from before reads `kind = 'normal'` (the column default) and NULL for the rest; nothing is backfilled.
  const retrospectiveColumns = [
    "kind TEXT NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal', 'retrospective'))",
    'created_by_staff_id INTEGER',
    'created_at TEXT',
    'reason TEXT',
    // docs/phase-227: nobody counted the drawer. Defaults to 0 for every shift from before, which keeps its figures.
    'cash_not_counted INTEGER NOT NULL DEFAULT 0 CHECK (cash_not_counted IN (0, 1))'
  ]
  for (const definition of retrospectiveColumns) {
    try {
      connection.exec(`ALTER TABLE shifts ADD COLUMN ${definition}`)
    } catch {
      // Column already exists — table was created with the current schema.
    }
  }
}

/**
 * The Africa/Nairobi calendar day of an instant (Kenya keeps UTC+3 all year, as `reports.ts` explains), as `YYYY-MM-DD`:
 * the label a shift's review carries in `local_day`.
 *
 * @param {string} iso
 * @returns {string}
 */
function localDayOfIso(iso: string): string {
  return new Date(Date.parse(iso) + 3 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/**
 * Adds `checkout_key` (docs/phase-249) to an `orders` table made before the phase. Nullable with no backfill: an order
 * from before has no key and is never looked up by one. Check then add, so it runs any number of times and a failure of
 * the `ALTER` is a real error, not swallowed.
 *
 * @param {SqliteConnection} connection
 */
function migrateOrdersCheckoutKey(connection: SqliteConnection): void {
  const have = (connection.prepare('PRAGMA table_info(orders)').all() as Array<{ name: string }>).map((c) => c.name)
  if (!have.includes('checkout_key')) connection.exec('ALTER TABLE orders ADD COLUMN checkout_key TEXT')
}

/**
 * Adds `shift_id` (docs/phase-246) to a `mpesa_day_approvals` table made before the phase, so an approval can be made
 * for one shift. Nullable with no backfill: every earlier review stays a review of a day, as it was. Check then add,
 * so it runs any number of times.
 *
 * @param {SqliteConnection} connection
 */
function migrateMpesaApprovalShiftColumn(connection: SqliteConnection): void {
  const have = (connection.prepare('PRAGMA table_info(mpesa_day_approvals)').all() as Array<{ name: string }>).map((c) => c.name)
  if (!have.includes('shift_id')) connection.exec('ALTER TABLE mpesa_day_approvals ADD COLUMN shift_id INTEGER')
}

/**
 * Adds the card settlement columns (docs/phase-246, R5) to the three tables that hold a shift's counted figures: the
 * shift itself, its corrections and its adjustment ledger. Nullable with no default and no backfill, so every row from
 * before reads `NULL`, "Not recorded", which is not 0. Check then add, so it runs any number of times and a failure of
 * the `ALTER` is a real error, not swallowed: running `init` twice changes nothing.
 */
function migrateCardColumns(connection: SqliteConnection): void {
  for (const table of ['shifts', 'shift_corrections', 'shift_adjustments']) {
    const have = new Set((connection.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name))
    for (const column of ['card_closing_balance', 'card_expected', 'card_difference']) {
      if (!have.has(column)) connection.exec(`ALTER TABLE ${table} ADD COLUMN ${column} REAL`)
    }
  }
}

/**
 * Adds the product tax-classification columns (docs/phase-194) to a
 * pre-existing `products` table, so the offline catalogue keeps a
 * product's class instead of turning every exempt item into class A.
 * Same idempotent `ALTER TABLE` pattern as the migrations around it;
 * existing rows read back as `NULL`, which is class A.
 */
function migrateProductsTaxColumns(connection: SqliteConnection): void {
  for (const column of ['vat_class', 'hs_code', 'hs_name']) {
    try {
      connection.exec(`ALTER TABLE products ADD COLUMN ${column} TEXT`)
    } catch {
      // Column already exists — table was created with the current schema.
    }
  }
}

/**
 * Adds the Shopify push marker (docs/phase-168 section 2.4) to a
 * pre-existing `orders` table: how many times this sale has been sent
 * to `orderCreate`, and when it was last sent. Kept in its own migration
 * for the same reason as {@link migrateOrdersReceiptColumns}; same
 * idempotent `ALTER TABLE` pattern. Existing rows read back as count 0
 * and a null time, which is also true of every sale sent before this
 * marker existed: the marker cannot know about those.
 */
function migrateOrdersPushColumns(connection: SqliteConnection): void {
  const columns = ['shopify_push_count INTEGER NOT NULL DEFAULT 0', 'shopify_last_push_at TEXT']
  for (const column of columns) {
    try {
      connection.exec(`ALTER TABLE orders ADD COLUMN ${column}`)
    } catch {
      // Column already exists — table was created with the current schema.
    }
  }
}

/**
 * Adds `width` (characters per printed line, docs/phase-171) and
 * `connection_type` (`'network'` | `'windows'`, docs/phase-174) to a
 * pre-existing `printers` table — a fresh table already has both via
 * {@link SCHEMA.printers}. `NULL` `width` on an existing row reads back
 * as "not set", which {@link resolvePrinterSettings} treats as the
 * default (48, 80mm Font A). `connection_type`'s `DEFAULT 'network'`
 * backfills every printer configured before phase-174 as the TCP/IP
 * route it always was — the same idempotent `ALTER TABLE` pattern as
 * {@link migrateOrdersReceiptColumns}.
 */
function migratePrintersColumns(connection: SqliteConnection): void {
  try {
    connection.exec('ALTER TABLE printers ADD COLUMN width INTEGER')
  } catch {
    // Column already exists — table was created with the current schema.
  }
  try {
    connection.exec(
      "ALTER TABLE printers ADD COLUMN connection_type TEXT NOT NULL DEFAULT 'network'"
    )
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
/**
 * @param {number} amount
 * @returns {number} rounded to cents, so arithmetic on money has no stray fractions
 */
function roundMoney(amount: number): number {
  return Math.round(amount * 100) / 100
}

/**
 * @param {UnattachedSaleRow[]} sales
 * @param {(method: PaymentMethod) => number} totalFor the sales' payments by method, from their legs (docs/phase-250)
 * @returns {EarlierSalesShown} how many, and the cash and M-Pesa they hold
 */
function totalOfSales(sales: UnattachedSaleRow[], totalFor: (method: PaymentMethod) => number): EarlierSalesShown {
  return { count: sales.length, cash: roundMoney(totalFor('cash')), mpesa: roundMoney(totalFor('mpesa')) }
}

/**
 * The payments a sale writes to `order_payments` (docs/phase-252): the ones given, or, for a sale paid one way with none
 * given, one payment of its method for its whole total, with the cash handed over and the change, or the reference, as
 * the order row holds them.
 *
 * @param {QueueOrderInput} input
 * @returns {SalePayment[]}
 * @throws {Error} for a split sale given no payments, before anything is written: it would count in no method total
 */
function paymentsOfSale(input: QueueOrderInput): SalePayment[] {
  if (input.payments && input.payments.length > 0) return input.payments
  if (input.paymentMethod === 'split') throw new Error('A split sale must carry its payments')
  if (input.paymentMethod === 'cash') {
    return [{ method: 'cash', amount: input.total, tendered: input.tenderedAmount, changeDue: input.changeDue }]
  }
  return [{ method: input.paymentMethod, amount: input.total, ...(input.referenceNumber ? { reference: input.referenceNumber } : {}) }]
}

/**
 * @param {EarlierSalesShown} shown
 * @param {EarlierSalesShown} actual
 * @returns {boolean} whether the form showed what is there now
 */
function sameEarlierSales(shown: EarlierSalesShown, actual: EarlierSalesShown): boolean {
  return shown.count === actual.count && roundMoney(shown.cash) === actual.cash && roundMoney(shown.mpesa) === actual.mpesa
}

export const SCHEMA = {
  products: `CREATE TABLE IF NOT EXISTS products (
    id TEXT NOT NULL,
    title TEXT NOT NULL,
    variant_id TEXT PRIMARY KEY,
    variant_title TEXT NOT NULL DEFAULT '',
    price REAL NOT NULL,
    inventory_quantity INTEGER NOT NULL,
    image_url TEXT,
    barcode TEXT,
    vat_class TEXT,
    hs_code TEXT,
    hs_name TEXT
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
    receipt_printed_at TEXT,
    fiscal_trader_inv_num TEXT,
    fiscal_slip_unprinted_at TEXT,
    customer_slip_printed_at TEXT,
    shopify_push_count INTEGER NOT NULL DEFAULT 0,
    shopify_last_push_at TEXT,
    checkout_key TEXT
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
  /**
   * One order per checkout (docs/phase-249): the key the screen made for a checkout is unique among the orders that have
   * one. Partial, so every order from before the phase, whose key is `NULL`, is untouched. The lookup in
   * {@link RubisDatabase.queueOrder} is what returns the earlier order; this index is the database's own guarantee.
   */
  ordersCheckoutKeyIndex: `CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_checkout_key ON orders (checkout_key) WHERE checkout_key IS NOT NULL`,
  /**
   * Every payment of a sale (docs/phase-252), written in the sale's own transaction: one row for a sale paid one way,
   * one per payment for a split sale. Append-only, like the shift ledgers: a payment is a fact about money that moved.
   * A sale made before the table has no rows here and is read as one payment from `orders` (`paymentLegsFor`).
   * `mpesa_mode` comes from the gate branch that accepted the payment, never from the screen.
   */
  orderPayments: `CREATE TABLE IF NOT EXISTS order_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_local_id INTEGER NOT NULL REFERENCES orders(local_id),
    leg_no INTEGER NOT NULL,
    method TEXT NOT NULL CHECK (method IN ('cash', 'mpesa', 'card')),
    mpesa_mode TEXT CHECK (mpesa_mode IN ('daraja', 'sms', 'manual')),
    amount REAL NOT NULL,
    reference TEXT,
    tendered REAL,
    change_due REAL,
    created_at TEXT NOT NULL,
    UNIQUE (order_local_id, leg_no)
  )`,
  orderPaymentsNoUpdate: `CREATE TRIGGER IF NOT EXISTS order_payments_no_update BEFORE UPDATE ON order_payments
    BEGIN SELECT RAISE(ABORT, 'order_payments is append-only'); END`,
  orderPaymentsNoDelete: `CREATE TRIGGER IF NOT EXISTS order_payments_no_delete BEFORE DELETE ON order_payments
    BEGIN SELECT RAISE(ABORT, 'order_payments is append-only'); END`,
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
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    shift_type TEXT CHECK (shift_type IN ('day', 'night')),
    mpesa_opening_balance REAL,
    mpesa_closing_balance REAL,
    mpesa_expected REAL,
    mpesa_difference REAL,
    card_closing_balance REAL,
    card_expected REAL,
    card_difference REAL,
    kind TEXT NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal', 'retrospective')),
    created_by_staff_id INTEGER,
    created_at TEXT,
    reason TEXT,
    cash_not_counted INTEGER NOT NULL DEFAULT 0 CHECK (cash_not_counted IN (0, 1))
  )`,
  /**
   * One correction of the figures typed in for a closed shift (docs/phase-224). Append-only: the only writer is
   * {@link RubisDatabase.addShiftCorrection}, and two triggers refuse any UPDATE or DELETE, so a correction cannot be
   * rewritten or removed afterwards, by this code or any other. `shifts` is never touched: the original figures stay
   * as they were and the Z report shows both. The worked figures are stored, as `closeShift` stores its own.
   */
  shiftCorrections: `CREATE TABLE IF NOT EXISTS shift_corrections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_id INTEGER NOT NULL REFERENCES shifts(id),
    corrected_by_staff_id INTEGER NOT NULL,
    corrected_at TEXT NOT NULL,
    reason TEXT NOT NULL,
    starting_cash REAL NOT NULL,
    ending_cash REAL NOT NULL,
    expected_cash REAL NOT NULL,
    discrepancy REAL NOT NULL,
    mpesa_opening_balance REAL,
    mpesa_closing_balance REAL,
    mpesa_expected REAL,
    mpesa_difference REAL,
    card_closing_balance REAL,
    card_expected REAL,
    card_difference REAL
  )`,
  shiftCorrectionsShiftIndex: `CREATE INDEX IF NOT EXISTS idx_shift_corrections_shift ON shift_corrections (shift_id)`,
  shiftCorrectionsNoUpdate: `CREATE TRIGGER IF NOT EXISTS shift_corrections_no_update BEFORE UPDATE ON shift_corrections
    BEGIN SELECT RAISE(ABORT, 'shift_corrections is append-only'); END`,
  shiftCorrectionsNoDelete: `CREATE TRIGGER IF NOT EXISTS shift_corrections_no_delete BEFORE DELETE ON shift_corrections
    BEGIN SELECT RAISE(ABORT, 'shift_corrections is append-only'); END`,
  /**
   * Every change to which sales a shift holds after it was opened (docs/phase-232), in one append-only ledger:
   * sales that joined when the shift opened or was made (`opening`), sales that joined automatically (`auto`), and a
   * sale an admin moved in or out (`reassign_in`, `reassign_out`, a pair sharing who, when and why, each naming the
   * other shift). The figures are a snapshot taken when the record was written, and are NULL for a shift that was
   * open or whose cash was not counted. `by_staff_id` is NULL when the till did it. Two triggers refuse any UPDATE or
   * DELETE, here and on the sales table below.
   */
  shiftAdjustments: `CREATE TABLE IF NOT EXISTS shift_adjustments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_id INTEGER NOT NULL REFERENCES shifts(id),
    kind TEXT NOT NULL CHECK (kind IN ('opening', 'auto', 'reassign_in', 'reassign_out')),
    at TEXT NOT NULL,
    by_staff_id INTEGER,
    reason TEXT NOT NULL,
    peer_shift_id INTEGER,
    sales_count INTEGER NOT NULL,
    sales_total REAL NOT NULL,
    cash_total REAL NOT NULL,
    mpesa_total REAL NOT NULL,
    card_total REAL NOT NULL,
    first_sale_at TEXT,
    last_sale_at TEXT,
    opening_drawer_cash REAL,
    starting_cash REAL,
    ending_cash REAL,
    expected_cash REAL,
    discrepancy REAL,
    mpesa_opening_balance REAL,
    mpesa_closing_balance REAL,
    mpesa_expected REAL,
    mpesa_difference REAL,
    card_closing_balance REAL,
    card_expected REAL,
    card_difference REAL
  )`,
  shiftAdjustmentsShiftIndex: `CREATE INDEX IF NOT EXISTS idx_shift_adjustments_shift ON shift_adjustments (shift_id)`,
  shiftAdjustmentsNoUpdate: `CREATE TRIGGER IF NOT EXISTS shift_adjustments_no_update BEFORE UPDATE ON shift_adjustments
    BEGIN SELECT RAISE(ABORT, 'shift_adjustments is append-only'); END`,
  shiftAdjustmentsNoDelete: `CREATE TRIGGER IF NOT EXISTS shift_adjustments_no_delete BEFORE DELETE ON shift_adjustments
    BEGIN SELECT RAISE(ABORT, 'shift_adjustments is append-only'); END`,
  shiftAdjustmentSales: `CREATE TABLE IF NOT EXISTS shift_adjustment_sales (
    adjustment_id INTEGER NOT NULL REFERENCES shift_adjustments(id),
    order_id INTEGER NOT NULL REFERENCES orders(local_id),
    PRIMARY KEY (adjustment_id, order_id)
  )`,
  shiftAdjustmentSalesNoUpdate: `CREATE TRIGGER IF NOT EXISTS shift_adjustment_sales_no_update BEFORE UPDATE ON shift_adjustment_sales
    BEGIN SELECT RAISE(ABORT, 'shift_adjustment_sales is append-only'); END`,
  /**
   * One shift absorbed by another in the same window (docs/phase-239). The sales moved through the adjustments ledger
   * above; this row says the absorbed shift is spent. Append-only, like the ledgers, and a shift can be absorbed once.
   * `shifts` is never touched: the absorbed shift's own figures stay as history.
   */
  shiftMerges: `CREATE TABLE IF NOT EXISTS shift_merges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    absorbed_shift_id INTEGER NOT NULL UNIQUE REFERENCES shifts(id),
    into_shift_id INTEGER NOT NULL REFERENCES shifts(id),
    by_staff_id INTEGER NOT NULL,
    at TEXT NOT NULL,
    reason TEXT NOT NULL,
    sales_count INTEGER NOT NULL
  )`,
  shiftMergesNoUpdate: `CREATE TRIGGER IF NOT EXISTS shift_merges_no_update BEFORE UPDATE ON shift_merges
    BEGIN SELECT RAISE(ABORT, 'shift_merges is append-only'); END`,
  shiftMergesNoDelete: `CREATE TRIGGER IF NOT EXISTS shift_merges_no_delete BEFORE DELETE ON shift_merges
    BEGIN SELECT RAISE(ABORT, 'shift_merges is append-only'); END`,
  shiftAdjustmentSalesNoDelete: `CREATE TRIGGER IF NOT EXISTS shift_adjustment_sales_no_delete BEFORE DELETE ON shift_adjustment_sales
    BEGIN SELECT RAISE(ABORT, 'shift_adjustment_sales is append-only'); END`,
  integrations: `CREATE TABLE IF NOT EXISTS integrations (
    provider TEXT PRIMARY KEY,
    config_json TEXT NOT NULL DEFAULT '{}'
  )`,
  printers: `CREATE TABLE IF NOT EXISTS printers (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('receipt', 'kitchen', 'label')),
    interface TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    width INTEGER,
    connection_type TEXT NOT NULL DEFAULT 'network' CHECK (connection_type IN ('network', 'windows'))
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
    note TEXT,
    shift_id INTEGER
  )`,
  mpesaDayApprovalsLocalDayIndex: `CREATE INDEX IF NOT EXISTS idx_mpesa_day_approvals_local_day ON mpesa_day_approvals (local_day)`,
  /**
   * A shift is approved once (docs/phase-246): a review made for a shift names it in `shift_id`, and this index makes a
   * second one for the same shift impossible whatever the code does. A review made before the phase, for a day, has no
   * `shift_id` and is history that is never rewritten.
   */
  mpesaDayApprovalsShiftIndex: `CREATE UNIQUE INDEX IF NOT EXISTS idx_mpesa_day_approvals_shift ON mpesa_day_approvals (shift_id) WHERE shift_id IS NOT NULL`,
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
  mpesaDayExclusionsPaymentIndex: `CREATE INDEX IF NOT EXISTS idx_mpesa_day_exclusions_payment ON mpesa_day_exclusions (payment_id)`,
  /**
   * One row per request to print an order's receipt at the fiscal device
   * (docs/phase-196-2), written whatever the outcome. Append-only: the
   * only writer is {@link RubisDatabase.recordFiscalDuplicatePrint}. It
   * never touches `orders`' fiscal columns, `sync_queue` or the fiscal queue.
   */
  fiscalDuplicatePrints: `CREATE TABLE IF NOT EXISTS fiscal_duplicate_prints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    staff_id INTEGER NOT NULL,
    requested_at TEXT NOT NULL,
    device_last_cu_inv TEXT,
    device_last_cu_inv_after TEXT,
    result TEXT NOT NULL CHECK (result IN ('sent', 'refused', 'error')),
    error TEXT
  )`,
  fiscalDuplicatePrintsOrderIndex: `CREATE INDEX IF NOT EXISTS idx_fiscal_duplicate_prints_order ON fiscal_duplicate_prints (order_id)`,
  /**
   * One row per slip reprinted from Order History (docs/phase-198).
   * Append-only: the only writer is {@link RubisDatabase.recordReceiptReprint}.
   * `staff_id` carries no foreign key so a removed account never blocks the log.
   */
  receiptReprints: `CREATE TABLE IF NOT EXISTS receipt_reprints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    slip TEXT NOT NULL CHECK (slip IN ('fiscal', 'enjoy')),
    staff_id INTEGER,
    at TEXT NOT NULL
  )`,
  receiptReprintsOrderIndex: `CREATE INDEX IF NOT EXISTS idx_receipt_reprints_order ON receipt_reprints (order_id)`,
  /**
   * The cart being built on this till, saved so it survives a restart
   * (docs/phase-197). Exactly one row (`id = 1`), overwritten on every
   * change and deleted when the sale is created or the cart is cleared.
   * A draft only: it holds no payment state, is never pushed to Shopify
   * and is never read as stock.
   */
  cartDrafts: `CREATE TABLE IF NOT EXISTS cart_drafts (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    payload_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  /**
   * Sales parked while the cashier serves the next customer (docs/phase-217).
   * Not a sale: nothing here is filed, pushed or counted as stock. `payload_json`
   * holds the lines, discounts, customer PIN and company name exactly as held; no
   * payment state. A row is `held`, then `resumed` while its cart is on screen, then
   * `completed` (stamped in the order's own transaction, `settleCartForOrder`) or
   * `discarded` (manager PIN and a reason). Discarded rows are kept: a held sale
   * may be an M-Pesa payment with no sale behind it.
   */
  heldSales: `CREATE TABLE IF NOT EXISTS held_sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cart_token TEXT NOT NULL,
    label TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    total REAL NOT NULL,
    line_count INTEGER NOT NULL,
    unit_count INTEGER NOT NULL,
    held_at TEXT NOT NULL,
    held_by_staff_id INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('held', 'resumed', 'completed', 'discarded')),
    order_local_id INTEGER,
    completed_at TEXT,
    discarded_at TEXT,
    discarded_by_staff_id INTEGER,
    discard_manager_id INTEGER,
    discard_reason TEXT
  )`,
  /** One open row per cart, so a sale held, resumed and held again reuses its row. */
  heldSalesOpenTokenIndex: `CREATE UNIQUE INDEX IF NOT EXISTS idx_held_sales_open_token ON held_sales (cart_token) WHERE status IN ('held', 'resumed')`,
  /**
   * One row per cart line a manager approved removing or reducing
   * (docs/phase-197). Append-only audit: `order_local_id` is stamped when
   * the cart is checked out, and nothing in the POS path reads this table
   * (`tests/cartRemovalGuard.test.ts` enforces that).
   */
  cartLineRemovals: `CREATE TABLE IF NOT EXISTS cart_line_removals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_local_id INTEGER,
    cart_token TEXT NOT NULL,
    variant_id TEXT NOT NULL,
    qty_before INTEGER NOT NULL,
    qty_after INTEGER NOT NULL,
    staff_id INTEGER NOT NULL,
    manager_id INTEGER NOT NULL,
    at TEXT NOT NULL
  )`,
  cartLineRemovalsTokenIndex: `CREATE INDEX IF NOT EXISTS idx_cart_line_removals_token ON cart_line_removals (cart_token)`
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

/**
 * How a printer is reached (docs/phase-174). `'network'` is every
 * printer this codebase supported before phase-174 — unchanged.
 * `'windows'` is a printer installed as a Windows printer queue (USB or
 * COM/serial), sent to directly rather than over TCP/IP — see
 * `windowsPrinter.ts`.
 */
export type PrinterConnectionType = 'network' | 'windows'

/** One configured printer, as read from / written to the `printers` table. */
export interface PrinterConfig {
  /** Stable identifier the Admin screen and printer registry key on. */
  id: string
  type: PrinterType
  /**
   * For `connectionType: 'network'` (or absent — every printer
   * configured before phase-174): `tcp://<ip>:<port>`, matching
   * `PrinterSettings.interfaceName`. For `connectionType: 'windows'`:
   * the printer queue's system name (`PrinterInfo.name`, never
   * `displayName` — docs/phase-174), reusing this same field rather
   * than adding a second name column.
   */
  interfaceName: string
  /** Disabled printers are skipped by registry lookups without deleting the row. */
  enabled: boolean
  /** Characters per printed line (48/42/32, docs/phase-171) — `undefined` falls back to the default (48). */
  width?: number
  /** Defaults to `'network'` when absent — every printer configured before docs/phase-174. */
  connectionType?: PrinterConnectionType
}

/** Raw `printers` row shape, before {@link PrinterConfig}'s boolean/name normalization. */
interface PrinterRow {
  id: string
  type: PrinterType
  interface: string
  enabled: number
  width: number | null
  connection_type: PrinterConnectionType
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

/** Reason {@link RubisDatabase.sweepUnqueuedFiscalOrders} gives a stopped sale whose request was saved. */
export const INTERRUPTED_FILING_REASON =
  'The till stopped while this sale was being sent to the tax device, so it may not have been filed. Check whether it was a real sale, then press Resend. Nothing is sent automatically.'

/** The `settings` key recording that the phase 212 repair has run. */
const REPAIR_212_SETTING_KEY = 'repair_212_ran_at'

/** Reason {@link RubisDatabase.repairFalselyFiledOrders} gives a sale it corrects. */
export const FALSELY_FILED_REPAIR_REASON =
  'Recorded as filed in error: the fiscal device refused this sale and no invoice was issued. Corrected automatically on update 2026-10-03. Check before resending.'

/** The rows {@link RubisDatabase.repairFalselyFiledOrders} corrects: every condition is required. */
const FALSELY_FILED_WHERE =
  "fiscal_status = 'fiscalized' AND fiscal_invoice_number LIKE '%000000000' AND (fiscal_qr_code IS NULL OR fiscal_qr_code = '') AND fiscal_fiscalized_at_source = 'local-fallback'"

/** Reason {@link RubisDatabase.sweepUnqueuedFiscalOrders} gives a stopped sale it cannot resend. */
export const INTERRUPTED_UNSENT_REASON =
  'The till stopped before this sale reached the tax device, and it cannot be resent automatically. Ask support to check it.'

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

/**
 * One local sale the Shopify reconciliation check (docs/phase-170) has
 * reason to look at: either it may already be in Shopify under a lost
 * response (`status` is `pending_sync`/`failed` and it has been pushed
 * at least once), or it claims to already be synced and needs its
 * Shopify order confirmed still to exist.
 */
export interface ReconciliationCandidateRow {
  local_id: number
  status: OrderStatus
  shopify_order_id: string | null
  shopify_push_count: number
  created_at: string
  /** Parsed from `payload_json` server-side, so no caller re-parses it. */
  client_order_uuid: string
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
  /** The shift this review was made for (docs/phase-246); `NULL` for a review of a day made before then. */
  shift_id?: number | null
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

/** A `held_sales` row as SQLite returns it. */
interface HeldSaleRowShape {
  id: number
  cart_token: string
  label: string
  payload_json: string
  total: number
  line_count: number
  unit_count: number
  held_at: string
  held_by_staff_id: number
  status: HeldSaleStatus
}

/**
 * The lowest "Customer N" not already used by an open held sale (docs/phase-217).
 *
 * @param {string[]} usedLabels
 * @returns {string}
 */
export function nextHeldLabel(usedLabels: string[]): string {
  const used = new Set(
    usedLabels
      .map((label) => /^Customer (\d+)$/.exec(label)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number)
  )
  let n = 1
  while (used.has(n)) n++
  return `Customer ${n}`
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
  /** Set while {@link autoAssignUnattachedSales} runs, so a second call does nothing (docs/phase-232). */
  private autoAssigning = false
  /** Set while {@link autoMergeSameWindowShifts} runs (docs/phase-242). */
  private autoMerging = false

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
    migrateProductsTaxColumns(connection)
    connection.exec(SCHEMA.orders)
    connection.exec(SCHEMA.syncQueue)
    connection.exec(SCHEMA.queueIndex)
    connection.exec(SCHEMA.barcodeIndex)
    connection.exec(SCHEMA.settings)
    connection.exec(SCHEMA.staff)
    connection.exec(SCHEMA.shifts)
    migrateShiftsColumns(connection)
    connection.exec(SCHEMA.shiftCorrections)
    connection.exec(SCHEMA.shiftCorrectionsShiftIndex)
    connection.exec(SCHEMA.shiftCorrectionsNoUpdate)
    connection.exec(SCHEMA.shiftCorrectionsNoDelete)
    connection.exec(SCHEMA.shiftAdjustments)
    connection.exec(SCHEMA.shiftAdjustmentsShiftIndex)
    connection.exec(SCHEMA.shiftAdjustmentsNoUpdate)
    connection.exec(SCHEMA.shiftAdjustmentsNoDelete)
    connection.exec(SCHEMA.shiftAdjustmentSales)
    connection.exec(SCHEMA.shiftAdjustmentSalesNoUpdate)
    connection.exec(SCHEMA.shiftAdjustmentSalesNoDelete)
    connection.exec(SCHEMA.shiftMerges)
    connection.exec(SCHEMA.shiftMergesNoUpdate)
    connection.exec(SCHEMA.shiftMergesNoDelete)
    migrateCardColumns(connection)
    connection.exec(SCHEMA.integrations)
    connection.exec(SCHEMA.printers)
    migratePrintersColumns(connection)
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
    migrateMpesaApprovalShiftColumn(connection)
    connection.exec(SCHEMA.mpesaDayApprovalsShiftIndex)
    connection.exec(SCHEMA.mpesaDayExclusions)
    connection.exec(SCHEMA.mpesaDayExclusionsPaymentIndex)
    connection.exec(SCHEMA.fiscalDuplicatePrints)
    connection.exec(SCHEMA.fiscalDuplicatePrintsOrderIndex)
    connection.exec(SCHEMA.receiptReprints)
    connection.exec(SCHEMA.receiptReprintsOrderIndex)
    connection.exec(SCHEMA.cartDrafts)
    connection.exec(SCHEMA.cartLineRemovals)
    connection.exec(SCHEMA.cartLineRemovalsTokenIndex)
    connection.exec(SCHEMA.heldSales)
    connection.exec(SCHEMA.heldSalesOpenTokenIndex)
    migrateOrdersFiscalColumns(connection)
    migrateOrdersReceiptColumns(connection)
    migrateOrdersPushColumns(connection)
    migrateOrdersCheckoutKey(connection)
    connection.exec(SCHEMA.ordersCheckoutKeyIndex)
    connection.exec(SCHEMA.orderPayments)
    connection.exec(SCHEMA.orderPaymentsNoUpdate)
    connection.exec(SCHEMA.orderPaymentsNoDelete)
    connection.exec(SCHEMA.fiscalInvoiceIndex)
    connection.exec(SCHEMA.ordersCreatedAtIndex)
    this.connection = connection
    this.recoverHeldSales()
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
      'INSERT OR REPLACE INTO products (id, title, variant_id, variant_title, price, inventory_quantity, image_url, barcode, vat_class, hs_code, hs_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
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
            variant.barcode,
            variant.vatClass ?? null,
            variant.hsCode ?? null,
            variant.hsName ?? null
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
      .prepare('SELECT id, title, variant_id, variant_title, price, inventory_quantity, image_url, barcode, vat_class, hs_code, hs_name FROM products')
      .all() as Array<{
      id: string
      title: string
      variant_id: string
      variant_title: string
      price: number
      inventory_quantity: number
      image_url: string | null
      barcode: string | null
      vat_class?: string | null
      hs_code?: string | null
      hs_name?: string | null
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
        barcode: row.barcode,
        ...(row.vat_class ? { vatClass: row.vat_class } : {}),
        ...(row.hs_code ? { hsCode: row.hs_code } : {}),
        ...(row.hs_name ? { hsName: row.hs_name } : {})
      })
      if (!product.featuredImage && row.image_url) {
        product.featuredImage = row.image_url
      }
    }
    return [...byProduct.values()]
  }

  /**
   * Persists a checkout as a `pending_sync` order plus a `orderCreate`
   * sync-queue entry, atomically. With `input.buildFiscalRequest`, the
   * same transaction also stores the fiscal request, sets
   * `fiscal_status = 'waiting'` and inserts the due `etims_invoice` row.
   *
   * @param {QueueOrderInput} input
   * @returns {QueuedOrder}
   */
  queueOrder(input: QueueOrderInput): QueuedOrder {
    const createdAt = new Date().toISOString()
    const payments = paymentsOfSale(input)
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
      cartDiscount: input.cartDiscount,
      locationId: input.locationId,
      locationName: input.locationName,
      // docs/phase-252: only a split sale carries its payments here, so the payload of a sale paid one way, and the
      // receipt and Shopify note built from it, are exactly as before.
      ...(input.paymentMethod === 'split' ? { payments } : {})
    }

    const insertOrder = this.conn.prepare(
      'INSERT INTO orders (total, status, created_at, payload_json, staff_id, payment_method, tendered_amount, change_due, reference_number, shift_id, checkout_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    const findByKey = this.conn.prepare('SELECT local_id, fiscal_trader_inv_num FROM orders WHERE checkout_key = ?')
    const insertQueue = this.conn.prepare(
      'INSERT INTO sync_queue (entity_type, entity_id, action, payload_json, attempts, created_at, next_attempt_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    const insertPayment = this.conn.prepare(
      'INSERT INTO order_payments (order_local_id, leg_no, method, mpesa_mode, amount, reference, tendered, change_due, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    const enqueue = this.conn.transaction(() => {
      // docs/phase-249: the checkout's key is looked up first, inside the write transaction, before the order id, the
      // trader number, the Shopify queue row and the fiscal row are made. A repeat of the same checkout gets the order the
      // first one made and writes nothing.
      if (input.checkoutKey) {
        const earlier = findByKey.get(input.checkoutKey) as { local_id: number; fiscal_trader_inv_num: string | null } | undefined
        if (earlier) {
          return { localId: earlier.local_id, queueId: 0, traderInvNum: earlier.fiscal_trader_inv_num ?? undefined, existing: true } as QueuedOrder
        }
      }
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
        input.shiftId ?? null,
        input.checkoutKey ?? null
      )
      const localId = Number(orderInfo.lastInsertRowid)
      payments.forEach((payment, index) => {
        insertPayment.run(
          localId,
          index + 1,
          payment.method,
          payment.mpesaMode ?? null,
          payment.amount,
          payment.reference ?? null,
          payment.tendered ?? null,
          payment.changeDue ?? null,
          createdAt
        )
      })
      const traderInvNum = input.locationId ? this.allocateTraderInvNum(input.locationId) : undefined
      if (traderInvNum) {
        this.conn
          .prepare('UPDATE orders SET fiscal_trader_inv_num = ? WHERE local_id = ?')
          .run(traderInvNum, localId)
      }
      const queueInfo = insertQueue.run(
        'order',
        localId,
        'orderCreate',
        JSON.stringify(payload),
        0,
        createdAt,
        0
      )
      const queued: QueuedOrder = { localId, queueId: Number(queueInfo.lastInsertRowid), traderInvNum }
      if (input.buildFiscalRequest) {
        const request = input.buildFiscalRequest(localId, traderInvNum)
        this.conn
          .prepare("UPDATE orders SET fiscal_status = 'waiting', fiscal_request_json = ? WHERE local_id = ?")
          .run(JSON.stringify(request), localId)
        queued.fiscalQueueId = this.queueFiscalInvoice(localId, request).queueId
      }
      this.settleCartForOrder(localId, input.cartToken)
      return queued
    })
    // Immediate: the trader sequence is read, advanced and written inside this transaction, so it
    // takes the write lock at the start instead of upgrading a read (docs/phase-211).
    return enqueue.immediate()
  }

  /**
   * Allocates the next trader system invoice number for a sale at `locationId` (docs/phase-211)
   * and stores the sequence used in `settings.last_trader_seq`. Must run inside the sale's own
   * transaction: the read, the advance and the write are one atomic step, and a refusal to build
   * (a bad location id, a number over 15 characters) aborts the whole sale write.
   *
   * @param {string} locationId
   * @returns {string}
   */
  private allocateTraderInvNum(locationId: string): string {
    const stored = Number(this.getSetting(TRADER_SEQ_SETTING_KEY) ?? '0')
    const seq = nextTraderSeq(Date.now(), Number.isFinite(stored) ? stored : 0)
    const number = buildLocationTraderInvNum(locationId, seq)
    this.setSetting(TRADER_SEQ_SETTING_KEY, String(seq))
    return number
  }

  /**
   * Inside the order's own transaction (docs/phase-197): deletes the saved
   * cart and stamps this cart's removal rows with the new order id, so a
   * stop between "order recorded" and "cart cleared" cannot bring the same
   * cart back after a restart. A held sale that was resumed and is now being
   * checked out is marked `completed` here too (docs/phase-217), so it cannot
   * return to the held strip after a restart.
   *
   * Best effort by design: a failure here is logged and swallowed, because
   * a sale must never be aborted over a draft or an audit stamp. A
   * statement error does not poison the surrounding transaction.
   *
   * @param {number} localId
   * @param {string} [cartToken]
   */
  private settleCartForOrder(localId: number, cartToken?: string): void {
    try {
      this.conn.prepare('DELETE FROM cart_drafts').run()
      if (cartToken) {
        this.conn
          .prepare('UPDATE cart_line_removals SET order_local_id = ? WHERE cart_token = ? AND order_local_id IS NULL')
          .run(localId, cartToken)
        this.conn
          .prepare(
            "UPDATE held_sales SET status = 'completed', order_local_id = ?, completed_at = ? WHERE cart_token = ? AND status IN ('held', 'resumed')"
          )
          .run(localId, new Date().toISOString(), cartToken)
      }
    } catch (err) {
      console.error(`[rubis-pos] Order ${localId}: could not clear the saved cart or stamp its removals:`, err)
    }
  }

  /**
   * Overwrites the one saved cart (docs/phase-197).
   *
   * @param {string} payloadJson
   */
  saveCartDraft(payloadJson: string): void {
    this.conn
      .prepare(
        'INSERT INTO cart_drafts (id, payload_json, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at'
      )
      .run(payloadJson, new Date().toISOString())
  }

  /**
   * @returns {CartDraftRow | undefined} the saved cart, if there is one
   */
  getCartDraft(): CartDraftRow | undefined {
    return this.conn.prepare('SELECT payload_json, updated_at FROM cart_drafts WHERE id = 1').get() as
      | CartDraftRow
      | undefined
  }

  /** Deletes the saved cart. */
  clearCartDraft(): void {
    this.conn.prepare('DELETE FROM cart_drafts').run()
  }

  /**
   * Startup rules for held sales (docs/phase-217), run by {@link init}.
   *
   * A row left at `resumed` means the till stopped while its cart was on
   * screen: it goes back to `held`, so the strip shows it again. A saved cart
   * draft whose token matches a held sale that is not `completed` is deleted:
   * the held row wins, so the sale is never restored twice and never repriced
   * from the catalogue. Best effort, like the draft itself: a failure is logged
   * and startup carries on.
   */
  private recoverHeldSales(): void {
    try {
      this.conn.prepare("UPDATE held_sales SET status = 'held' WHERE status = 'resumed'").run()
      this.conn
        .prepare(
          "DELETE FROM cart_drafts WHERE json_extract(payload_json, '$.cartToken') IN (SELECT cart_token FROM held_sales WHERE status != 'completed')"
        )
        .run()
    } catch (err) {
      console.error('[rubis-pos] Could not reconcile held sales at startup:', err)
    }
  }

  /**
   * @param {HeldSaleRowShape} row
   * @returns {HeldSaleSummary}
   */
  private toHeldSummary(row: HeldSaleRowShape): HeldSaleSummary {
    return {
      id: row.id,
      cartToken: row.cart_token,
      label: row.label,
      total: row.total,
      lineCount: row.line_count,
      unitCount: row.unit_count,
      heldAt: row.held_at,
      heldByStaffId: row.held_by_staff_id,
      status: row.status
    }
  }

  /** @returns {HeldSaleSummary[]} every held or resumed sale, oldest first (docs/phase-217) */
  listOpenHeldSales(): HeldSaleSummary[] {
    const rows = this.conn
      .prepare("SELECT * FROM held_sales WHERE status IN ('held', 'resumed') ORDER BY held_at ASC, id ASC")
      .all() as HeldSaleRowShape[]
    return rows.map((row) => this.toHeldSummary(row))
  }

  /**
   * Parks a cart (docs/phase-217). Nothing else happens: no order, no fiscal
   * request, no Shopify queue row and no trader number.
   *
   * A cart that was held, resumed and is now held again reuses its row and
   * label, and its clock restarts. A new cart takes the next free "Customer N".
   *
   * @param {HoldSaleInput} input
   * @returns {HeldSaleSummary}
   * @throws if the till already holds {@link MAX_HELD_SALES} sales
   */
  holdSale(input: HoldSaleInput): HeldSaleSummary {
    const now = new Date().toISOString()
    const write = this.conn.transaction((): HeldSaleSummary => {
      const existing = this.conn
        .prepare("SELECT * FROM held_sales WHERE cart_token = ? AND status IN ('held', 'resumed')")
        .get(input.cartToken) as HeldSaleRowShape | undefined
      if (existing) {
        this.conn
          .prepare(
            "UPDATE held_sales SET payload_json = ?, total = ?, line_count = ?, unit_count = ?, held_at = ?, held_by_staff_id = ?, status = 'held' WHERE id = ?"
          )
          .run(input.payloadJson, input.total, input.lineCount, input.unitCount, now, input.staffId, existing.id)
        return this.toHeldSummary(
          this.conn.prepare('SELECT * FROM held_sales WHERE id = ?').get(existing.id) as HeldSaleRowShape
        )
      }
      const open = this.listOpenHeldSales()
      if (open.length >= MAX_HELD_SALES) {
        throw new Error(
          `This till already holds ${MAX_HELD_SALES} sales. Complete or discard one before holding another.`
        )
      }
      const label = input.label?.trim().slice(0, MAX_HELD_LABEL_LENGTH) || nextHeldLabel(open.map((sale) => sale.label))
      const info = this.conn
        .prepare(
          "INSERT INTO held_sales (cart_token, label, payload_json, total, line_count, unit_count, held_at, held_by_staff_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'held')"
        )
        .run(input.cartToken, label, input.payloadJson, input.total, input.lineCount, input.unitCount, now, input.staffId)
      return this.toHeldSummary(
        this.conn.prepare('SELECT * FROM held_sales WHERE id = ?').get(Number(info.lastInsertRowid)) as HeldSaleRowShape
      )
    })
    return write()
  }

  /**
   * Takes a held sale back to the cart (docs/phase-217): the row becomes
   * `resumed` and stays, so a stop before the sale is completed returns it to
   * the strip, not to a repriced cart.
   *
   * @param {number} id
   * @returns {{ summary: HeldSaleSummary; payloadJson: string }}
   * @throws if the sale is no longer on hold
   */
  resumeHeldSale(id: number): { summary: HeldSaleSummary; payloadJson: string } {
    const info = this.conn.prepare("UPDATE held_sales SET status = 'resumed' WHERE id = ? AND status = 'held'").run(id)
    if (info.changes === 0) {
      throw new Error('That sale is no longer on hold.')
    }
    const row = this.conn.prepare('SELECT * FROM held_sales WHERE id = ?').get(id) as HeldSaleRowShape
    return { summary: this.toHeldSummary(row), payloadJson: row.payload_json }
  }

  /**
   * @param {number} id
   * @param {string} label
   * @returns {HeldSaleSummary}
   * @throws if the label is empty or the sale is not open
   */
  renameHeldSale(id: number, label: string): HeldSaleSummary {
    const trimmed = label.trim().slice(0, MAX_HELD_LABEL_LENGTH)
    if (!trimmed) {
      throw new Error('A held sale needs a name.')
    }
    const info = this.conn
      .prepare("UPDATE held_sales SET label = ? WHERE id = ? AND status IN ('held', 'resumed')")
      .run(trimmed, id)
    if (info.changes === 0) {
      throw new Error('That sale is no longer on hold.')
    }
    return this.toHeldSummary(this.conn.prepare('SELECT * FROM held_sales WHERE id = ?').get(id) as HeldSaleRowShape)
  }

  /**
   * Discards a held sale, keeping the row (docs/phase-217). The caller has
   * already verified the manager's PIN; a sale on screen (`resumed`) cannot be
   * discarded.
   *
   * @param {{ id: number; staffId: number; managerId: number; reason: string }} input
   * @returns {HeldSaleSummary}
   * @throws if the reason is empty or the sale is not `held`
   */
  discardHeldSale(input: { id: number; staffId: number; managerId: number; reason: string }): HeldSaleSummary {
    const reason = input.reason.trim()
    if (!reason) {
      throw new Error('A reason is required to discard a held sale.')
    }
    const info = this.conn
      .prepare(
        "UPDATE held_sales SET status = 'discarded', discarded_at = ?, discarded_by_staff_id = ?, discard_manager_id = ?, discard_reason = ? WHERE id = ? AND status = 'held'"
      )
      .run(new Date().toISOString(), input.staffId, input.managerId, reason, input.id)
    if (info.changes === 0) {
      throw new Error('That sale is no longer on hold.')
    }
    return this.toHeldSummary(
      this.conn.prepare('SELECT * FROM held_sales WHERE id = ?').get(input.id) as HeldSaleRowShape
    )
  }

  /**
   * @param {string} startIso inclusive
   * @param {string} endIso exclusive
   * @returns {DiscardedHeldSale[]} held sales discarded in the window, oldest first (docs/phase-217)
   */
  getDiscardedHeldSales(startIso: string, endIso: string): DiscardedHeldSale[] {
    const rows = this.conn
      .prepare(
        `SELECT h.id, h.label, h.total, h.line_count, h.held_at, h.discarded_at, h.discard_reason,
                held.name AS held_by_name, gone.name AS discarded_by_name, mgr.name AS manager_name
           FROM held_sales h
           LEFT JOIN staff held ON held.id = h.held_by_staff_id
           LEFT JOIN staff gone ON gone.id = h.discarded_by_staff_id
           LEFT JOIN staff mgr ON mgr.id = h.discard_manager_id
          WHERE h.status = 'discarded' AND h.discarded_at >= ? AND h.discarded_at < ?
          ORDER BY h.discarded_at ASC, h.id ASC`
      )
      .all(startIso, endIso) as Array<{
      id: number
      label: string
      total: number
      line_count: number
      held_at: string
      discarded_at: string
      discard_reason: string
      held_by_name: string | null
      discarded_by_name: string | null
      manager_name: string | null
    }>
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      total: row.total,
      lineCount: row.line_count,
      heldAt: row.held_at,
      discardedAt: row.discarded_at,
      heldByName: row.held_by_name,
      discardedByName: row.discarded_by_name,
      managerName: row.manager_name,
      reason: row.discard_reason
    }))
  }

  /**
   * Appends approved removals in one transaction (docs/phase-197).
   * Insert-only: nothing updates these rows except the order-id stamp at checkout.
   *
   * @param {CartLineRemovalInput[]} rows
   */
  recordCartLineRemovals(rows: CartLineRemovalInput[]): void {
    const insert = this.conn.prepare(
      'INSERT INTO cart_line_removals (order_local_id, cart_token, variant_id, qty_before, qty_after, staff_id, manager_id, at) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?)'
    )
    this.conn.transaction((batch: CartLineRemovalInput[]) => {
      for (const row of batch) {
        insert.run(row.cart_token, row.variant_id, row.qty_before, row.qty_after, row.staff_id, row.manager_id, row.at)
      }
    })(rows)
  }

  /**
   * Every removal row, oldest first. For tests and support only: no POS
   * code path may call this (`tests/cartRemovalGuard.test.ts`).
   *
   * @returns {CartLineRemovalRow[]}
   */
  listCartLineRemovals(): CartLineRemovalRow[] {
    return this.conn.prepare('SELECT * FROM cart_line_removals ORDER BY id ASC').all() as CartLineRemovalRow[]
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
   * @returns {boolean} `false` when the number was refused because another order holds it (docs/phase-208): the sale is then `needs_fixing` and its fiscal row is deleted.
   */
  markFiscalQueueItemSynced(
    queueId: number,
    invoiceNumber: string,
    qrCode: string,
    vatGroups?: FiscalVatGroupAmounts,
    fiscalizedAt?: string,
    fiscalizedAtSource?: 'device' | 'local-fallback',
    cuSerial?: string
  ): boolean {
    const row = this.conn
      .prepare('SELECT entity_id FROM sync_queue WHERE id = ?')
      .get(queueId) as { entity_id: number } | undefined
    if (!row) return true

    const settle = this.conn.transaction((): boolean => {
      const stored = this.setOrderFiscalInfo(
        row.entity_id,
        invoiceNumber,
        qrCode,
        vatGroups,
        fiscalizedAt,
        fiscalizedAtSource,
        cuSerial
      )
      if (!stored) {
        this.setOrderFiscalFailure(row.entity_id, 'needs_fixing', UNVERIFIABLE_RETRY_REASON, 'system')
      }
      this.conn.prepare('DELETE FROM sync_queue WHERE id = ?').run(queueId)
      return stored
    })
    return settle()
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
   * Records checkout's successful first filing and deletes the fiscal row
   * {@link queueOrder} created for it, in one transaction. Keyed on
   * `localId`, unlike {@link markFiscalQueueItemSynced}, so the filing is
   * recorded even if the row has gone (a void during filing).
   *
   * @param {number} localId
   * @param {number} fiscalQueueId
   * @param {FiscalInvoiceResult} invoice
   * @returns {boolean} `false` when the number was refused because another order holds it (docs/phase-208): the sale is then `needs_fixing` and its fiscal row is deleted.
   */
  settleCheckoutFiscalSuccess(localId: number, fiscalQueueId: number, invoice: FiscalInvoiceResult): boolean {
    const settle = this.conn.transaction((): boolean => {
      const stored = this.setOrderFiscalInfo(
        localId,
        invoice.invoiceNumber,
        invoice.qrCode,
        invoice.vatGroups,
        invoice.fiscalizedAt,
        invoice.fiscalizedAtSource,
        invoice.cuSerialNumber
      )
      if (!stored) {
        this.setOrderFiscalFailure(localId, 'needs_fixing', UNVERIFIABLE_RETRY_REASON, 'system')
      }
      this.removeFiscalQueueItem(fiscalQueueId)
      return stored
    })
    return settle()
  }

  /**
   * Records checkout's failed first filing and the fate of its fiscal row
   * in one transaction: `waiting` keeps the row, already due, for the
   * fiscal engine; `needs_fixing` deletes it, as the engine's own
   * reclassification does.
   *
   * @param {number} localId
   * @param {number} fiscalQueueId
   * @param {Exclude<FiscalStatus, 'fiscalized'>} status
   * @param {string} reason
   * @param {FiscalFailureKind} kind
   * @param {'wrong-pin' | null} [dataIssue]
   */
  settleCheckoutFiscalFailure(
    localId: number,
    fiscalQueueId: number,
    status: Exclude<FiscalStatus, 'fiscalized'>,
    reason: string,
    kind: FiscalFailureKind,
    dataIssue: 'wrong-pin' | null = null
  ): void {
    const settle = this.conn.transaction(() => {
      this.setOrderFiscalFailure(localId, status, reason, kind, dataIssue)
      if (status === 'needs_fixing') {
        this.removeFiscalQueueItem(fiscalQueueId)
      }
    })
    settle()
  }

  /**
   * Makes every sale left with `fiscal_status` NULL visible again — the
   * start-up sweep for sales stopped mid-filing before
   * {@link queueOrder} wrote the status in its own transaction
   * (docs/phase-185.md §4.2). Every such sale is flagged `needs_fixing`
   * for a person and none is queued or filed here: a sale stopped long
   * ago may be a test or training sale, and a filed invoice cannot be
   * taken back. One with a stored request can be resent from Needs
   * Attention (`resendFiscalization` uses that request); one without
   * cannot, since `payload_json` lacks the VAT class and HS fields.
   * Idempotent by its `WHERE`: a swept sale is no longer NULL. Must run
   * before the fiscal engine starts.
   *
   * @returns {{ resendable: number; unsendable: number }}
   */
  sweepUnqueuedFiscalOrders(): { resendable: number; unsendable: number } {
    const sweep = this.conn.transaction(() => {
      const rows = this.conn
        .prepare(
          "SELECT local_id, fiscal_request_json FROM orders WHERE fiscal_status IS NULL AND status != 'voided' ORDER BY local_id ASC"
        )
        .all() as { local_id: number; fiscal_request_json: string | null }[]
      let resendable = 0
      let unsendable = 0
      for (const row of rows) {
        if (row.fiscal_request_json) {
          this.setOrderFiscalFailure(row.local_id, 'needs_fixing', INTERRUPTED_FILING_REASON, 'system')
          resendable++
        } else {
          this.setOrderFiscalFailure(row.local_id, 'needs_fixing', INTERRUPTED_UNSENT_REASON, 'system')
          unsendable++
        }
      }
      return { resendable, unsendable }
    })
    return sweep()
  }

  /**
   * One-time start-up repair of sales falsely recorded as filed (docs/phase-212).
   * Before phase 208 a refused retry asked the device for "the last invoice number" and recorded
   * the all-zero counter it answers when it holds nothing as the sale's fiscal reference
   * (docs/phase-206 section 1f). Those rows are write-once and a `fiscalized` sale is never
   * retried, so no later code corrects them.
   *
   * A row matches only when all four are true: `fiscalized`, a number ending in nine zeros, an
   * empty QR, and a `local-fallback` time source. The last two are the old recovery branch's own
   * signature; a sale closed by this till has a device time and a QR. A match is set to
   * `needs_fixing` and its fiscal reference, QR, time and unprinted-slip flag are cleared. This
   * edits no real fiscal reference: the string cleared is the zero counter the device returned
   * when it had no invoice. The serial, the trader number and the stored request are kept, so the
   * sale can be resent from Needs Attention after a person has checked it.
   *
   * Runs once, recorded in `settings.repair_212_ran_at`; later calls change nothing. Must run
   * before the fiscal engine starts.
   *
   * @returns {{ ran: boolean; localIds: number[] }} `ran` is false when it already ran
   */
  repairFalselyFiledOrders(): { ran: boolean; localIds: number[] } {
    const repair = this.conn.transaction(() => {
      if (this.getSetting(REPAIR_212_SETTING_KEY)) return { ran: false, localIds: [] as number[] }
      const rows = this.conn
        .prepare(`SELECT local_id FROM orders WHERE ${FALSELY_FILED_WHERE} ORDER BY local_id ASC`)
        .all() as { local_id: number }[]
      if (rows.length > 0) {
        this.conn
          .prepare(
            `UPDATE orders SET
               fiscal_status = 'needs_fixing',
               fiscal_error_kind = 'system',
               fiscal_error_reason = ?,
               fiscal_invoice_number = NULL,
               fiscal_qr_code = NULL,
               fiscal_fiscalized_at = NULL,
               fiscal_fiscalized_at_source = NULL,
               fiscal_slip_unprinted_at = NULL
             WHERE ${FALSELY_FILED_WHERE}`
          )
          .run(FALSELY_FILED_REPAIR_REASON)
      }
      this.setSetting(REPAIR_212_SETTING_KEY, new Date().toISOString())
      return { ran: true, localIds: rows.map((row) => row.local_id) }
    })
    return repair()
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
        'SELECT local_id, shopify_order_id, total, status, created_at, payload_json, staff_id, payment_method, tendered_amount, change_due, reference_number, shift_id, fiscal_invoice_number, fiscal_qr_code, fiscal_fiscalized_at, fiscal_status, fiscal_error_reason, fiscal_error_kind, fiscal_request_json, fiscal_data_issue, fiscal_vat_groups_json, fiscal_fiscalized_at_source, fiscal_cu_serial, receipt_printed_at, fiscal_trader_inv_num, fiscal_slip_unprinted_at, customer_slip_printed_at FROM orders WHERE local_id = ?'
      )
      .get(localId) as OrderRow | undefined
  }

  /**
   * The order a checkout made, by the key the screen made for it (docs/phase-249), or `undefined` when no order holds it.
   *
   * @param {string} checkoutKey
   * @returns {OrderRow | undefined}
   */
  getOrderByCheckoutKey(checkoutKey: string): OrderRow | undefined {
    const row = this.conn.prepare('SELECT local_id FROM orders WHERE checkout_key = ?').get(checkoutKey) as { local_id: number } | undefined
    return row ? this.getOrder(row.local_id) : undefined
  }

  /**
   * The payment legs of the sales `orderIds` (docs/phase-250): the one place every report, shift figure, preview and
   * export reads how a sale was paid. A sale's legs are its `order_payments` rows, in the order recorded (docs/phase-252);
   * a sale made before that table has none and gets one leg built from `orders.payment_method` and `orders.total`, as
   * before. A voided sale keeps its legs, flagged, so each reader decides as before. One query for the whole list. A
   * sale that does not exist has no entry.
   *
   * @param {readonly number[]} orderIds
   * @returns {Map<number, PaymentLeg[]>} the legs of each sale, by its local id
   */
  paymentLegsFor(orderIds: readonly number[]): Map<number, PaymentLeg[]> {
    const legs = new Map<number, PaymentLeg[]>()
    if (orderIds.length === 0) return legs
    const rows = this.conn
      .prepare(
        'SELECT o.local_id, o.payment_method, o.total, o.status, p.method AS leg_method, p.amount AS leg_amount FROM orders o ' +
          'LEFT JOIN order_payments p ON p.order_local_id = o.local_id ' +
          'WHERE o.local_id IN (SELECT value FROM json_each(?)) ORDER BY o.local_id, p.leg_no'
      )
      .all(JSON.stringify(orderIds)) as Array<{
      local_id: number
      payment_method: OrderPaymentMethod | null
      total: number
      status: OrderStatus
      leg_method: PaymentMethod | null
      leg_amount: number | null
    }>
    for (const row of rows) {
      const voided = row.status === 'voided'
      const leg: PaymentLeg =
        typeof row.leg_amount !== 'number'
          ?{ orderId: row.local_id, method: row.payment_method === 'split' ? null : row.payment_method, amount: row.total, voided }
          : { orderId: row.local_id, method: row.leg_method, amount: row.leg_amount, voided }
      const sale = legs.get(row.local_id)
      if (sale) sale.push(leg)
      else legs.set(row.local_id, [leg])
    }
    return legs
  }

  /**
   * The amount paid by each method on the sales `orderIds`, read from their legs and added in the order given.
   *
   * @param {readonly number[]} orderIds
   * @returns {(method: PaymentMethod) => number}
   */
  private paidByMethod(orderIds: readonly number[]): (method: PaymentMethod) => number {
    const legs = this.paymentLegsFor(orderIds)
    return (method) => methodTotalOf(legs, orderIds, method)
  }

  /**
   * Whether this sale's FISCAL receipt has already been physically
   * printed once (docs/phase-164, narrowed docs/phase-164-1) — the
   * "original vs duplicate" question the `receipt:print` IPC handler asks
   * before rendering, since it is the single call site for every print of
   * a sale's receipt (the very first one and any later reprint alike; see
   * docs/phase-164's audit — there is no separate "print on checkout" code
   * path to tell them apart by). `false` for a sale that has only ever
   * been printed as a PDF fallback, or only while still unfiled — see
   * {@link markReceiptPrinted}.
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
   * Records this sale's FISCAL receipt as physically printed — write-once
   * via `COALESCE(receipt_printed_at, ?)`, so calling this again after a
   * reprint leaves the original print's timestamp in place.
   *
   * The caller (`main/index.ts`) calls this only when BOTH conditions
   * hold (docs/phase-164-1 — narrower than docs/phase-164's original "any
   * successful print"): the print was a real physical print (`result.data
   * ?.mode !== 'pdf'`), AND the order was fiscalised at print time
   * (`order.fiscal_invoice_number` set), so the page that came out of the
   * printer actually carried the CU block. A PDF fallback, or a plain
   * slip for a still-unfiled sale, never marks this — so the eventual
   * first PHYSICAL, FISCALISED print of that same sale is still correctly
   * treated as the original, however many PDF or plain prints came before
   * it.
   *
   * @param {number} localId
   */
  markReceiptPrinted(localId: number): void {
    this.conn
      .prepare(
        'UPDATE orders SET receipt_printed_at = COALESCE(receipt_printed_at, ?), fiscal_slip_unprinted_at = NULL WHERE local_id = ?'
      )
      .run(new Date().toISOString(), localId)
  }

  /**
   * Records that the Enjoy customer slip reached paper (docs/phase-198-1).
   * Write-once via `COALESCE`: the first physical print stands.
   *
   * @param {number} localId
   */
  markCustomerSlipPrinted(localId: number): void {
    this.conn
      .prepare('UPDATE orders SET customer_slip_printed_at = COALESCE(customer_slip_printed_at, ?) WHERE local_id = ?')
      .run(new Date().toISOString(), localId)
  }

  /**
   * Filed sales that hold stored device VAT groups, oldest first, with what the
   * VAT reconcile needs to rebuild the till's own figures (docs/phase-198-1).
   * Voided sales are left out.
   *
   * @returns {VatReconcileOrderRow[]}
   */
  getFiscalisedOrdersWithVatGroups(): VatReconcileOrderRow[] {
    return this.conn
      .prepare(
        `SELECT o.local_id, o.created_at, o.total, s.name AS staff_name, o.payload_json,
                o.fiscal_request_json, o.fiscal_vat_groups_json
         FROM orders o
         LEFT JOIN staff s ON s.id = o.staff_id
         WHERE o.fiscal_status = 'fiscalized'
           AND o.fiscal_vat_groups_json IS NOT NULL
           AND o.status != 'voided'
         ORDER BY o.created_at ASC, o.local_id ASC`
      )
      .all() as VatReconcileOrderRow[]
  }

  /**
   * Stores the trader invoice number sent to the device for a sale
   * (docs/phase-198). Write-once via `COALESCE`, so the value stored at the first
   * send stands however many times the sale is sent again.
   *
   * @param {number} localId
   * @param {string} traderInvNum
   */
  recordTraderInvNum(localId: number, traderInvNum: string): void {
    this.conn
      .prepare('UPDATE orders SET fiscal_trader_inv_num = COALESCE(fiscal_trader_inv_num, ?) WHERE local_id = ?')
      .run(traderInvNum, localId)
  }

  /**
   * Flags a sale filed later whose fiscal slip did not reach paper
   * (docs/phase-198). Keeps the first time it was flagged; a sale whose slip
   * was already printed is never flagged.
   *
   * @param {number} localId
   */
  markFiscalSlipUnprinted(localId: number): void {
    this.conn
      .prepare(
        'UPDATE orders SET fiscal_slip_unprinted_at = COALESCE(fiscal_slip_unprinted_at, ?) WHERE local_id = ? AND receipt_printed_at IS NULL'
      )
      .run(new Date().toISOString(), localId)
  }

  /**
   * Filed sales whose fiscal slip is still unprinted, oldest first, for the
   * Needs Attention list (docs/phase-198). Voided sales are left out.
   *
   * @returns {UnprintedFiscalSlipRow[]}
   */
  getUnprintedFiscalSlips(): UnprintedFiscalSlipRow[] {
    return this.conn
      .prepare(
        `SELECT o.local_id, o.created_at, o.total, s.name AS staff_name, o.fiscal_slip_unprinted_at
         FROM orders o
         LEFT JOIN staff s ON s.id = o.staff_id
         WHERE o.fiscal_slip_unprinted_at IS NOT NULL
           AND o.receipt_printed_at IS NULL
           AND o.fiscal_status = 'fiscalized'
           AND o.status != 'voided'
         ORDER BY o.created_at ASC, o.local_id ASC`
      )
      .all() as UnprintedFiscalSlipRow[]
  }

  /**
   * Appends one row to `receipt_reprints` (docs/phase-198). Insert-only by
   * design: nothing updates or deletes these rows.
   *
   * @param {Omit<ReceiptReprintRow, 'id' | 'at'> & { at?: string }} row
   */
  recordReceiptReprint(row: Omit<ReceiptReprintRow, 'id' | 'at'> & { at?: string }): void {
    this.conn
      .prepare('INSERT INTO receipt_reprints (order_id, slip, staff_id, at) VALUES (?, ?, ?, ?)')
      .run(row.order_id, row.slip, row.staff_id, row.at ?? new Date().toISOString())
  }

  /**
   * Every slip reprint, oldest first — for support and tests.
   *
   * @returns {ReceiptReprintRow[]}
   */
  listReceiptReprints(): ReceiptReprintRow[] {
    return this.conn.prepare('SELECT * FROM receipt_reprints ORDER BY id ASC').all() as ReceiptReprintRow[]
  }

  /**
   * Appends one row to `fiscal_duplicate_prints` (docs/phase-196-2).
   * Insert-only by design: nothing updates or deletes these rows.
   *
   * @param {Omit<FiscalDuplicatePrintRow, 'id'>} row
   */
  recordFiscalDuplicatePrint(row: Omit<FiscalDuplicatePrintRow, 'id'>): void {
    this.conn
      .prepare(
        'INSERT INTO fiscal_duplicate_prints (order_id, staff_id, requested_at, device_last_cu_inv, device_last_cu_inv_after, result, error) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        row.order_id,
        row.staff_id,
        row.requested_at,
        row.device_last_cu_inv,
        row.device_last_cu_inv_after,
        row.result,
        row.error
      )
  }

  /**
   * Every duplicate-print request, oldest first — for support and tests.
   *
   * @returns {FiscalDuplicatePrintRow[]}
   */
  listFiscalDuplicatePrints(): FiscalDuplicatePrintRow[] {
    return this.conn
      .prepare('SELECT * FROM fiscal_duplicate_prints ORDER BY id ASC')
      .all() as FiscalDuplicatePrintRow[]
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
   * @returns {boolean} `false`, with nothing written, when another order already holds `invoiceNumber` (docs/phase-208): a CU number belongs to one sale, so a repeat means the number is not this sale's. The caller routes the sale to `needs_fixing`.
   */
  setOrderFiscalInfo(
    localId: number,
    invoiceNumber: string,
    qrCode: string,
    vatGroups?: FiscalVatGroupAmounts,
    fiscalizedAt?: string,
    fiscalizedAtSource?: 'device' | 'local-fallback',
    cuSerial?: string
  ): boolean {
    if (invoiceNumber) {
      const holder = this.conn
        .prepare('SELECT local_id FROM orders WHERE fiscal_invoice_number = ? AND local_id <> ? LIMIT 1')
        .get(invoiceNumber, localId) as { local_id: number } | undefined
      if (holder) return false
    }
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
    return true
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
        'SELECT local_id, shopify_order_id, total, status, created_at, payload_json, staff_id, payment_method, tendered_amount, change_due, reference_number, shift_id, fiscal_invoice_number, fiscal_qr_code, fiscal_fiscalized_at, fiscal_status, fiscal_error_reason, fiscal_error_kind, fiscal_request_json, fiscal_data_issue, fiscal_vat_groups_json, fiscal_fiscalized_at_source, fiscal_cu_serial, receipt_printed_at, fiscal_trader_inv_num, fiscal_slip_unprinted_at FROM orders WHERE fiscal_invoice_number = ?'
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
        'SELECT local_id, shopify_order_id, total, status, created_at, payload_json, staff_id, payment_method, tendered_amount, change_due, reference_number, shift_id, fiscal_request_json FROM orders WHERE shift_id = ? ORDER BY created_at ASC'
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
                receipt_printed_at, fiscal_trader_inv_num
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
                receipt_printed_at, fiscal_trader_inv_num
         FROM orders WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT ? OFFSET ?`
      )
      .all(startIso, endIso, limit, offset) as OrderRow[]
    const { count } = this.conn
      .prepare('SELECT COUNT(*) as count FROM orders WHERE created_at >= ? AND created_at < ?')
      .get(startIso, endIso) as { count: number }
    return { rows, total: count }
  }

  /**
   * Records that this sale is about to be sent to Shopify's
   * `orderCreate`: adds one to `shopify_push_count` and stamps
   * `shopify_last_push_at`. The sync engine calls this immediately
   * BEFORE the request, so a request whose reply never arrives (a
   * timeout, a crash, a forced quit) still leaves the sale marked as
   * possibly already in Shopify (docs/phase-168 section 2.4). Both
   * columns change in one `UPDATE`, which SQLite commits atomically as
   * its own transaction.
   *
   * Nothing reads the marker yet; a later phase's pre-push check will.
   * {@link retryOrderSync} never resets it, since it lives on the order,
   * not on the queue row.
   *
   * @param {number} localId
   */
  recordPushStarted(localId: number): void {
    this.conn
      .prepare(
        'UPDATE orders SET shopify_push_count = shopify_push_count + 1, shopify_last_push_at = ? WHERE local_id = ?'
      )
      .run(new Date().toISOString(), localId)
  }

  /**
   * Reads one sale's Shopify push marker (see {@link recordPushStarted}).
   *
   * @param {number} localId
   * @returns the count and last push time, or `undefined` when the sale does not exist
   */
  getShopifyPushMarker(localId: number): { count: number; lastPushAt: string | null } | undefined {
    const row = this.conn
      .prepare('SELECT shopify_push_count, shopify_last_push_at FROM orders WHERE local_id = ?')
      .get(localId) as { shopify_push_count: number; shopify_last_push_at: string | null } | undefined
    return row ? { count: row.shopify_push_count, lastPushAt: row.shopify_last_push_at } : undefined
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
   * The Shopify reconciliation check's one write (docs/phase-170 commit
   * 2, design docs/phase-168 section 2.3): a local sale whose push
   * reply was lost, but which turns out to already exist in Shopify as
   * exactly one order, is marked `synced` with that order's id and its
   * `'order'` queue row is removed - the same shape
   * {@link markQueueItemSynced} already writes for an ordinary
   * successful push, so a linked sale is indistinguishable from one
   * that synced normally.
   *
   * `WHERE status IN ('pending_sync', 'failed')` is the whole safety
   * property: a `voided` or already-`synced` sale can never be
   * relinked by this method, whatever the caller passes in. Only
   * `entity_type = 'order'` queue rows are removed - a fiscal retry
   * queued under `'etims_invoice'` for the same `local_id` is
   * untouched.
   *
   * @param {number} localId
   * @param {string} shopifyOrderId
   * @returns {{ linked: boolean }} `false` when the sale's status had
   *   already moved on (a race with something else) - the caller
   *   should not report a link that did not happen.
   */
  linkOrderToShopify(localId: number, shopifyOrderId: string): { linked: boolean } {
    const settle = this.conn.transaction(() => {
      const info = this.conn
        .prepare(
          "UPDATE orders SET status = 'synced', shopify_order_id = ? WHERE local_id = ? AND status IN ('pending_sync', 'failed')"
        )
        .run(shopifyOrderId, localId)
      if (info.changes > 0) {
        this.conn
          .prepare("DELETE FROM sync_queue WHERE entity_type = 'order' AND entity_id = ?")
          .run(localId)
      }
      return { linked: info.changes > 0 }
    })
    return settle()
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
   * Removes a key from the settings table — used by phase 178's
   * post-update check to clear a resolved `pendingUpdateCheck` record.
   *
   * @param {string} key
   */
  deleteSetting(key: string): void {
    this.conn.prepare('DELETE FROM settings WHERE key = ?').run(key)
  }

  /**
   * Takes an online backup of the live database to `destPath`, using
   * SQLite's own backup API (safe under WAL — unlike a plain file copy,
   * this reads committed pages that may still be sitting only in the
   * `-wal` file) — phase 178's pre-update snapshot.
   *
   * @param {string} destPath
   * @returns {Promise<void>}
   */
  async backup(destPath: string): Promise<void> {
    await this.conn.backup(destPath)
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
   * Every order ever recorded — the widest of phase 178's four
   * carried-over-data counts.
   *
   * @returns {number}
   */
  getTotalOrderCount(): number {
    const row = this.conn.prepare('SELECT COUNT(*) as count FROM orders').get() as {
      count: number
    }
    return row.count
  }

  /**
   * Orders not yet confirmed synced to Shopify — the same status set
   * {@link getReconciliationCandidates} already treats as "not yet
   * pushed" (`pending_sync`/`failed`); `voided` is excluded since a
   * voided sale is never meant to reach Shopify (docs/phase-178).
   *
   * @returns {number}
   */
  getUnpushedOrderCount(): number {
    const row = this.conn
      .prepare(`SELECT COUNT(*) as count FROM orders WHERE status IN ('pending_sync', 'failed')`)
      .get() as { count: number }
    return row.count
  }

  /**
   * Every `mpesa_payments` row ever written — phase 178's fourth
   * carried-over-data count.
   *
   * @returns {number}
   */
  getMpesaPaymentCount(): number {
    const row = this.conn.prepare('SELECT COUNT(*) as count FROM mpesa_payments').get() as {
      count: number
    }
    return row.count
  }

  /**
   * Every sale in `sinceIso..now` the Shopify reconciliation check
   * needs to look at (docs/phase-170, design docs/phase-168 section
   * 2.3): a `pending_sync`/`failed` sale that has been pushed at least
   * once (`shopify_push_count > 0` - the lost-response case), or a
   * `synced` sale (to confirm its Shopify order still exists). A
   * `voided` sale is never a candidate for either check - it must
   * never be filed, and it was never expected to still be in Shopify.
   *
   * `client_order_uuid` is parsed out of `payload_json` here, once,
   * rather than by every caller - a malformed payload (should not
   * exist, but this reads real installs) is skipped rather than
   * thrown, since one bad row must never abort the whole check.
   *
   * @param {string} sinceIso - the window's start (this till's own clock)
   * @returns {ReconciliationCandidateRow[]} oldest first
   */
  getReconciliationCandidates(sinceIso: string): ReconciliationCandidateRow[] {
    const rows = this.conn
      .prepare(
        `SELECT local_id, status, shopify_order_id, shopify_push_count, created_at, payload_json
         FROM orders
         WHERE created_at >= ?
           AND (
             (status IN ('pending_sync', 'failed') AND shopify_push_count > 0)
             OR (status = 'synced' AND shopify_order_id IS NOT NULL)
           )
         ORDER BY local_id ASC`
      )
      .all(sinceIso) as Array<{
      local_id: number
      status: OrderStatus
      shopify_order_id: string | null
      shopify_push_count: number
      created_at: string
      payload_json: string
    }>

    const candidates: ReconciliationCandidateRow[] = []
    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payload_json) as { clientOrderUuid?: string }
        if (!payload.clientOrderUuid) continue
        candidates.push({
          local_id: row.local_id,
          status: row.status,
          shopify_order_id: row.shopify_order_id,
          shopify_push_count: row.shopify_push_count,
          created_at: row.created_at,
          client_order_uuid: payload.clientOrderUuid
        })
      } catch {
        // Malformed payload_json on a real install - skip this one row rather than fail the whole check.
      }
    }
    return candidates
  }

  /**
   * Re-queues a failed or pending order for sync. A `pending_sync` order
   * still has its original `'order'` queue row, which is made due now
   * with its attempt count reset to 0; a `failed` order's row was
   * deleted when its attempts ran out, so a fresh one is created from
   * the stored payload.
   *
   * Never a second row for the same sale: two rows made the next tick
   * push the sale twice, creating two Shopify orders (docs/phase-168
   * finding 3).
   *
   * Attempts are reset on a manual retry (docs/phase-169-1 commit B),
   * unlike the automatic backoff `recordQueueFailure` drives: a person
   * pressing Retry Sync is a deliberate, informed decision to try again
   * now, not a background retry that should count toward the same
   * exhaustion budget. The push marker (`recordPushStarted`,
   * `shopify_push_count`/`shopify_last_push_at`) is untouched — that
   * marker's whole purpose is knowing whether Shopify may already have
   * this sale, which a manual retry does not change.
   *
   * @param {number} localId
   * @returns {{ queueId: number }} the reused or newly created row's id
   * @throws if the order is already synced, voided, or does not exist
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
    if (order.status === 'voided') {
      throw new Error(`Order ${localId} is voided and cannot be resynced`)
    }

    const createdAt = new Date().toISOString()
    const settle = this.conn.transaction(() => {
      this.conn
        .prepare('UPDATE orders SET status = ? WHERE local_id = ?')
        .run('pending_sync', localId)

      const existing = this.conn
        .prepare("SELECT id FROM sync_queue WHERE entity_type = 'order' AND entity_id = ? ORDER BY id ASC LIMIT 1")
        .get(localId) as { id: number } | undefined
      if (existing) {
        this.conn
          .prepare('UPDATE sync_queue SET attempts = 0, next_attempt_at = ? WHERE id = ?')
          .run(Date.now(), existing.id)
        return { queueId: existing.id }
      }

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
    // docs/phase-239: `merged_into` names the shift this one was absorbed by, so the history can say so.
    return this.conn
      .prepare(
        `SELECT s.*, m.into_shift_id AS merged_into FROM shifts s
         LEFT JOIN shift_merges m ON m.absorbed_shift_id = s.id
         ORDER BY s.id DESC LIMIT ? OFFSET ?`
      )
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
   * One page of shift history with one row for each window's shift (docs/phase-242): a shift that was merged into
   * another is left out of the list and named on the shift that holds it (`absorbed_shifts`), so Shift History shows
   * a merged window once. The absorbed shift's own row, Z report and records are untouched.
   *
   * Newest first (docs/phase-245): an open shift at the top, then by `clock_in` descending, `id` only to break a tie.
   * The order is the time the shift began, never the id, so a shift recorded later for an earlier time sits where it belongs.
   *
   * @param {number} limit
   * @param {number} offset
   * @returns {ShiftRow[]}
   */
  listVisibleShifts(limit: number, offset: number): ShiftRow[] {
    const rows = this.conn
      .prepare(
        `SELECT s.* FROM shifts s
         WHERE s.id NOT IN (SELECT absorbed_shift_id FROM shift_merges)
         ORDER BY (s.status = 'open') DESC, s.clock_in DESC, s.id DESC LIMIT ? OFFSET ?`
      )
      .all(limit, offset) as ShiftRow[]
    if (rows.length === 0) return rows
    const absorbed = this.conn
      .prepare(
        `SELECT m.into_shift_id AS into_id, s.id AS id, s.clock_in AS clock_in, s.clock_out AS clock_out
         FROM shift_merges m JOIN shifts s ON s.id = m.absorbed_shift_id
         WHERE m.into_shift_id IN (${rows.map(() => '?').join(', ')})
         ORDER BY s.clock_in ASC, s.id ASC`
      )
      .all(...rows.map((row) => row.id)) as Array<{ into_id: number; id: number; clock_in: string; clock_out: string | null }>
    return rows.map((row) => {
      const mine = absorbed.filter((a) => a.into_id === row.id).map(({ id, clock_in, clock_out }) => ({ id, clock_in, clock_out }))
      return mine.length > 0 ? { ...row, absorbed_shifts: mine } : row
    })
  }

  /**
   * How many shifts {@link listVisibleShifts} pages through: every shift not merged into another.
   *
   * @returns {number}
   */
  countVisibleShifts(): number {
    const row = this.conn
      .prepare('SELECT COUNT(*) AS count FROM shifts WHERE id NOT IN (SELECT absorbed_shift_id FROM shift_merges)')
      .get() as { count: number }
    return row.count
  }

  /**
   * The ids of the shifts merged into another (docs/phase-239).
   *
   * @returns {number[]}
   */
  listAbsorbedShiftIds(): number[] {
    return (this.conn.prepare('SELECT absorbed_shift_id AS id FROM shift_merges').all() as Array<{ id: number }>).map((r) => r.id)
  }

  /**
   * The latest closed shift (docs/phase-243): the one most recently opened of those that are closed and were not merged
   * into another. It is the only closed shift a person may correct or give sales to; every older one is frozen.
   * `null` when no shift is closed.
   *
   * @returns {number | null}
   */
  latestClosedShiftId(): number | null {
    const row = this.conn
      .prepare(
        `SELECT id FROM shifts WHERE status = 'closed' AND id NOT IN (SELECT absorbed_shift_id FROM shift_merges)
         ORDER BY clock_in DESC, id DESC LIMIT 1`
      )
      .get() as { id: number } | undefined
    return row?.id ?? null
  }

  /**
   * Whether a closed shift is frozen for people (docs/phase-243): closed, and not the latest closed shift.
   *
   * @param {ShiftRow} shift
   * @returns {boolean}
   */
  isFrozenShift(shift: ShiftRow): boolean {
    return shift.status === 'closed' && shift.id !== this.latestClosedShiftId()
  }

  /**
   * Which shift holds each absorbed shift now, absorbed id to survivor id.
   *
   * @returns {Map<number, number>}
   */
  private absorbedIntoMap(): Map<number, number> {
    const rows = this.conn.prepare('SELECT absorbed_shift_id AS a, into_shift_id AS i FROM shift_merges').all() as Array<{ a: number; i: number }>
    return new Map(rows.map((r) => [r.a, r.i]))
  }

  /**
   * Opens the one shift of the current window (docs/phase-232), in one write transaction so a refusal anywhere
   * writes nothing:
   *
   * 1. no shift is open, and the window of this moment has no shift at all (one shift per window); a closed one
   *    counts;
   * 2. the shift's type is the window's, from the clock; a type from the screen is not a parameter any more;
   * 3. sales already made in this window with no shift join the new shift. `startingCash` is the cash counted in the
   *    drawer now, and the float stored is that less the earlier cash sales, so they are not counted twice. The
   *    M-Pesa balance is treated the same way. If the form showed different earlier sales from the ones that are
   *    there now, nothing is opened;
   * 4. a drawer below the earlier cash refuses, unless an admin chose to start at 0, which is written into the
   *    opening record.
   *
   * @param {number} staffId — the admin the shift is recorded under
   * @param {number} startingCash — the cash counted in the drawer now
   * @param {number | null} [mpesaOpeningBalance] — the M-Pesa till balance if it was read (docs/phase-222), now
   * @param {OpenShiftOptions} [options]
   * @param {number} [nowMs] — the clock; the main process's own
   * @returns {{ shiftId: number }}
   * @throws {Error} with a message fit to show the person opening the shift; nothing is written when it throws
   */
  openShift(
    staffId: number,
    startingCash: number,
    mpesaOpeningBalance: number | null = null,
    options: OpenShiftOptions = {},
    nowMs: number = Date.now()
  ): { shiftId: number } {
    return this.conn.transaction((): { shiftId: number } => {
      if (this.getOpenShift()) {
        throw new Error('A shift is already open')
      }
      const opened = new Date(nowMs).toISOString()
      const window = shiftWindowOf(opened)
      const shifts = this.listShiftWindows()
      // The shift named is the one that holds the window now, not one merged into it (docs/phase-242).
      const absorbed = new Set(this.listAbsorbedShiftIds())
      const holder =
        this.shiftOfWindow(window, shifts.filter((shift) => !absorbed.has(shift.id))) ?? this.shiftOfWindow(window, shifts)
      if (holder) {
        throw new Error(windowHasShiftMessage(window, holder.id))
      }

      const sales = this.listUnattachedSales()
      const byId = new Map(sales.map((sale) => [sale.local_id, sale]))
      const waiting = planAutoAssignment(sales, shifts, nowMs).waiting.map((id) => byId.get(id) as UnattachedSaleRow)
      const earlier = totalOfSales(waiting, this.paidByMethod(waiting.map((sale) => sale.local_id)))
      if (options.earlierShown && !sameEarlierSales(options.earlierShown, earlier)) {
        throw new Error(STALE_EARLIER_SALES_MESSAGE)
      }

      let startingFloat = startingCash
      let reason = OPENED_WITH_EARLIER_SALES_REASON
      if (earlier.count > 0) {
        startingFloat = roundMoney(startingCash - earlier.cash)
        if (startingFloat < 0) {
          if (options.startAtZero !== true) {
            throw new Error(drawerBelowEarlierMessage(startingCash, earlier.cash))
          }
          startingFloat = 0
          reason = startedAtZeroReason(startingCash, earlier.cash)
        }
      }
      let mpesaOpening = mpesaOpeningBalance
      if (mpesaOpening !== null && earlier.mpesa > 0) {
        mpesaOpening = roundMoney(mpesaOpening - earlier.mpesa)
        if (mpesaOpening < 0) {
          throw new Error(mpesaBelowEarlierMessage(mpesaOpeningBalance as number, earlier.mpesa))
        }
      }

      const info = this.conn
        .prepare(
          "INSERT INTO shifts (staff_id, clock_in, starting_cash, status, shift_type, mpesa_opening_balance) VALUES (?, ?, ?, 'open', ?, ?)"
        )
        .run(staffId, opened, startingFloat, window.type, mpesaOpening)
      const shiftId = Number(info.lastInsertRowid)

      if (waiting.length > 0) {
        const orderIds = waiting.map((sale) => sale.local_id)
        this.attachUnattached(orderIds, shiftId)
        this.recordAdjustment({
          shiftId,
          kind: 'opening',
          nowMs,
          byStaffId: staffId,
          reason,
          orderIds,
          openingDrawerCash: startingCash,
          figures: null
        })
      }
      return { shiftId }
    }).immediate()
  }

  /**
   * The shift that holds a window, if any: the first one whose `clock_in` falls in it, open or closed.
   *
   * @param {ShiftWindowInstance} window
   * @param {Array<{ id: number; clock_in: string }>} shifts
   * @returns {{ id: number } | undefined}
   */
  private shiftOfWindow(
    window: ShiftWindowInstance,
    shifts: Array<{ id: number; clock_in: string }>
  ): { id: number } | undefined {
    return shifts.find((shift) => {
      try {
        return sameWindow(shiftWindowOf(shift.clock_in), window)
      } catch {
        return false
      }
    })
  }

  /**
   * Gives sales that have no shift to a shift, each by one `UPDATE` that only matches while the sale still has no
   * shift and is not voided. A sale that does not match throws, which rolls the whole transaction back.
   *
   * @param {number[]} orderIds
   * @param {number} shiftId
   */
  private attachUnattached(orderIds: number[], shiftId: number): void {
    const attach = this.conn.prepare(
      "UPDATE orders SET shift_id = ? WHERE local_id = ? AND shift_id IS NULL AND status <> 'voided'"
    )
    for (const id of orderIds) {
      if (attach.run(shiftId, id).changes !== 1) {
        throw new Error(`Order #${id} could not be given to shift #${shiftId}: it has a shift now, or was voided`)
      }
    }
  }

  /**
   * The time a new record for a shift is stamped with: now, but always after the newest correction or adjustment of
   * that shift, so the newest record is unambiguous even if the clock was set back.
   *
   * @param {number} shiftId
   * @param {number} nowMs
   * @returns {number}
   */
  private nextRecordMs(shiftId: number, nowMs: number): number {
    const row = this.conn
      .prepare(
        'SELECT MAX(at) AS latest FROM (SELECT corrected_at AS at FROM shift_corrections WHERE shift_id = ? UNION ALL SELECT at FROM shift_adjustments WHERE shift_id = ?)'
      )
      .get(shiftId, shiftId) as { latest: string | null }
    const latest = row.latest === null ? Number.NaN : Date.parse(row.latest)
    return Number.isNaN(latest) ? nowMs : Math.max(nowMs, latest + 1)
  }

  /**
   * The figures typed in for a closed shift as they now stand: the newest of the shift's own, its corrections' and
   * its adjustments' snapshots. `null` while the shift is open, and for a shift whose cash was not counted until a
   * correction gives it figures.
   *
   * @param {ShiftRow} shift
   * @returns {ShiftEnteredFigures | null}
   */
  private latestTypedFigures(shift: ShiftRow): ShiftEnteredFigures | null {
    if (shift.status !== 'closed') return null
    const candidates: Array<{ at: string; entered: ShiftEnteredFigures }> = [
      ...this.listShiftCorrections(shift.id).map((row) => ({
        at: row.corrected_at,
        entered: {
          startingCash: row.starting_cash,
          endingCash: row.ending_cash,
          mpesaOpeningBalance: row.mpesa_opening_balance,
          mpesaClosingBalance: row.mpesa_closing_balance,
          cardClosingBalance: row.card_closing_balance ?? null
        }
      })),
      ...this.listShiftAdjustments(shift.id)
        .filter((row) => row.starting_cash !== null && row.ending_cash !== null)
        .map((row) => ({
          at: row.at,
          entered: {
            startingCash: row.starting_cash as number,
            endingCash: row.ending_cash as number,
            mpesaOpeningBalance: row.mpesa_opening_balance,
            mpesaClosingBalance: row.mpesa_closing_balance,
            cardClosingBalance: row.card_closing_balance ?? null
          }
        }))
    ]
    if (candidates.length === 0) {
      if (shift.cash_not_counted === 1) return null
      return {
        startingCash: shift.starting_cash,
        endingCash: shift.ending_cash ?? 0,
        mpesaOpeningBalance: shift.mpesa_opening_balance ?? null,
        mpesaClosingBalance: shift.mpesa_closing_balance ?? null,
        cardClosingBalance: shift.card_closing_balance ?? null
      }
    }
    return candidates.reduce((newest, next) => (next.at >= newest.at ? next : newest)).entered
  }

  /**
   * The figures a closed shift would show now: the latest typed figures with expected cash and the differences
   * worked out from the shift's sales (docs/phase-232, S7: the counted cash is kept, so a difference shows).
   * `deltaCash` and `deltaMpesa` project a sale that is about to join (or leave): used by the preview of a move.
   *
   * @param {ShiftRow} shift
   * @param {number} [deltaCash]
   * @param {number} [deltaMpesa]
   * @returns {(ShiftEnteredFigures & ShiftWorkedFigures) | null} `null` when there are no figures to work from
   */
  private workedFiguresNow(
    shift: ShiftRow,
    deltaCash = 0,
    deltaMpesa = 0
  ): (ShiftEnteredFigures & ShiftWorkedFigures) | null {
    const entered = this.latestTypedFigures(shift)
    if (entered === null) return null
    const counted = this.getOrdersForShift(shift.id).filter((order) => order.status !== 'voided')
    const totalFor = this.paidByMethod(counted.map((order) => order.local_id))
    return { ...entered, ...workShiftFigures(entered, totalFor('cash') + deltaCash, totalFor('mpesa') + deltaMpesa, totalFor('card')) }
  }

  /**
   * Appends one record to the shift adjustments ledger, with the sales it names. The record's time is
   * {@link nextRecordMs}.
   *
   * @param {object} input
   * @returns {number} the new record's id
   */
  private recordAdjustment(input: {
    shiftId: number
    kind: ShiftAdjustmentKind
    nowMs: number
    byStaffId: number | null
    reason: string
    orderIds: number[]
    peerShiftId?: number | null
    openingDrawerCash?: number | null
    figures: (ShiftEnteredFigures & ShiftWorkedFigures) | null
  }): number {
    const find = this.conn.prepare('SELECT local_id, total, created_at FROM orders WHERE local_id = ?')
    const sales = input.orderIds.map((id) => find.get(id) as { local_id: number; total: number; created_at: string })
    const totalFor = this.paidByMethod(sales.map((sale) => sale.local_id))
    const times = sales.map((sale) => sale.created_at).sort()
    const figures = input.figures
    const info = this.conn
      .prepare(
        `INSERT INTO shift_adjustments (shift_id, kind, at, by_staff_id, reason, peer_shift_id, sales_count, sales_total,
                                        cash_total, mpesa_total, card_total, first_sale_at, last_sale_at, opening_drawer_cash,
                                        starting_cash, ending_cash, expected_cash, discrepancy,
                                        mpesa_opening_balance, mpesa_closing_balance, mpesa_expected, mpesa_difference,
                                        card_closing_balance, card_expected, card_difference)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.shiftId,
        input.kind,
        new Date(this.nextRecordMs(input.shiftId, input.nowMs)).toISOString(),
        input.byStaffId,
        input.reason,
        input.peerShiftId ?? null,
        sales.length,
        sales.reduce((sum, sale) => sum + sale.total, 0),
        totalFor('cash'),
        totalFor('mpesa'),
        totalFor('card'),
        times[0] ?? null,
        times[times.length - 1] ?? null,
        input.openingDrawerCash ?? null,
        figures?.startingCash ?? null,
        figures?.endingCash ?? null,
        figures?.expectedCash ?? null,
        figures?.discrepancy ?? null,
        figures?.mpesaOpeningBalance ?? null,
        figures?.mpesaClosingBalance ?? null,
        figures?.mpesaExpected ?? null,
        figures?.mpesaDifference ?? null,
        figures?.cardClosingBalance ?? null,
        figures?.cardExpected ?? null,
        figures?.cardDifference ?? null
      )
    const adjustmentId = Number(info.lastInsertRowid)
    const link = this.conn.prepare('INSERT INTO shift_adjustment_sales (adjustment_id, order_id) VALUES (?, ?)')
    for (const id of input.orderIds) link.run(adjustmentId, id)
    return adjustmentId
  }

  /**
   * Every adjustment of a shift's sales, oldest first (docs/phase-232).
   *
   * @param {number} shiftId
   * @returns {ShiftAdjustmentRow[]}
   */
  listShiftAdjustments(shiftId: number): ShiftAdjustmentRow[] {
    return this.conn
      .prepare('SELECT * FROM shift_adjustments WHERE shift_id = ? ORDER BY at ASC, id ASC')
      .all(shiftId) as ShiftAdjustmentRow[]
  }

  /**
   * The sales every adjustment of a shift names, with what the Z report needs to add them up.
   *
   * @param {number} shiftId
   * @returns {ShiftAdjustmentSaleRow[]}
   */
  listAdjustmentSales(shiftId: number): ShiftAdjustmentSaleRow[] {
    return this.conn
      .prepare(
        `SELECT a.id AS adjustment_id, a.kind AS kind, s.order_id AS order_id, o.total AS total,
                o.payment_method AS payment_method, o.status AS status
         FROM shift_adjustments a
         JOIN shift_adjustment_sales s ON s.adjustment_id = a.id
         JOIN orders o ON o.local_id = s.order_id
         WHERE a.shift_id = ? ORDER BY a.id ASC, s.order_id ASC`
      )
      .all(shiftId) as ShiftAdjustmentSaleRow[]
  }

  /**
   * Closes the open shift, computing expected cash (starting cash +
   * total cash-order revenue for the shift, excluding any order later
   * voided — fix for a shift-close bug where a voided cash sale still
   * counted toward the drawer's expected total) and the discrepancy
   * against the counted ending cash.
   *
   * With an M-Pesa closing balance (docs/phase-222) the balance is stored too; the expected figure
   * (opening balance + the shift's non-voided M-Pesa sales) and the difference are stored only when
   * the shift also has an opening balance. Cash is computed and stored exactly as before either way.
   *
   * @param {number} shiftId
   * @param {number} endingCash
   * @param {number | null} [mpesaClosingBalance] — the M-Pesa till balance if it was read; omitted stores `NULL`
   * @param {number | null} [cardClosingBalance] — the card settlement read from the PDQ (docs/phase-246, R5); omitted stores `NULL`
   * @returns {ShiftCloseResult}
   * @throws if the shift does not exist or is already closed
   */
  closeShift(
    shiftId: number,
    endingCash: number,
    mpesaClosingBalance: number | null = null,
    cardClosingBalance: number | null = null
  ): ShiftCloseResult {
    const shift = this.getShiftById(shiftId)
    if (!shift) {
      throw new Error(`Shift ${shiftId} not found`)
    }
    if (shift.status === 'closed') {
      throw new Error(`Shift ${shiftId} is already closed`)
    }

    const counted = this.getOrdersForShift(shiftId).filter((order) => order.status !== 'voided')
    const totalFor = this.paidByMethod(counted.map((order) => order.local_id))

    const expectedCash = shift.starting_cash + totalFor('cash')
    const discrepancy = endingCash - expectedCash

    const mpesaOpening = shift.mpesa_opening_balance ?? null
    const mpesaExpected = mpesaOpening !== null ? mpesaOpening + totalFor('mpesa') : null
    const mpesaDifference =
      mpesaExpected !== null && mpesaClosingBalance !== null ? mpesaClosingBalance - mpesaExpected : null
    // Expected is stored only with a counted balance beside it, so a stored expected always has its difference.
    const storedMpesaExpected = mpesaDifference !== null ? mpesaExpected : null
    // docs/phase-246, R5: card expected is the shift's card sales, kept only with a counted figure beside it.
    const cardExpected = cardClosingBalance !== null ? totalFor('card') : null
    const cardDifference = cardClosingBalance !== null && cardExpected !== null ? cardClosingBalance - cardExpected : null

    this.conn.transaction(() => {
      this.conn
        .prepare(
          "UPDATE shifts SET clock_out = ?, expected_cash = ?, ending_cash = ?, discrepancy = ?, status = 'closed' WHERE id = ?"
        )
        .run(new Date().toISOString(), expectedCash, endingCash, discrepancy, shiftId)
      if (mpesaClosingBalance !== null) {
        this.conn
          .prepare(
            'UPDATE shifts SET mpesa_closing_balance = ?, mpesa_expected = ?, mpesa_difference = ? WHERE id = ?'
          )
          .run(mpesaClosingBalance, storedMpesaExpected, mpesaDifference, shiftId)
      }
      if (cardClosingBalance !== null) {
        this.conn
          .prepare('UPDATE shifts SET card_closing_balance = ?, card_expected = ?, card_difference = ? WHERE id = ?')
          .run(cardClosingBalance, cardExpected, cardDifference, shiftId)
      }
    })()

    return {
      expectedCash,
      discrepancy,
      mpesaExpected: storedMpesaExpected,
      mpesaDifference,
      ...(cardExpected !== null && cardDifference !== null ? { cardExpected, cardDifference } : {})
    }
  }

  /**
   * Every sale that has no shift and was not voided, oldest first — the list the "Sales with no shift" block
   * groups by Nairobi day (docs/phase-223). Voided sales are left out: they count in no report, so "no shift"
   * keeps meaning "a counted sale with no shift".
   *
   * @returns {UnattachedSaleRow[]}
   */
  listUnattachedSales(): UnattachedSaleRow[] {
    return this.conn
      .prepare(
        "SELECT local_id, created_at, total, payment_method FROM orders WHERE shift_id IS NULL AND status <> 'voided' ORDER BY created_at ASC"
      )
      .all() as UnattachedSaleRow[]
  }

  /**
   * Every shift's window, for the overlap rule (docs/phase-223).
   *
   * @returns {Array<{ id: number; clock_in: string; clock_out: string | null }>}
   */
  listShiftWindows(): Array<{ id: number; clock_in: string; clock_out: string | null }> {
    return this.conn.prepare('SELECT id, clock_in, clock_out FROM shifts').all() as Array<{
      id: number
      clock_in: string
      clock_out: string | null
    }>
  }

  /**
   * Gives every sale with no shift to the shift it belongs to (docs/phase-232), by the plan
   * {@link planAutoAssignment} makes: inside a shift's times, otherwise the shift of its window (the nearest when
   * a window holds two), otherwise, for a window that has ended, a new shift made for it (cash not counted). Sales
   * of the current window with no shift yet are left to join the shift when it opens.
   *
   * One write transaction: any refusal writes nothing. A sale that already has a shift is never touched (the
   * `UPDATE` only matches while it has none). Running it again straight away finds nothing to do and writes nothing.
   * A run that starts while another is in progress does nothing.
   *
   * @param {number} [nowMs] — the clock; the main process's own
   * @returns {AutoAssignResult}
   * @throws {Error} when a step is refused; nothing is written
   */
  autoAssignUnattachedSales(nowMs: number = Date.now()): AutoAssignResult {
    if (this.autoAssigning) return { touched: [], waiting: 0, skipped: true }
    this.autoAssigning = true
    try {
      return this.conn.transaction((): AutoAssignResult => {
        const sales = this.listUnattachedSales()
        if (sales.length === 0) return { touched: [], waiting: 0 }
        const plan = planAutoAssignment(sales, this.listShiftWindows(), nowMs, this.absorbedIntoMap())
        const touched: AutoAssignTouched[] = []

        for (const create of plan.creates) {
          const shiftId = this.insertAutomaticShift(create.windowType, create.startIso, create.endIso, nowMs)
          this.attachUnattached(create.orderIds, shiftId)
          this.recordAdjustment({
            shiftId,
            kind: 'opening',
            nowMs,
            byStaffId: null,
            reason: AUTO_SHIFT_REASON,
            orderIds: create.orderIds,
            figures: null
          })
          touched.push({
            shiftId,
            created: true,
            windowType: create.windowType,
            windowDate: create.windowDate,
            count: create.orderIds.length
          })
        }

        for (const join of plan.joins) {
          this.attachUnattached(join.orderIds, join.shiftId)
          const shift = this.getShiftById(join.shiftId) as ShiftRow
          this.recordAdjustment({
            shiftId: join.shiftId,
            kind: 'auto',
            nowMs,
            byStaffId: null,
            reason: join.reason,
            orderIds: join.orderIds,
            figures: this.workedFiguresNow(shift)
          })
          const window = shiftWindowOf(shift.clock_in)
          touched.push({
            shiftId: join.shiftId,
            created: false,
            windowType: window.type,
            windowDate: window.startDate,
            count: join.orderIds.length
          })
        }
        return { touched, waiting: plan.waiting.length }
      }).immediate()
    } finally {
      this.autoAssigning = false
    }
  }

  /**
   * Makes the closed, cash-not-counted shift for the sales of an ended window (docs/phase-232). The shift has no
   * staff member (`staff_id` 0, nobody recorded it) and says why in its reason. Refused, writing nothing, if the
   * window already has a shift, the period is not inside one window, or it overlaps a shift.
   *
   * @param {ShiftType} windowType
   * @param {string} startIso
   * @param {string} endIso
   * @param {number} nowMs
   * @returns {number} the new shift's id
   */
  private insertAutomaticShift(windowType: ShiftType, startIso: string, endIso: string, nowMs: number): number {
    const window = shiftWindowOf(startIso)
    if (window.type !== windowType || !sameWindow(window, shiftWindowOf(endIso))) {
      throw new Error('A shift made for sales must lie inside one window')
    }
    const shifts = this.listShiftWindows()
    const holder = this.shiftOfWindow(window, shifts)
    if (holder) {
      throw new Error(windowHasShiftMessage(window, holder.id))
    }
    const overlap = findOverlappingShift(shifts, Date.parse(startIso), Date.parse(endIso))
    if (overlap) {
      throw new Error(`This period overlaps shift #${overlap.id}`)
    }
    const info = this.conn
      .prepare(
        `INSERT INTO shifts (staff_id, clock_in, clock_out, starting_cash, expected_cash, ending_cash, discrepancy, status, shift_type,
                             mpesa_opening_balance, mpesa_closing_balance, mpesa_expected, mpesa_difference,
                             kind, created_by_staff_id, created_at, reason, cash_not_counted)
         VALUES (0, ?, ?, 0, NULL, NULL, NULL, 'closed', ?, NULL, NULL, NULL, NULL, 'retrospective', NULL, ?, ?, 1)`
      )
      .run(startIso, endIso, window.type, new Date(nowMs).toISOString(), AUTO_SHIFT_REASON)
    return Number(info.lastInsertRowid)
  }

  /**
   * What moving one sale to another shift would do, read-only (docs/phase-232): the sale, the two shifts, and the
   * expected cash and difference each would show afterwards. Never throws: the screen shows `problem` instead.
   *
   * With `override` (docs/phase-244) the two closed-shift rules of phase 243 are lifted for the preview, so the figures
   * show; the sale, the shifts and every other refusal stay. Whether the caller may override is not decided here.
   *
   * @param {number} orderId
   * @param {number} toShiftId
   * @param {boolean} [override]
   * @returns {SaleMovePreview}
   */
  previewSaleMove(orderId: number, toShiftId: number, override = false): SaleMovePreview {
    const order = this.conn
      .prepare('SELECT local_id, total, status, created_at, payment_method, shift_id FROM orders WHERE local_id = ?')
      .get(orderId) as
      | { local_id: number; total: number; status: OrderStatus; created_at: string; payment_method: OrderPaymentMethod | null; shift_id: number | null }
      | undefined
    const empty: SaleMovePreview = {
      orderId,
      total: 0,
      paymentMethod: null,
      createdAt: null,
      fromShiftId: null,
      toShiftId,
      differentWindow: false,
      from: null,
      to: null,
      problem: null,
      overridable: false,
      overridden: false
    }
    if (!order) return { ...empty, problem: `Order #${orderId} does not exist` }
    const base = {
      ...empty,
      total: order.total,
      // docs/phase-252: a split sale is shown with its payments; a sale paid one way shows its method, as before.
      paymentMethod:
        order.payment_method === 'split' ? describePayment(this.paymentLegsFor([order.local_id]).get(order.local_id) ?? []) : order.payment_method,
      createdAt: order.created_at,
      fromShiftId: order.shift_id
    }
    if (order.status === 'voided') return { ...base, problem: `Order #${orderId} was voided` }
    if (order.shift_id === null) return { ...base, problem: `Order #${orderId} has no shift. The till gives it one by itself.` }
    if (order.shift_id === toShiftId) return { ...base, problem: `Order #${orderId} is already in shift #${toShiftId}` }
    const to = this.getShiftById(toShiftId)
    const from = this.getShiftById(order.shift_id)
    if (!to) return { ...base, problem: `Shift ${toShiftId} not found` }
    if (!from) return { ...base, problem: `Shift ${order.shift_id} not found` }
    // docs/phase-243: no sale leaves a closed shift by hand, and only the latest closed shift can be given one.
    // docs/phase-244: an admin's override lifts exactly these two rules and nothing above or below them.
    const freezeProblem =
      from.status === 'closed'
        ? closedShiftKeepsSalesMessage(from.id)
        : this.isFrozenShift(to)
          ? frozenShiftMessage(to.id, this.latestClosedShiftId())
          : null
    if (freezeProblem !== null && !override) return { ...base, problem: freezeProblem, overridable: true }
    const paid = this.paidByMethod([order.local_id])
    const cash = paid('cash')
    const mpesa = paid('mpesa')
    const after = (shift: ShiftRow, sign: 1 | -1): MoveFigures | null => {
      const worked = this.workedFiguresNow(shift, sign * cash, sign * mpesa)
      return worked && { expectedCash: worked.expectedCash, discrepancy: worked.discrepancy, mpesaExpected: worked.mpesaExpected, mpesaDifference: worked.mpesaDifference }
    }
    return {
      ...base,
      differentWindow: this.isDifferentWindow(order.created_at, to),
      from: after(from, -1),
      to: after(to, 1),
      problem: null,
      overridden: freezeProblem !== null
    }
  }

  /**
   * Refuses an override request unless it comes from an active admin with a reason of 10 or more characters
   * (docs/phase-244). The IPC handler has already verified that admin's PIN; this is the guard that does not depend
   * on the handler.
   *
   * @param {number} managerId
   * @param {string} reason — trimmed
   * @throws {Error} with a message fit to show the admin
   */
  private requireOverrideAllowed(managerId: number, reason: string): void {
    const staff = this.getStaffById(managerId)
    if (!staff || staff.role !== 'admin' || staff.is_active !== 1) throw new Error(OVERRIDE_ADMIN_ONLY_MESSAGE)
    if (reason.length < OVERRIDE_REASON_MIN_LENGTH) throw new Error(OVERRIDE_REASON_MESSAGE)
  }

  /**
   * Whether a sale was made outside the window of a shift and outside its times.
   *
   * @param {string} saleAt
   * @param {ShiftRow} shift
   * @returns {boolean}
   */
  private isDifferentWindow(saleAt: string, shift: ShiftRow): boolean {
    const saleMs = Date.parse(saleAt)
    if (findOverlappingShift([shift], saleMs, saleMs)) return false
    return !sameWindow(shiftWindowOf(saleAt), shiftWindowOf(shift.clock_in))
  }

  /**
   * Moves one sale from the shift it is in to another (docs/phase-232, S5). The only way a sale ever leaves a shift.
   * One write transaction: the sale must exist, not be voided, and be in a shift other than the target; a sale
   * made in a different window needs `acknowledgeDifferentWindow`. A single `UPDATE` that only matches while the
   * sale is still in the shift it was read in moves it. Two adjustment records follow, one on each shift, sharing
   * who, when and why, each with the figures its shift now shows. The caller has already checked the admin's PIN.
   *
   * `override: true` (docs/phase-244) lifts phase 243's two closed-shift rules, for an active admin with a reason of
   * 10 or more characters only; the stored reason then starts `OVERRIDE (closed, not latest): ` so the Z report shows
   * it was forced. A move that needed no override is stored as it is: the prefix means a rule was lifted.
   *
   * @param {ReassignSaleInput} input
   * @param {number} [nowMs]
   * @returns {{ fromShiftId: number; toShiftId: number }}
   * @throws {Error} with a message fit to show the admin; nothing is written when it throws
   */
  reassignSale(input: ReassignSaleInput, nowMs: number = Date.now()): { fromShiftId: number; toShiftId: number } {
    const reason = input.reason.trim()
    if (reason === '') {
      throw new Error('A reason is required to move a sale')
    }
    return this.conn.transaction((): { fromShiftId: number; toShiftId: number } => {
      if (input.override === true) this.requireOverrideAllowed(input.managerId, reason)
      const preview = this.previewSaleMove(input.orderId, input.toShiftId, input.override === true)
      if (preview.problem !== null) {
        throw new Error(preview.problem)
      }
      if (preview.differentWindow && input.acknowledgeDifferentWindow !== true) {
        throw new Error('This sale was made in a different window from that shift. Confirm that it belongs there.')
      }
      const fromShiftId = preview.fromShiftId as number
      const move = this.conn.prepare(
        "UPDATE orders SET shift_id = ? WHERE local_id = ? AND shift_id = ? AND status <> 'voided'"
      )
      if (move.run(input.toShiftId, input.orderId, fromShiftId).changes !== 1) {
        throw new Error(`Order #${input.orderId} could not be moved: it changed while this was being done`)
      }
      for (const [shiftId, kind, peerShiftId] of [
        [fromShiftId, 'reassign_out', input.toShiftId],
        [input.toShiftId, 'reassign_in', fromShiftId]
      ] as const) {
        this.recordAdjustment({
          shiftId,
          kind,
          nowMs,
          byStaffId: input.managerId,
          reason: preview.overridden ? `${OVERRIDE_REASON_PREFIX}${reason}` : reason,
          peerShiftId,
          orderIds: [input.orderId],
          figures: this.workedFiguresNow(this.getShiftById(shiftId) as ShiftRow)
        })
      }
      return { fromShiftId, toShiftId: input.toShiftId }
    }).immediate()
  }

  /**
   * The merge record of a shift that was absorbed by another (docs/phase-239).
   *
   * @param {number} absorbedShiftId
   * @returns {ShiftMergeRow | undefined}
   */
  getShiftMerge(absorbedShiftId: number): ShiftMergeRow | undefined {
    return this.conn.prepare('SELECT * FROM shift_merges WHERE absorbed_shift_id = ?').get(absorbedShiftId) as
      | ShiftMergeRow
      | undefined
  }

  /**
   * What merging one shift into another would do (docs/phase-239), and why it may not: the two must exist and differ,
   * neither may have been merged already, the absorbed one must be closed, and both must lie in the same window. A read.
   *
   * @param {number} absorbedShiftId
   * @param {number} intoShiftId
   * @returns {ShiftMergePreview}
   */
  previewShiftMerge(absorbedShiftId: number, intoShiftId: number, byTill = false): ShiftMergePreview {
    const absorbed = this.getShiftById(absorbedShiftId)
    const into = this.getShiftById(intoShiftId)
    const sales = absorbed
      ? this.getOrdersForShift(absorbedShiftId).filter((order) => order.status !== 'voided')
      : []
    const base = {
      absorbedShiftId,
      intoShiftId,
      salesCount: sales.length,
      salesTotal: sales.reduce((sum, order) => sum + order.total, 0),
      into: null
    }
    const refuse = (problem: string): ShiftMergePreview => ({ ...base, problem })
    if (!absorbed) return refuse(`Shift #${absorbedShiftId} does not exist`)
    if (!into) return refuse(`Shift #${intoShiftId} does not exist`)
    if (absorbedShiftId === intoShiftId) return refuse('A shift cannot be merged into itself')
    if (this.getShiftMerge(absorbedShiftId)) return refuse(`Shift #${absorbedShiftId} was already merged`)
    if (this.getShiftMerge(intoShiftId)) return refuse(`Shift #${intoShiftId} was merged into another shift; merge into that one`)
    if (absorbed.status !== 'closed') return refuse(`Shift #${absorbedShiftId} is still open. Close it first`)
    // docs/phase-243: a person cannot give sales to a closed shift that is not the latest one. The till's own merge of
    // a window's shifts is not a person's change and is not held to this.
    if (!byTill && this.isFrozenShift(into)) return refuse(frozenShiftMessage(intoShiftId, this.latestClosedShiftId()))
    try {
      if (!sameWindow(shiftWindowOf(absorbed.clock_in), shiftWindowOf(into.clock_in))) {
        return refuse('The two shifts are in different windows. Only shifts of one window can be merged')
      }
    } catch {
      return refuse('The time of one of the shifts cannot be read')
    }
    const totalFor = this.paidByMethod(sales.map((order) => order.local_id))
    const worked = this.workedFiguresNow(into, totalFor('cash'), totalFor('mpesa'))
    return {
      ...base,
      into: worked && { expectedCash: worked.expectedCash, discrepancy: worked.discrepancy, mpesaExpected: worked.mpesaExpected, mpesaDifference: worked.mpesaDifference },
      problem: null
    }
  }

  /**
   * Merges one shift into another in the same window (docs/phase-239). One write transaction: every sale of the
   * absorbed shift moves to the surviving one through the same guarded `UPDATE` a single move uses, one adjustment
   * record goes on each shift naming the other, and one `shift_merges` row says the absorbed shift is spent. The
   * surviving shift keeps its own float and count and its figures recalculate from all the sales; the absorbed
   * shift's row is never touched. No undo: a sale can be moved back with `reassignSale`. The caller has already
   * checked the admin's PIN.
   *
   * @param {MergeShiftsInput} input
   * @param {number} [nowMs]
   * @returns {{ absorbedShiftId: number; intoShiftId: number; salesCount: number }}
   * @throws {Error} with a message fit to show the admin; nothing is written when it throws
   */
  mergeShifts(input: MergeShiftsInput, nowMs: number = Date.now()): { absorbedShiftId: number; intoShiftId: number; salesCount: number } {
    const reason = input.reason.trim()
    if (reason === '') {
      throw new Error('A reason is required to merge shifts')
    }
    return this.conn.transaction((): { absorbedShiftId: number; intoShiftId: number; salesCount: number } => {
      const preview = this.previewShiftMerge(input.absorbedShiftId, input.intoShiftId)
      if (preview.problem !== null) {
        throw new Error(preview.problem)
      }
      return this.performMerge(input.absorbedShiftId, input.intoShiftId, input.managerId, reason, nowMs)
    }).immediate()
  }

  /**
   * Moves a shift's live sales into another shift and records it (docs/phase-239, shared with docs/phase-242): each sale
   * by the guarded `UPDATE` that must change exactly one row, an adjustment on each shift, and the merge row. The
   * caller has already checked the merge is allowed ({@link previewShiftMerge}) and runs this inside a transaction.
   * `byStaffId` 0 is the till itself: the adjustments then name nobody.
   *
   * @param {number} absorbedShiftId
   * @param {number} intoShiftId
   * @param {number} byStaffId — the admin, or 0 for an automatic merge
   * @param {string} reason
   * @param {number} nowMs
   * @returns {{ absorbedShiftId: number; intoShiftId: number; salesCount: number }}
   */
  private performMerge(
    absorbedShiftId: number,
    intoShiftId: number,
    byStaffId: number,
    reason: string,
    nowMs: number
  ): { absorbedShiftId: number; intoShiftId: number; salesCount: number } {
    const orderIds = this.getOrdersForShift(absorbedShiftId)
      .filter((order) => order.status !== 'voided')
      .map((order) => order.local_id)
    const move = this.conn.prepare(
      "UPDATE orders SET shift_id = ? WHERE local_id = ? AND shift_id = ? AND status <> 'voided'"
    )
    for (const orderId of orderIds) {
      if (move.run(intoShiftId, orderId, absorbedShiftId).changes !== 1) {
        throw new Error(`Order #${orderId} could not be moved: it changed while this was being done`)
      }
    }
    const mergeReason = `Merged shift #${absorbedShiftId} into shift #${intoShiftId}: ${reason}`
    for (const [shiftId, kind, peerShiftId] of [
      [absorbedShiftId, 'reassign_out', intoShiftId],
      [intoShiftId, 'reassign_in', absorbedShiftId]
    ] as const) {
      this.recordAdjustment({
        shiftId,
        kind,
        nowMs,
        byStaffId: byStaffId === 0 ? null : byStaffId,
        reason: mergeReason,
        peerShiftId,
        orderIds,
        figures: this.workedFiguresNow(this.getShiftById(shiftId) as ShiftRow)
      })
    }
    this.conn
      .prepare(
        'INSERT INTO shift_merges (absorbed_shift_id, into_shift_id, by_staff_id, at, reason, sales_count) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(absorbedShiftId, intoShiftId, byStaffId, new Date(nowMs).toISOString(), reason, orderIds.length)
    return { absorbedShiftId, intoShiftId, salesCount: orderIds.length }
  }

  /**
   * Merges every window that holds more than one shift into one (docs/phase-242), by the time frames: the shifts of
   * a window are the ones whose `clock_in` falls in it; the shift that holds the window is the open one, or else the
   * one opened last; the others are absorbed into it, earliest first, with the same record a person's merge leaves
   * (made by the till, no PIN). A window with two open shifts, or one whose merge the rules refuse, is left alone.
   * The surviving shift keeps its own float and count, as in a merge by hand.
   *
   * One write transaction: any refusal writes nothing. Running it again finds one shift in every window and does
   * nothing. A run that starts during another does nothing.
   *
   * @param {number} [nowMs] — the clock; the main process's own
   * @returns {AutoMergeResult}
   */
  autoMergeSameWindowShifts(nowMs: number = Date.now()): AutoMergeResult {
    if (this.autoMerging) return { merged: [], skipped: true }
    this.autoMerging = true
    try {
      return this.conn.transaction((): AutoMergeResult => {
        const absorbed = new Set(this.listAbsorbedShiftIds())
        const live = (
          this.conn.prepare('SELECT id, clock_in, clock_out, status FROM shifts ORDER BY clock_in ASC, id ASC').all() as Array<{
            id: number
            clock_in: string
            clock_out: string | null
            status: ShiftStatus
          }>
        ).filter((shift) => !absorbed.has(shift.id))
        const groups = new Map<string, typeof live>()
        for (const shift of live) {
          try {
            const window = shiftWindowOf(shift.clock_in)
            const key = `${window.type}|${window.startDate}`
            groups.set(key, [...(groups.get(key) ?? []), shift])
          } catch {
            // A shift whose time cannot be read belongs to no window and is left alone.
          }
        }
        const merged: AutoMergeResult['merged'] = []
        for (const group of groups.values()) {
          if (group.length < 2) continue
          const open = group.filter((shift) => shift.status === 'open')
          if (open.length > 1) continue
          const survivor = open[0] ?? group[group.length - 1]
          const others = group.filter((shift) => shift.id !== survivor.id)
          if (others.some((shift) => this.previewShiftMerge(shift.id, survivor.id, true).problem !== null)) continue
          for (const other of others) {
            merged.push(this.performMerge(other.id, survivor.id, 0, AUTO_MERGE_REASON, nowMs))
          }
        }
        return { merged }
      }).immediate()
    } finally {
      this.autoMerging = false
    }
  }

  /**
   * Every correction of a shift's figures, oldest first; the last one is the current figures (docs/phase-224).
   *
   * @param {number} shiftId
   * @returns {ShiftCorrectionRow[]}
   */
  listShiftCorrections(shiftId: number): ShiftCorrectionRow[] {
    return this.conn
      .prepare('SELECT * FROM shift_corrections WHERE shift_id = ? ORDER BY id ASC')
      .all(shiftId) as ShiftCorrectionRow[]
  }

  /**
   * Appends a correction of the figures typed in for a closed shift (docs/phase-224). Nothing is edited: the
   * shift's own row stays as it was, a new row is added, and the Z report shows both. The expected and difference
   * figures are worked out now from the shift's non-voided sales, exactly as at close, and stored.
   *
   * Refused (nothing written) for a missing or still-open shift, a blank reason, a figure that is not a finite
   * non-negative number, and a correction that changes nothing from the current figures (the shift's own, or the
   * last correction's). One write transaction, so two managers correcting at once cannot both pass the
   * "changes something" check against the same current figures.
   *
   * `override: true` (docs/phase-244) lets an active admin with a reason of 10 or more characters correct a closed
   * shift that is not the latest (phase 243's freeze); the stored reason then starts `OVERRIDE (closed, not latest): `.
   * It never opens an open or missing shift, and a correction that needed no override is stored as it is.
   *
   * @param {AddShiftCorrectionInput} input
   * @param {number} [nowMs]
   * @returns {ShiftCorrectionRow}
   * @throws {Error} with a message fit to show the manager
   */
  addShiftCorrection(input: AddShiftCorrectionInput, nowMs: number = Date.now()): ShiftCorrectionRow {
    const reason = input.reason.trim()
    if (reason === '') {
      throw new Error('A reason is required to correct a shift')
    }
    const figures = [input.startingCash, input.endingCash, input.mpesaOpeningBalance, input.mpesaClosingBalance, input.cardClosingBalance ?? null]
    if (figures.some((value) => value !== null && !(Number.isFinite(value) && value >= 0))) {
      throw new Error('Every figure must be a number of 0 or more')
    }

    return this.conn.transaction((): ShiftCorrectionRow => {
      if (input.override === true) this.requireOverrideAllowed(input.managerId, reason)
      const shift = this.getShiftById(input.shiftId)
      if (!shift) {
        throw new Error(`Shift ${input.shiftId} not found`)
      }
      if (shift.status !== 'closed') {
        throw new Error(`Shift ${input.shiftId} is still open: close it before correcting its figures`)
      }
      // docs/phase-243: only the latest closed shift can be corrected; an older one is frozen.
      // docs/phase-244: an admin's override is the one way past it, and the stored reason says so.
      const overridden = this.isFrozenShift(shift)
      if (overridden && input.override !== true) {
        throw new Error(frozenShiftMessage(shift.id, this.latestClosedShiftId()))
      }
      const storedReason = overridden ? `${OVERRIDE_REASON_PREFIX}${reason}` : reason

      const corrections = this.listShiftCorrections(input.shiftId)
      const latest = corrections[corrections.length - 1]
      const current: ShiftEnteredFigures = latest
        ? {
            startingCash: latest.starting_cash,
            endingCash: latest.ending_cash,
            mpesaOpeningBalance: latest.mpesa_opening_balance,
            mpesaClosingBalance: latest.mpesa_closing_balance,
            cardClosingBalance: latest.card_closing_balance ?? null
          }
        : {
            startingCash: shift.starting_cash,
            endingCash: shift.ending_cash ?? 0,
            mpesaOpeningBalance: shift.mpesa_opening_balance ?? null,
            mpesaClosingBalance: shift.mpesa_closing_balance ?? null,
            cardClosingBalance: shift.card_closing_balance ?? null
          }
      const entered: ShiftEnteredFigures = {
        startingCash: input.startingCash,
        endingCash: input.endingCash,
        mpesaOpeningBalance: input.mpesaOpeningBalance,
        mpesaClosingBalance: input.mpesaClosingBalance,
        cardClosingBalance: input.cardClosingBalance ?? null
      }
      // A shift whose cash was not counted (docs/phase-227) has no figures to compare with: the first correction adds them.
      const hasNoCashFigures = !latest && shift.cash_not_counted === 1
      if (!hasNoCashFigures && sameEnteredFigures(entered, current)) {
        throw new Error('Nothing has changed from the current figures')
      }

      const counted = this.getOrdersForShift(input.shiftId).filter((order) => order.status !== 'voided')
      const totalFor = this.paidByMethod(counted.map((order) => order.local_id))
      const worked = workShiftFigures(entered, totalFor('cash'), totalFor('mpesa'), totalFor('card'))

      const correctedAt = new Date(this.nextRecordMs(input.shiftId, nowMs)).toISOString()
      const info = this.conn
        .prepare(
          `INSERT INTO shift_corrections (shift_id, corrected_by_staff_id, corrected_at, reason, starting_cash, ending_cash,
                                          expected_cash, discrepancy, mpesa_opening_balance, mpesa_closing_balance,
                                          mpesa_expected, mpesa_difference,
                                          card_closing_balance, card_expected, card_difference)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.shiftId,
          input.managerId,
          correctedAt,
          storedReason,
          entered.startingCash,
          entered.endingCash,
          worked.expectedCash,
          worked.discrepancy,
          entered.mpesaOpeningBalance,
          entered.mpesaClosingBalance,
          worked.mpesaExpected,
          worked.mpesaDifference,
          entered.cardClosingBalance ?? null,
          worked.cardExpected ?? null,
          worked.cardDifference ?? null
        )
      return {
        id: Number(info.lastInsertRowid),
        shift_id: input.shiftId,
        corrected_by_staff_id: input.managerId,
        corrected_at: correctedAt,
        reason: storedReason,
        starting_cash: entered.startingCash,
        ending_cash: entered.endingCash,
        expected_cash: worked.expectedCash,
        discrepancy: worked.discrepancy,
        mpesa_opening_balance: entered.mpesaOpeningBalance,
        mpesa_closing_balance: entered.mpesaClosingBalance,
        mpesa_expected: worked.mpesaExpected,
        mpesa_difference: worked.mpesaDifference,
        card_closing_balance: entered.cardClosingBalance ?? null,
        card_expected: worked.cardExpected ?? null,
        card_difference: worked.cardDifference ?? null
      }
    }).immediate()
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
      .prepare(
        'SELECT id, type, interface, enabled, width, connection_type FROM printers ORDER BY id ASC'
      )
      .all() as PrinterRow[]
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      interfaceName: row.interface,
      enabled: row.enabled === 1,
      width: row.width ?? undefined,
      connectionType: row.connection_type === 'windows' ? 'windows' : 'network'
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
        'INSERT INTO printers (id, type, interface, enabled, width, connection_type) VALUES (?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(id) DO UPDATE SET type = excluded.type, interface = excluded.interface, enabled = excluded.enabled, width = excluded.width, connection_type = excluded.connection_type'
      )
      .run(
        config.id,
        config.type,
        config.interfaceName,
        config.enabled ? 1 : 0,
        config.width ?? null,
        config.connectionType ?? 'network'
      )
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
   * @returns {QueuedOrder | null} `null` when another sale already used that payment
   */
  queueOrderClaimingSmsPayment(
    input: QueueOrderInput,
    claim: { transactionCode: string; staffId: number },
    payment?: RecordMpesaPaymentInput
  ): QueuedOrder | null {
    const claimStatement = this.conn.prepare(
      'UPDATE mpesa_sms_messages SET matched_order_local_id = ?, approved_by_staff_id = ?, approved_at = ? ' +
        'WHERE transaction_code = ? COLLATE NOCASE AND (matched_order_local_id IS NULL OR matched_order_local_id = ?)'
    )

    const run = this.conn.transaction(() => {
      const queued = this.queueOrder(input)
      // docs/phase-249: a repeat of a checkout that already made its order claims nothing and records nothing again.
      if (queued.existing) return queued
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
   * @returns {QueuedOrder}
   */
  queueOrderRecordingMpesaPayment(
    input: QueueOrderInput,
    payment: RecordMpesaPaymentInput
  ): QueuedOrder {
    const run = this.conn.transaction(() => {
      const queued = this.queueOrder(input)
      // docs/phase-249: the earlier order already has its payment row.
      if (!queued.existing) this.insertMpesaPayment(queued.localId, payment)
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
   * @returns {QueuedOrder | null} `null` when that code was already recorded
   */
  queueOrderRecordingManualPayment(
    input: QueueOrderInput,
    payment: RecordMpesaPaymentInput
  ): QueuedOrder | null {
    const run = this.conn.transaction(() => {
      const queued = this.queueOrder(input)
      // docs/phase-249: the earlier order already has its payment row, so its code is not "used again".
      if (queued.existing) return queued
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
   * Queues a split sale and records each of its M-Pesa payments, in one transaction (docs/phase-252). Each M-Pesa
   * payment is written exactly as the one-payment wrappers above write theirs: a message-based payment is claimed
   * first and the sale rolled back when it cannot be; a manual code already recorded rolls the sale back; a confirmed
   * Daraja payment's row is tolerated as a duplicate, as today. The sale's own payments, every one, are written by
   * {@link RubisDatabase.queueOrder} in the same transaction.
   *
   * @param {QueueOrderInput} input
   * @param {Array<{ payment: RecordMpesaPaymentInput; claim?: { transactionCode: string; staffId: number } }>} mpesa one per M-Pesa payment
   * @returns {QueuedOrder | null} `null` when one of the M-Pesa payments was already used, and nothing was written
   */
  queueOrderRecordingPayments(
    input: QueueOrderInput,
    mpesa: Array<{ payment: RecordMpesaPaymentInput; claim?: { transactionCode: string; staffId: number } }>
  ): QueuedOrder | null {
    const claimStatement = this.conn.prepare(
      'UPDATE mpesa_sms_messages SET matched_order_local_id = ?, approved_by_staff_id = ?, approved_at = ? ' +
        'WHERE transaction_code = ? COLLATE NOCASE AND (matched_order_local_id IS NULL OR matched_order_local_id = ?)'
    )
    const run = this.conn.transaction(() => {
      const queued = this.queueOrder(input)
      // docs/phase-249: a repeat of a checkout that already made its order claims and records nothing again.
      if (queued.existing) return queued
      for (const leg of mpesa) {
        if (leg.claim) {
          const info = claimStatement.run(queued.localId, leg.claim.staffId, new Date().toISOString(), leg.claim.transactionCode.trim(), queued.localId)
          if (info.changes === 0) throw new PaymentUnavailableError()
        }
        if (!this.insertMpesaPayment(queued.localId, leg.payment) && leg.payment.mode === 'manual') {
          throw new PaymentUnavailableError()
        }
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
   * Manual M-Pesa entries nobody has approved, whose sale belongs to a shift that began before this one (docs/phase-246):
   * the shift's carry-over. "Earlier" is by the shift's `clock_in`, the id breaking a tie, whatever time the sale itself
   * was made, and entries of this shift's own sales are not included (they are the shift's own). Voided sales are
   * included here and left out by the caller, as `getUnapprovedManualPaymentsBefore` leaves them.
   *
   * @param {number} shiftId
   * @returns {Array<MpesaPaymentRow & { status: OrderStatus }>}
   */
  getUnapprovedManualPaymentsOfEarlierShifts(shiftId: number): Array<MpesaPaymentRow & { status: OrderStatus }> {
    return this.conn
      .prepare(
        `SELECT mp.*, o.status as status FROM mpesa_payments mp
         JOIN orders o ON o.local_id = mp.order_local_id
         JOIN shifts s ON s.id = o.shift_id
         JOIN shifts me ON me.id = ?
         WHERE mp.mode = 'manual' AND mp.reconciled_at IS NULL AND s.id <> me.id
           AND (s.clock_in < me.clock_in OR (s.clock_in = me.clock_in AND s.id < me.id))
         ORDER BY o.created_at ASC`
      )
      .all(shiftId) as Array<MpesaPaymentRow & { status: OrderStatus }>
  }

  /**
   * The review made for one shift (docs/phase-246), if any.
   *
   * @param {number} shiftId
   * @returns {MpesaDayApprovalRow | undefined}
   */
  getShiftMpesaApproval(shiftId: number): MpesaDayApprovalRow | undefined {
    return this.conn.prepare('SELECT * FROM mpesa_day_approvals WHERE shift_id = ?').get(shiftId) as MpesaDayApprovalRow | undefined
  }

  /**
   * A manager's review of one shift's manual M-Pesa entries (docs/phase-246): the only way an entry is approved from
   * the Reports tab. One write transaction. The shift must exist, be closed and not merged into another, and must not
   * have been reviewed already: a second review is refused and writes nothing (the unique index on `shift_id` would
   * refuse it too). Every id given must be a still-pending manual entry of the shift's own sales or of its carry-over,
   * the entries of earlier shifts, as {@link getUnapprovedManualPaymentsOfEarlierShifts} computes them here: anything
   * else, a later shift's entry or a voided sale's, is refused. The writing itself is {@link approveMpesaEntries}, the
   * same code a day review used, so ticking, leaving an entry out with a reason, and the all-or-nothing rollback behave
   * as before. The caller has already verified the admin's PIN.
   *
   * @param {{ shiftId: number; approvedIds: number[]; excluded: Array<{ paymentId: number; reason: string | null }>; managerId: number; note: string | null }} input
   * @returns {ApproveMpesaEntriesResult}
   * @throws {Error} with a message fit to show the admin; nothing is written when it throws
   */
  approveShiftMpesa(input: {
    shiftId: number
    approvedIds: number[]
    excluded: Array<{ paymentId: number; reason: string | null }>
    managerId: number
    note: string | null
  }): ApproveMpesaEntriesResult {
    return this.conn.transaction((): ApproveMpesaEntriesResult => {
      const shift = this.getShiftById(input.shiftId)
      if (!shift) throw new Error(`Shift ${input.shiftId} not found`)
      if (shift.status !== 'closed') throw new Error(`Shift #${shift.id} is still open. Close it before approving its M-Pesa entries`)
      const merge = this.getShiftMerge(shift.id)
      if (merge) throw new Error(`Shift #${shift.id} was merged into shift #${merge.into_shift_id}. Approve that shift`)
      const done = this.getShiftMpesaApproval(shift.id)
      if (done) {
        const who = this.getStaffById(done.approved_by_staff_id)?.name ?? 'Unknown'
        throw new Error(`Shift #${shift.id} was already approved by ${who} on ${done.approved_at}`)
      }
      const pendingManual = (rows: Array<MpesaPaymentRow & { status: OrderStatus }>): number[] =>
        rows.filter((row) => row.mode === 'manual' && row.reconciled_at === null && row.status !== 'voided').map((row) => row.id)
      const allowed = new Set([
        ...pendingManual(this.getMpesaPaymentsForShift(shift.id)),
        ...pendingManual(this.getUnapprovedManualPaymentsOfEarlierShifts(shift.id))
      ])
      const given = [...input.approvedIds, ...input.excluded.map((entry) => entry.paymentId)]
      if (given.length === 0) throw new Error('No entries given to record')
      if (!given.every((id) => allowed.has(id))) {
        throw new Error("One or more entries are not pending manual entries of this shift or its carry-over. Refresh the report and try again")
      }
      return this.approveMpesaEntries(input.approvedIds, input.excluded, input.managerId, localDayOfIso(shift.clock_in), input.note, shift.id)
    }).immediate()
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
   * @param {number | null} [shiftId] — the shift this review is for (docs/phase-246); `null`, the default, is a review of a day
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
    note: string | null,
    shiftId: number | null = null
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
          'INSERT INTO mpesa_day_approvals (local_day, approved_by_staff_id, approved_at, entry_count, excluded_count, total_amount, note, shift_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          localDay,
          managerId,
          nowIso,
          uniqueApprovedIds.length,
          uniqueExcludedIds.length,
          totalAmount,
          note,
          shiftId
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
