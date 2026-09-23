/**
 * Stock take: physical count → Shopify inventory adjustment.
 *
 * ## The rule this file exists to obey
 *
 * **Shopify is the only source of truth for stock. There is never a
 * second ledger.** A stock take captures physical counts, proposes a
 * delta correction to Shopify, records what it did, and forgets.
 *
 * `stock_take_sessions` and `stock_take_items` are **history, not
 * stock**. They record what was counted, what Shopify claimed at the
 * time, and what was pushed. Not one of their columns is a live
 * quantity, and reading any of them as current stock is a bug — there
 * is a test (`tests/stockTakeGuard.test.ts`) that fails if any module
 * outside this service and its IPC handlers so much as names
 * `stock_take_items`. The live quantity lives at Shopify and nowhere
 * else; this app asks for it afresh every time it needs it.
 *
 * ## The arithmetic, which must not be gotten wrong
 *
 * ```
 *   delta              = counted − snapshot_at_open
 *   changeFromQuantity = fresh_read_at_commit
 * ```
 *
 * `delta = counted − fresh_read` is a blind set in disguise: it lands
 * Shopify exactly on the counted figure, erasing every sale made while
 * the shelf was being counted. The fresh read feeds the compare-and-swap
 * and the operator's preview, never the subtraction.
 *
 * ## Scope
 *
 * Subset-per-session, scan-driven. A `stock_take_items` row exists
 * because it was counted, so an item nobody scanned cannot be confused
 * with a shelf counted as empty. Whole-catalog stock take is a
 * deliberate future phase and is not implemented here.
 */

import type {
  CommitStockTakeSessionInput,
  CreateStockTakeSessionInput,
  RecordStockTakeCountInput,
  StockTakeItemOutcome,
  StockTakeItemRow,
  StockTakeOpeningLevel,
  StockTakeSessionRow,
  StockTakeStatus
} from './database.js'
import type { ServiceResult } from './shopify-types.js'
import type { InventoryLevelDetail } from './shopify.js'
import {
  batchChanges,
  buildStockTakeReferenceUri,
  type InventoryAdjustChange,
  type InventoryAdjustResult
} from './inventory-adjust.js'

/** `settings` key holding the variance threshold, in shillings. */
export const VARIANCE_THRESHOLD_SETTING_KEY = 'stock_take_variance_threshold'

/** `settings` key allowing the counter to also approve their own count. */
export const ALLOW_SELF_APPROVAL_SETTING_KEY = 'stock_take_allow_self_approval'

/** `settings` key holding how long a count stays committable, in hours. */
export const EXPIRY_HOURS_SETTING_KEY = 'stock_take_expiry_hours'

/**
 * Threshold used when none has been configured.
 *
 * Zero, deliberately: until a manager sets a real figure in Admin,
 * **every** count that moves any value at all needs a second approver.
 * The alternative — inventing a number here — would silently decide a
 * store's control policy on its behalf, and would fail in the unsafe
 * direction. Failing toward more approval is recoverable; failing
 * toward less is not.
 */
export const DEFAULT_VARIANCE_THRESHOLD_KES = 0

/**
 * How long a count stays committable, when none has been configured.
 *
 * Twelve hours stands in for "end of the trading day": a count that has
 * outlived the shift that took it has outlived its shelf, and the
 * snapshot it would compute against is no longer a description of
 * anything.
 */
export const DEFAULT_EXPIRY_HOURS = 12

/** Resolved stock-take policy, read from the `settings` table. */
export interface StockTakeSettings {
  /** Shillings of counted variance above which a second approver is required. */
  varianceThresholdKes: number
  /** When true, the counter may approve their own count. */
  allowSelfApproval: boolean
  /** Hours after `opened_at` beyond which a session may no longer be committed. */
  expiryHours: number
}

/** Structural slice of {@link RubisDatabase} this service depends on. */
export interface StockTakeDb {
  getSetting(key: string): string | undefined
  setSetting(key: string, value: string): void
  createStockTakeSession(input: CreateStockTakeSessionInput): { sessionId: number }
  getActiveStockTakeSession(): StockTakeSessionRow | undefined
  getStockTakeSession(sessionId: number): StockTakeSessionRow | undefined
  getStockTakeItems(sessionId: number): StockTakeItemRow[]
  recordStockTakeCount(input: RecordStockTakeCountInput): void
  removeStockTakeCount(sessionId: number, variantId: string): void
  setStockTakeStatus(sessionId: number, status: Exclude<StockTakeStatus, 'committed'>): void
  commitStockTakeSession(input: CommitStockTakeSessionInput): void
  getCachedVariantPrice(variantId: string): number | undefined
}

/** Reads this till's live location-scoped levels straight from Shopify. */
export type FetchLevelsFn = () => Promise<ServiceResult<Map<string, InventoryLevelDetail>>>

/** Pushes one batch of adjustments; injected so tests never hit the network. */
export type PushAdjustmentFn = (params: {
  sessionUuid: string
  batchIndex: number
  changes: InventoryAdjustChange[]
}) => Promise<ServiceResult<InventoryAdjustResult>>

/** Everything the stock-take operations need. All injected. */
export interface StockTakeDeps {
  db: StockTakeDb
  /**
   * The till's own confirmed location, read from the main-process
   * binding. Never a parameter from the renderer — a stock take that
   * could be pointed at another shop's location is how branch A adjusts
   * branch B.
   */
  locationId: string | undefined
  fetchLevels: FetchLevelsFn
  pushAdjustment: PushAdjustmentFn
  isOnline: () => boolean
  /** Generates the session uuid (`randomUUID` in production). */
  idGen: () => string
  /** Injectable clock for tests. */
  now?: () => Date
}

/** A session plus its counted rows, as returned to the renderer. */
export interface StockTakeSessionView {
  session: StockTakeSessionRow
  items: StockTakeItemRow[]
}

/** One line of the pre-commit preview. */
export interface StockTakePreviewLine {
  variantId: string
  variantLabel: string
  systemSnapshotQty: number
  countedQty: number
  /** `counted − snapshot`: what will actually be pushed. */
  delta: number
  /** Shopify's quantity as of the preview's fresh read. */
  freshQty: number | null
  /** `freshQty + delta` — what Shopify will read afterwards. */
  resultingQty: number | null
  /** Set when this line cannot be pushed, e.g. the variant is no longer stocked here. */
  blockedReason: string | null
}

/** The whole pre-commit preview an operator confirms against. */
export interface StockTakePreview {
  sessionId: number
  lines: StockTakePreviewLine[]
  /** Lines whose delta is zero — counted, agreed, nothing to push. */
  agreeingCount: number
  /** Total absolute units moving. */
  totalUnitsMoving: number
  /** Total absolute shillings moving, at price captured when counted. */
  totalValueMoving: number
  /** True when {@link StockTakeSettings.varianceThresholdKes} is exceeded. */
  requiresSecondApprover: boolean
  /** Hours since the opening snapshot was taken. */
  snapshotAgeHours: number
  /** Net drift between the opening snapshot and the fresh read — normal, not an error. */
  observedDrift: number
  /** Present when the snapshot is old enough to be worth saying out loud. */
  stalenessWarning: string | null
}

/** Outcome of a committed stock take. */
export interface StockTakeCommitSummary {
  sessionId: number
  referenceUri: string
  applied: number
  rejected: number
  skipped: number
}

/**
 * Reads the stock-take policy out of the `settings` table.
 *
 * @param {StockTakeDb} db
 * @returns {StockTakeSettings}
 */
export function resolveStockTakeSettings(db: StockTakeDb): StockTakeSettings {
  const threshold = Number(db.getSetting(VARIANCE_THRESHOLD_SETTING_KEY))
  const expiry = Number(db.getSetting(EXPIRY_HOURS_SETTING_KEY))
  return {
    varianceThresholdKes:
      Number.isFinite(threshold) && threshold >= 0 ? threshold : DEFAULT_VARIANCE_THRESHOLD_KES,
    allowSelfApproval: db.getSetting(ALLOW_SELF_APPROVAL_SETTING_KEY) === '1',
    expiryHours: Number.isFinite(expiry) && expiry > 0 ? expiry : DEFAULT_EXPIRY_HOURS
  }
}

/**
 * Persists the stock-take policy. Caller must already have verified an
 * admin Manager PIN.
 *
 * @param {StockTakeDb} db
 * @param {StockTakeSettings} settings
 */
export function saveStockTakeSettings(db: StockTakeDb, settings: StockTakeSettings): void {
  db.setSetting(VARIANCE_THRESHOLD_SETTING_KEY, String(settings.varianceThresholdKes))
  db.setSetting(ALLOW_SELF_APPROVAL_SETTING_KEY, settings.allowSelfApproval ? '1' : '')
  db.setSetting(EXPIRY_HOURS_SETTING_KEY, String(settings.expiryHours))
}

/**
 * Total shillings of stock a session would move, at the price captured
 * when each item was counted.
 *
 * Absolute: a session that adds 10 000/= of one item and removes
 * 10 000/= of another is moving 20 000/= of stock, not nothing.
 *
 * @param {StockTakeItemRow[]} items
 * @returns {number}
 */
export function computeVarianceValue(items: StockTakeItemRow[]): number {
  return items.reduce(
    (total, item) => total + Math.abs(item.variance) * item.unit_price_at_count,
    0
  )
}

/** Total absolute units a session would move. */
export function computeUnitsMoving(items: StockTakeItemRow[]): number {
  return items.reduce((total, item) => total + Math.abs(item.variance), 0)
}

/**
 * Hours elapsed since an ISO timestamp.
 *
 * @param {string} isoTimestamp
 * @param {Date} now
 * @returns {number}
 */
export function hoursSince(isoTimestamp: string, now: Date): number {
  const opened = new Date(isoTimestamp).getTime()
  if (!Number.isFinite(opened)) return 0
  return Math.max(0, (now.getTime() - opened) / 3_600_000)
}

/**
 * Checks the approval rules for a commit.
 *
 * Two independent gates:
 *
 *  - **Segregation of duties.** Whoever counted may not also be the
 *    manager who approves, unless a store has deliberately turned that
 *    off — a single-manager shift would otherwise be unable to close a
 *    count at all.
 *  - **Value threshold.** Above the configured shillings of movement a
 *    second, different approver is required, so no one person can move
 *    a large amount of stock alone.
 *
 * @param {object} params
 * @returns {ServiceResult<void>}
 */
export function evaluateApproval(params: {
  countedByStaffId: number
  approverStaffId: number
  secondApproverStaffId: number | null
  varianceValue: number
  settings: StockTakeSettings
}): ServiceResult<void> {
  const { countedByStaffId, approverStaffId, secondApproverStaffId, varianceValue, settings } =
    params

  if (!settings.allowSelfApproval && approverStaffId === countedByStaffId) {
    return {
      success: false,
      error:
        'The person who counted this stock cannot also approve it. Ask another manager to approve, or turn on self-approval in Admin > Stock Take.'
    }
  }

  if (varianceValue > settings.varianceThresholdKes) {
    if (secondApproverStaffId === null) {
      return {
        success: false,
        error: `This count moves ${varianceValue.toFixed(2)} of stock, over the ${settings.varianceThresholdKes.toFixed(2)} limit — a second manager must approve it.`
      }
    }
    if (secondApproverStaffId === approverStaffId) {
      return {
        success: false,
        error: 'The second approver must be a different manager from the first.'
      }
    }
    if (!settings.allowSelfApproval && secondApproverStaffId === countedByStaffId) {
      return {
        success: false,
        error: 'The person who counted this stock cannot be the second approver either.'
      }
    }
  }

  return { success: true }
}

/**
 * Opens a stock-take session against a fresh Shopify read.
 *
 * Online-only: the opening snapshot is the reference every delta is
 * computed against, so it has to be a real, timestamped Shopify
 * observation rather than anything this app already had lying around.
 *
 * @param {StockTakeDeps} deps
 * @param {number} countedByStaffId
 * @returns {Promise<ServiceResult<StockTakeSessionView>>}
 */
export async function openStockTake(
  deps: StockTakeDeps,
  countedByStaffId: number
): Promise<ServiceResult<StockTakeSessionView>> {
  const { db, locationId } = deps
  const now = deps.now ?? (() => new Date())

  if (!locationId) {
    return {
      success: false,
      error: 'This till has no confirmed Shopify location — set one in Admin before counting stock.'
    }
  }

  const existing = db.getActiveStockTakeSession()
  if (existing) {
    return {
      success: false,
      error: `Stock take #${existing.id} is still open. Finish or discard it before starting another.`
    }
  }

  if (!deps.isOnline()) {
    return {
      success: false,
      error:
        'A stock take has to start online so it can read the current Shopify figures. Counting afterwards works offline.'
    }
  }

  const levels = await deps.fetchLevels()
  if (!levels.success || !levels.data) {
    return { success: false, error: levels.error ?? 'Could not read current stock from Shopify' }
  }
  if (levels.data.size === 0) {
    return {
      success: false,
      error: 'Shopify returned no stocked items for this location — nothing to count against.'
    }
  }

  const openingLevels: Record<string, StockTakeOpeningLevel> = {}
  for (const [variantId, level] of levels.data) {
    openingLevels[variantId] = {
      inventoryItemId: level.inventoryItemId,
      systemSnapshotQty: level.available
    }
  }

  const { sessionId } = db.createStockTakeSession({
    sessionUuid: deps.idGen(),
    locationId,
    countedByStaffId,
    openedAt: now().toISOString(),
    openingLevels
  })

  const session = db.getStockTakeSession(sessionId)
  if (!session) {
    return { success: false, error: 'Stock take could not be opened' }
  }
  return { success: true, data: { session, items: [] } }
}

/**
 * Parses a session's frozen opening observation.
 *
 * @param {StockTakeSessionRow} session
 * @returns {Record<string, StockTakeOpeningLevel>}
 */
function parseOpeningLevels(
  session: StockTakeSessionRow
): Record<string, StockTakeOpeningLevel> {
  try {
    return JSON.parse(session.opening_levels_json) as Record<string, StockTakeOpeningLevel>
  } catch {
    return {}
  }
}

/** True while a session may still be counted into. */
function isCountable(status: StockTakeStatus): boolean {
  return status === 'open' || status === 'counting'
}

/**
 * Records one counted variant.
 *
 * Works offline: the snapshot it stamps the row with comes from the
 * session's own frozen opening observation, and the price from the
 * local catalog cache. Nothing here contacts Shopify.
 *
 * @param {StockTakeDeps} deps
 * @param {object} input
 * @returns {ServiceResult<StockTakeSessionView>}
 */
export function recordCount(
  deps: StockTakeDeps,
  input: { sessionId: number; variantId: string; variantLabel: string; countedQty: number }
): ServiceResult<StockTakeSessionView> {
  const { db } = deps
  const session = db.getStockTakeSession(input.sessionId)
  if (!session) {
    return { success: false, error: `Stock take ${input.sessionId} not found` }
  }
  if (!isCountable(session.status)) {
    return {
      success: false,
      error: `Stock take #${session.id} is ${session.status.replace('_', ' ')} and can no longer be counted into.`
    }
  }

  const opening = parseOpeningLevels(session)[input.variantId]
  if (!opening) {
    return {
      success: false,
      error:
        'That item was not stocked at this location when the count started, so there is nothing to correct. Start a new stock take to pick it up.'
    }
  }

  db.recordStockTakeCount({
    sessionId: session.id,
    variantId: input.variantId,
    inventoryItemId: opening.inventoryItemId,
    variantLabel: input.variantLabel,
    unitPriceAtCount: db.getCachedVariantPrice(input.variantId) ?? 0,
    systemSnapshotQty: opening.systemSnapshotQty,
    snapshotTakenAt: session.opened_at,
    countedQty: input.countedQty
  })

  return readSession(deps, session.id)
}

/**
 * Removes a mis-scanned row from a session still being counted.
 *
 * @param {StockTakeDeps} deps
 * @param {number} sessionId
 * @param {string} variantId
 * @returns {ServiceResult<StockTakeSessionView>}
 */
export function removeCount(
  deps: StockTakeDeps,
  sessionId: number,
  variantId: string
): ServiceResult<StockTakeSessionView> {
  const session = deps.db.getStockTakeSession(sessionId)
  if (!session) {
    return { success: false, error: `Stock take ${sessionId} not found` }
  }
  if (!isCountable(session.status)) {
    return { success: false, error: 'This stock take can no longer be edited.' }
  }
  deps.db.removeStockTakeCount(sessionId, variantId)
  return readSession(deps, sessionId)
}

/**
 * Reads a session and its counted rows.
 *
 * @param {StockTakeDeps} deps
 * @param {number} sessionId
 * @returns {ServiceResult<StockTakeSessionView>}
 */
export function readSession(
  deps: StockTakeDeps,
  sessionId: number
): ServiceResult<StockTakeSessionView> {
  const session = deps.db.getStockTakeSession(sessionId)
  if (!session) {
    return { success: false, error: `Stock take ${sessionId} not found` }
  }
  return { success: true, data: { session, items: deps.db.getStockTakeItems(sessionId) } }
}

/**
 * Submits a counted session for manager approval.
 *
 * @param {StockTakeDeps} deps
 * @param {number} sessionId
 * @returns {ServiceResult<StockTakeSessionView>}
 */
export function submitForApproval(
  deps: StockTakeDeps,
  sessionId: number
): ServiceResult<StockTakeSessionView> {
  const session = deps.db.getStockTakeSession(sessionId)
  if (!session) {
    return { success: false, error: `Stock take ${sessionId} not found` }
  }
  if (!isCountable(session.status)) {
    return { success: false, error: 'This stock take has already been submitted.' }
  }
  if (deps.db.getStockTakeItems(sessionId).length === 0) {
    return { success: false, error: 'Count at least one item before submitting for approval.' }
  }
  deps.db.setStockTakeStatus(sessionId, 'awaiting_approval')
  return readSession(deps, sessionId)
}

/**
 * Discards an uncommitted session.
 *
 * A committed session is never discarded — it is the record of a write
 * that actually happened.
 *
 * @param {StockTakeDeps} deps
 * @param {number} sessionId
 * @returns {ServiceResult<void>}
 */
export function abandonStockTake(deps: StockTakeDeps, sessionId: number): ServiceResult<void> {
  const session = deps.db.getStockTakeSession(sessionId)
  if (!session) {
    return { success: false, error: `Stock take ${sessionId} not found` }
  }
  if (session.status === 'committed') {
    return { success: false, error: 'A committed stock take cannot be discarded.' }
  }
  deps.db.setStockTakeStatus(sessionId, 'abandoned')
  return { success: true }
}

/**
 * Checks everything that must hold before a session may be pushed,
 * short of the approval identities (which only the commit call knows).
 *
 * @param {StockTakeDeps} deps
 * @param {StockTakeSessionRow} session
 * @param {StockTakeSettings} settings
 * @param {Date} now
 * @returns {ServiceResult<void>}
 */
export function checkCommitPreconditions(
  deps: StockTakeDeps,
  session: StockTakeSessionRow,
  settings: StockTakeSettings,
  now: Date
): ServiceResult<void> {
  if (session.status === 'committed') {
    return {
      success: false,
      error: `Stock take #${session.id} has already been pushed to Shopify. Start a new one to make further corrections.`
    }
  }
  if (session.status === 'abandoned') {
    return { success: false, error: `Stock take #${session.id} was discarded.` }
  }
  if (session.status !== 'awaiting_approval') {
    return { success: false, error: 'Submit this stock take for approval before pushing it.' }
  }
  if (!deps.locationId) {
    return {
      success: false,
      error: 'This till has no confirmed Shopify location — nothing can be pushed.'
    }
  }
  if (session.location_id !== deps.locationId) {
    return {
      success: false,
      error:
        'This count was taken against a different Shopify location than the till is now set to. It cannot be pushed — start a new count.'
    }
  }
  if (hoursSince(session.opened_at, now) > settings.expiryHours) {
    return {
      success: false,
      error: `This count was started more than ${settings.expiryHours} hours ago and is too old to push safely. Discard it and count again.`
    }
  }
  return { success: true }
}

/**
 * Builds the pre-commit preview: a fresh Shopify read, what each line
 * will do to it, and the totals the approver is signing off.
 *
 * Online-only, and the fresh read doing its job *is* the connectivity
 * gate — `isOnline()` above it only buys a clearer message than a
 * timeout would give.
 *
 * @param {StockTakeDeps} deps
 * @param {number} sessionId
 * @returns {Promise<ServiceResult<StockTakePreview>>}
 */
export async function previewCommit(
  deps: StockTakeDeps,
  sessionId: number
): Promise<ServiceResult<StockTakePreview>> {
  const { db } = deps
  const now = deps.now ?? (() => new Date())
  const settings = resolveStockTakeSettings(db)

  const session = db.getStockTakeSession(sessionId)
  if (!session) {
    return { success: false, error: `Stock take ${sessionId} not found` }
  }

  const precondition = checkCommitPreconditions(deps, session, settings, now())
  if (!precondition.success) {
    return { success: false, error: precondition.error }
  }

  if (!deps.isOnline()) {
    return {
      success: false,
      error:
        'A stock take can only be pushed online — it has to re-read the current Shopify figures first. Counting works offline; this step does not.'
    }
  }

  const levels = await deps.fetchLevels()
  if (!levels.success || !levels.data) {
    return { success: false, error: levels.error ?? 'Could not re-read current stock from Shopify' }
  }

  const items = db.getStockTakeItems(sessionId)
  const lines: StockTakePreviewLine[] = items.map((item) => {
    const fresh = levels.data?.get(item.variant_id)
    const delta = item.variance
    return {
      variantId: item.variant_id,
      variantLabel: item.variant_label,
      systemSnapshotQty: item.system_snapshot_qty,
      countedQty: item.counted_qty,
      delta,
      freshQty: fresh?.available ?? null,
      resultingQty: fresh ? fresh.available + delta : null,
      blockedReason: fresh
        ? null
        : 'No longer stocked at this location in Shopify — this line cannot be pushed.'
    }
  })

  const varianceValue = computeVarianceValue(items)
  const snapshotAgeHours = hoursSince(session.opened_at, now())
  const observedDrift = items.reduce((total, item) => {
    const fresh = levels.data?.get(item.variant_id)
    return fresh ? total + (fresh.available - item.system_snapshot_qty) : total
  }, 0)

  return {
    success: true,
    data: {
      sessionId,
      lines,
      agreeingCount: lines.filter((line) => line.delta === 0).length,
      totalUnitsMoving: computeUnitsMoving(items),
      totalValueMoving: varianceValue,
      requiresSecondApprover: varianceValue > settings.varianceThresholdKes,
      snapshotAgeHours,
      observedDrift,
      stalenessWarning: buildStalenessWarning(snapshotAgeHours, observedDrift)
    }
  }
}

/**
 * Wording for the always-on staleness notice.
 *
 * Drift is reported plainly rather than as an error: Shopify having
 * moved since the snapshot means the till sold during the count, which
 * is exactly the situation delta-adjustment exists to handle.
 *
 * @param {number} ageHours
 * @param {number} drift
 * @returns {string | null}
 */
export function buildStalenessWarning(ageHours: number, drift: number): string | null {
  if (ageHours < 1 && drift === 0) return null
  const age = `This count was started ${ageHours < 1 ? 'under an hour' : `${Math.round(ageHours)} hour${Math.round(ageHours) === 1 ? '' : 's'}`} ago.`
  if (drift === 0) return `${age} Shopify's figures have not moved since.`
  return `${age} Shopify's figures have moved by ${drift > 0 ? '+' : ''}${drift} since — normally because the till kept selling. Those sales are preserved.`
}

/**
 * Pushes an approved stock take to Shopify.
 *
 * The ordering matters and is not arbitrary:
 *
 *  1. every precondition and approval rule, before anything is sent;
 *  2. a fresh location-scoped read, which is both the compare-and-swap
 *     input and the proof we are actually online;
 *  3. the changes, batched, each batch idempotency-keyed;
 *  4. the outcome recorded against the session, closing it.
 *
 * **Failure handling turns on whether anything was applied.** If no
 * change landed, the session stays open for a deliberate manual retry —
 * there is nothing to double-apply. If some batch did land, the session
 * is closed as committed with per-item outcomes, because re-running a
 * partly-applied session is precisely the double-apply hazard the whole
 * design exists to prevent. Rejected lines are re-counted in a **new**
 * session.
 *
 * Nothing here is ever queued to `sync_queue`. A queued delta is an
 * arithmetic claim about a Shopify quantity observed at a moment that
 * has since passed; the longer it waits the more wrong it gets.
 *
 * @param {StockTakeDeps} deps
 * @param {object} input
 * @returns {Promise<ServiceResult<StockTakeCommitSummary>>}
 */
export async function commitStockTake(
  deps: StockTakeDeps,
  input: {
    sessionId: number
    approverStaffId: number
    secondApproverStaffId: number | null
  }
): Promise<ServiceResult<StockTakeCommitSummary>> {
  const { db } = deps
  const now = deps.now ?? (() => new Date())
  const settings = resolveStockTakeSettings(db)

  const session = db.getStockTakeSession(input.sessionId)
  if (!session) {
    return { success: false, error: `Stock take ${input.sessionId} not found` }
  }

  const precondition = checkCommitPreconditions(deps, session, settings, now())
  if (!precondition.success) {
    return { success: false, error: precondition.error }
  }

  const items = db.getStockTakeItems(session.id)
  if (items.length === 0) {
    return { success: false, error: 'This stock take has no counted items.' }
  }

  const approval = evaluateApproval({
    countedByStaffId: session.counted_by_staff_id,
    approverStaffId: input.approverStaffId,
    secondApproverStaffId: input.secondApproverStaffId,
    varianceValue: computeVarianceValue(items),
    settings
  })
  if (!approval.success) {
    return { success: false, error: approval.error }
  }

  if (!deps.isOnline()) {
    return {
      success: false,
      error:
        'A stock take can only be pushed online — it has to re-read the current Shopify figures first. Nothing was changed.'
    }
  }

  const levels = await deps.fetchLevels()
  if (!levels.success || !levels.data) {
    return {
      success: false,
      error: `${levels.error ?? 'Could not re-read current stock from Shopify'} Nothing was changed.`
    }
  }
  const freshLevels = levels.data

  const outcomes = new Map<string, StockTakeItemOutcome>()
  const changes: InventoryAdjustChange[] = []
  const changeVariantIds: string[] = []

  for (const item of items) {
    const fresh = freshLevels.get(item.variant_id)
    if (!fresh) {
      outcomes.set(item.variant_id, {
        variantId: item.variant_id,
        freshQtyAtCommit: null,
        deltaPushed: null,
        commitStatus: 'rejected',
        commitError: 'No longer stocked at this location in Shopify'
      })
      continue
    }
    if (item.variance === 0) {
      outcomes.set(item.variant_id, {
        variantId: item.variant_id,
        freshQtyAtCommit: fresh.available,
        deltaPushed: 0,
        commitStatus: 'skipped',
        commitError: null
      })
      continue
    }
    changes.push({
      inventoryItemId: item.inventory_item_id,
      delta: item.variance,
      changeFromQuantity: fresh.available
    })
    changeVariantIds.push(item.variant_id)
    outcomes.set(item.variant_id, {
      variantId: item.variant_id,
      freshQtyAtCommit: fresh.available,
      deltaPushed: item.variance,
      commitStatus: 'rejected',
      commitError: 'Not sent'
    })
  }

  if (changes.length === 0) {
    return {
      success: false,
      error:
        'Every counted item already agrees with Shopify, or is no longer stocked here — there is nothing to push.'
    }
  }

  const batches = batchChanges(changes)
  const responses: unknown[] = []
  let firstError: string | null = null
  let appliedCount = 0
  let sentSoFar = 0

  for (const [batchIndex, batch] of batches.entries()) {
    const variantIds = changeVariantIds.slice(sentSoFar, sentSoFar + batch.length)
    sentSoFar += batch.length

    const pushed = await deps.pushAdjustment({
      sessionUuid: session.session_uuid,
      batchIndex,
      changes: batch
    })
    responses.push(pushed.success ? pushed.data?.rawResponse : { error: pushed.error })

    for (const variantId of variantIds) {
      const outcome = outcomes.get(variantId)
      if (!outcome) continue
      if (pushed.success) {
        outcome.commitStatus = 'applied'
        outcome.commitError = null
        appliedCount += 1
      } else {
        outcome.commitError = pushed.error ?? 'Shopify rejected this adjustment'
      }
    }

    if (!pushed.success) {
      firstError = pushed.error ?? 'Shopify rejected the stock take'
      break
    }
  }

  // Nothing landed: leave the session open so a manager can retry
  // deliberately. There is no double-apply risk because Shopify's
  // quantities are exactly as they were.
  if (appliedCount === 0) {
    return { success: false, error: firstError ?? 'Shopify applied no inventory adjustment' }
  }

  const referenceUri = buildStockTakeReferenceUri(session.session_uuid)
  const recorded = [...outcomes.values()]

  try {
    db.commitStockTakeSession({
      sessionId: session.id,
      committedAt: now().toISOString(),
      committedReferenceUri: referenceUri,
      approvedByStaffId: input.approverStaffId,
      secondApproverStaffId: input.secondApproverStaffId,
      shopifyResponseJson: JSON.stringify(responses),
      outcomes: recorded
    })
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to record the stock take result'
    }
  }

  const summary: StockTakeCommitSummary = {
    sessionId: session.id,
    referenceUri,
    applied: recorded.filter((o) => o.commitStatus === 'applied').length,
    rejected: recorded.filter((o) => o.commitStatus === 'rejected').length,
    skipped: recorded.filter((o) => o.commitStatus === 'skipped').length
  }

  if (firstError) {
    return {
      success: false,
      error: `Part of this stock take was pushed before Shopify rejected the rest (${summary.applied} applied, ${summary.rejected} not). The applied changes stand and this count is closed — re-count the rejected items in a new stock take. Shopify said: ${firstError}`
    }
  }

  return { success: true, data: summary }
}
