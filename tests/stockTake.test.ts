/**
 * Stock-take tests.
 *
 * Run against a **real** in-memory SQLite database rather than a
 * recording fake: this is the one feature that writes to the source of
 * truth, and the `UNIQUE` constraints and transactions are part of the
 * safety argument, so they have to actually execute.
 *
 * Shopify is faked at the two injected seams (`fetchLevels`,
 * `pushAdjustment`) so the tests can drive the exact race the delta
 * arithmetic exists to survive — a sale landing between the count and
 * the commit.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { RubisDatabase } from '../src/main/services/database.js'
import { hashPin } from '../src/main/services/auth.js'
import type { InventoryLevelDetail } from '../src/main/services/shopify.js'
import {
  ALLOW_SELF_APPROVAL_SETTING_KEY,
  DEFAULT_EXPIRY_HOURS,
  EXPIRY_HOURS_SETTING_KEY,
  VARIANCE_THRESHOLD_SETTING_KEY,
  abandonStockTake,
  commitStockTake,
  computeVarianceValue,
  evaluateApproval,
  openStockTake,
  previewCommit,
  recordCount,
  resolveStockTakeSettings,
  submitForApproval,
  type StockTakeDeps
} from '../src/main/services/stock-take.js'
import {
  buildIdempotencyKey,
  buildInventoryAdjustInput,
  buildStockTakeReferenceUri,
  STOCK_TAKE_REASON,
  type InventoryAdjustChange
} from '../src/main/services/inventory-adjust.js'

const LOCATION = 'gid://shopify/Location/1'
const OTHER_LOCATION = 'gid://shopify/Location/999'
const VARIANT_A = 'gid://shopify/ProductVariant/11'
const VARIANT_B = 'gid://shopify/ProductVariant/22'
const ITEM_A = 'gid://shopify/InventoryItem/11'
const ITEM_B = 'gid://shopify/InventoryItem/22'

/** Hashed once — `hashPin` is deliberately slow, and every test seeds three staff. */
const PIN_HASHES = [hashPin('1111'), hashPin('2222'), hashPin('3333')]

const levels = (
  entries: Array<[string, string, number]>
): Map<string, InventoryLevelDetail> =>
  new Map(entries.map(([variantId, inventoryItemId, available]) => [
    variantId,
    { inventoryItemId, available }
  ]))

interface Harness {
  db: RubisDatabase
  deps: StockTakeDeps
  /** What the next `fetchLevels` call resolves to. */
  setLevels: (next: Map<string, InventoryLevelDetail>) => void
  /** Every batch `pushAdjustment` was called with. */
  pushes: Array<{ sessionUuid: string; batchIndex: number; changes: InventoryAdjustChange[] }>
  /** Makes the next push fail with this message. */
  failNextPush: (error: string) => void
  setNow: (iso: string) => void
}

function harness(overrides: Partial<StockTakeDeps> = {}): Harness {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()

  db.createStaff({ name: 'Cashier Ann', pinHash: PIN_HASHES[0], role: 'cashier' })
  db.createStaff({ name: 'Manager Bob', pinHash: PIN_HASHES[1], role: 'admin' })
  db.createStaff({ name: 'Manager Cara', pinHash: PIN_HASHES[2], role: 'admin' })

  let current = levels([
    [VARIANT_A, ITEM_A, 10],
    [VARIANT_B, ITEM_B, 5]
  ])
  let nextPushError: string | null = null
  let now = '2026-09-23T09:00:00.000Z'
  const pushes: Harness['pushes'] = []
  let uuidCounter = 0

  const deps: StockTakeDeps = {
    db,
    locationId: LOCATION,
    fetchLevels: async () => ({ success: true, data: current }),
    pushAdjustment: async (params) => {
      pushes.push(params)
      if (nextPushError) {
        const error = nextPushError
        nextPushError = null
        return { success: false, error }
      }
      return {
        success: true,
        data: { createdAt: now, referenceDocumentUri: null, rawResponse: { ok: true } }
      }
    },
    isOnline: () => true,
    idGen: () => `session-uuid-${++uuidCounter}`,
    now: () => new Date(now),
    ...overrides
  }

  return {
    db,
    deps,
    setLevels: (next) => {
      current = next
    },
    pushes,
    failNextPush: (error) => {
      nextPushError = error
    },
    setNow: (iso) => {
      now = iso
    }
  }
}

/** Opens a session, counts the given variants, and submits for approval. */
async function countedSession(
  h: Harness,
  counts: Array<[string, number]>,
  counterStaffId = 1
): Promise<number> {
  const opened = await openStockTake(h.deps, counterStaffId)
  expect(opened.success).toBe(true)
  const sessionId = opened.data!.session.id
  for (const [variantId, countedQty] of counts) {
    const recorded = recordCount(h.deps, {
      sessionId,
      variantId,
      variantLabel: variantId,
      countedQty
    })
    expect(recorded.success).toBe(true)
  }
  expect(submitForApproval(h.deps, sessionId).success).toBe(true)
  return sessionId
}

describe('stock take — the delta arithmetic', () => {
  let h: Harness

  beforeEach(() => {
    h = harness()
  })

  /**
   * The single most important property of the feature. Shopify says 10,
   * the shelf holds 8, and two units sell while the count is being
   * reviewed. The correction must leave Shopify on 6 — the counted 8
   * minus the 2 that were sold — NOT on 8, which is what an absolute
   * set (or a delta computed against the fresh read) would produce.
   */
  it('pushes counted − snapshot, so sales made during the count survive', async () => {
    const sessionId = await countedSession(h, [[VARIANT_A, 8]])

    // Two units sell between the count and the commit.
    h.setLevels(levels([[VARIANT_A, ITEM_A, 8], [VARIANT_B, ITEM_B, 5]]))

    const result = await commitStockTake(h.deps, {
      sessionId,
      approverStaffId: 2,
      secondApproverStaffId: 3
    })

    expect(result.success).toBe(true)
    expect(h.pushes).toHaveLength(1)
    const [change] = h.pushes[0].changes
    expect(change.delta).toBe(-2)
    expect(change.changeFromQuantity).toBe(8)

    // What Shopify ends up holding: fresh + delta.
    expect(change.changeFromQuantity + change.delta).toBe(6)

    // The wrong arithmetic (counted − fresh) would have been 0, leaving
    // Shopify on 8 and resurrecting both sold units.
    expect(change.delta).not.toBe(8 - 8)
  })

  it('records the snapshot, the fresh read and the pushed delta separately for audit', async () => {
    const sessionId = await countedSession(h, [[VARIANT_A, 8]])
    h.setLevels(levels([[VARIANT_A, ITEM_A, 7], [VARIANT_B, ITEM_B, 5]]))

    await commitStockTake(h.deps, { sessionId, approverStaffId: 2, secondApproverStaffId: 3 })

    const [item] = h.db.getStockTakeItems(sessionId)
    expect(item.system_snapshot_qty).toBe(10)
    expect(item.counted_qty).toBe(8)
    expect(item.variance).toBe(-2)
    expect(item.fresh_qty_at_commit).toBe(7)
    expect(item.delta_pushed).toBe(-2)
    expect(item.commit_status).toBe('applied')
  })

  it('skips an item that already agrees with Shopify instead of pushing a zero delta', async () => {
    const sessionId = await countedSession(h, [
      [VARIANT_A, 10],
      [VARIANT_B, 4]
    ])

    const result = await commitStockTake(h.deps, {
      sessionId,
      approverStaffId: 2,
      secondApproverStaffId: 3
    })

    expect(result.success).toBe(true)
    expect(result.data?.applied).toBe(1)
    expect(result.data?.skipped).toBe(1)
    expect(h.pushes[0].changes).toHaveLength(1)

    const agreeing = h.db.getStockTakeItems(sessionId).find((i) => i.variant_id === VARIANT_A)
    expect(agreeing?.commit_status).toBe('skipped')
    expect(agreeing?.delta_pushed).toBe(0)
  })
})

describe('stock take — compare-and-swap', () => {
  it('sends the freshly re-read quantity as changeFromQuantity, not the snapshot', async () => {
    const h = harness()
    const sessionId = await countedSession(h, [[VARIANT_A, 12]])
    h.setLevels(levels([[VARIANT_A, ITEM_A, 9], [VARIANT_B, ITEM_B, 5]]))

    await commitStockTake(h.deps, { sessionId, approverStaffId: 2, secondApproverStaffId: 3 })

    expect(h.pushes[0].changes[0]).toEqual({
      inventoryItemId: ITEM_A,
      delta: 2,
      changeFromQuantity: 9
    })
  })

  /**
   * A compare-and-swap rejection is Shopify telling us it moved between
   * our read and the mutation. It must surface as a failure with the
   * session left open — never be retried with the check relaxed.
   */
  it('surfaces a rejected compare-and-swap and leaves the session open', async () => {
    const h = harness()
    const sessionId = await countedSession(h, [[VARIANT_A, 12]])
    h.failNextPush('changes.0.changeFromQuantity: quantity has changed')

    const result = await commitStockTake(h.deps, {
      sessionId,
      approverStaffId: 2,
      secondApproverStaffId: 3
    })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/changeFromQuantity/)

    const session = h.db.getStockTakeSession(sessionId)
    expect(session?.status).toBe('awaiting_approval')
    expect(session?.committed_reference_uri).toBeNull()
  })

  it('rejects a line Shopify no longer stocks here rather than inventing one', async () => {
    const h = harness()
    const sessionId = await countedSession(h, [
      [VARIANT_A, 12],
      [VARIANT_B, 7]
    ])
    h.setLevels(levels([[VARIANT_A, ITEM_A, 10]]))

    const result = await commitStockTake(h.deps, {
      sessionId,
      approverStaffId: 2,
      secondApproverStaffId: 3
    })

    expect(result.success).toBe(true)
    expect(h.pushes[0].changes).toHaveLength(1)
    const dropped = h.db.getStockTakeItems(sessionId).find((i) => i.variant_id === VARIANT_B)
    expect(dropped?.commit_status).toBe('rejected')
    expect(dropped?.delta_pushed).toBeNull()
  })
})

describe('stock take — idempotency', () => {
  it('refuses a second commit of the same session, long after Shopify would forget the key', async () => {
    const h = harness()
    const sessionId = await countedSession(h, [[VARIANT_A, 8]])

    const first = await commitStockTake(h.deps, {
      sessionId,
      approverStaffId: 2,
      secondApproverStaffId: 3
    })
    expect(first.success).toBe(true)
    expect(h.pushes).toHaveLength(1)

    // Well past Shopify's 24-hour idempotency-key window.
    h.setNow('2026-09-30T09:00:00.000Z')

    const second = await commitStockTake(h.deps, {
      sessionId,
      approverStaffId: 2,
      secondApproverStaffId: 3
    })

    expect(second.success).toBe(false)
    expect(second.error).toMatch(/already been pushed/i)
    expect(h.pushes).toHaveLength(1)
  })

  it('writes the reference uri exactly once, enforced by the database', async () => {
    const h = harness()
    const sessionId = await countedSession(h, [[VARIANT_A, 8]])
    await commitStockTake(h.deps, { sessionId, approverStaffId: 2, secondApproverStaffId: 3 })

    const session = h.db.getStockTakeSession(sessionId)
    expect(session?.committed_reference_uri).toBe(
      buildStockTakeReferenceUri(session!.session_uuid)
    )

    expect(() =>
      h.db.commitStockTakeSession({
        sessionId,
        committedAt: '2026-09-24T09:00:00.000Z',
        committedReferenceUri: session!.committed_reference_uri!,
        approvedByStaffId: 2,
        secondApproverStaffId: null,
        shopifyResponseJson: '[]',
        outcomes: []
      })
    ).toThrow(/already been committed/i)
  })

  it('derives a distinct idempotency key per batch of one session', () => {
    expect(buildIdempotencyKey('abc', 0)).toBe('abc:0')
    expect(buildIdempotencyKey('abc', 1)).toBe('abc:1')
    expect(buildIdempotencyKey('abc', 0)).not.toBe(buildIdempotencyKey('abc', 1))
  })
})

describe('stock take — offline', () => {
  it('counts offline but refuses to push, and queues nothing', async () => {
    let online = true
    const h = harness({ isOnline: () => online })

    const opened = await openStockTake(h.deps, 1)
    const sessionId = opened.data!.session.id

    online = false
    const counted = recordCount(h.deps, {
      sessionId,
      variantId: VARIANT_A,
      variantLabel: 'A',
      countedQty: 8
    })
    expect(counted.success).toBe(true)
    expect(submitForApproval(h.deps, sessionId).success).toBe(true)

    const result = await commitStockTake(h.deps, {
      sessionId,
      approverStaffId: 2,
      secondApproverStaffId: 3
    })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/only be pushed online/i)
    expect(h.pushes).toHaveLength(0)
    expect(h.db.getPendingSyncQueue(Date.now() + 1)).toHaveLength(0)
    expect(h.db.getStockTakeSession(sessionId)?.status).toBe('awaiting_approval')
  })

  it('refuses to open a session offline, since the snapshot must be a real Shopify read', async () => {
    const h = harness({ isOnline: () => false })
    const result = await openStockTake(h.deps, 1)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/start online/i)
  })

  it('creates no sync_queue entry on a successful commit either', async () => {
    const h = harness()
    const sessionId = await countedSession(h, [[VARIANT_A, 8]])
    await commitStockTake(h.deps, { sessionId, approverStaffId: 2, secondApproverStaffId: 3 })
    expect(h.db.getPendingSyncQueue(Date.now() + 1)).toHaveLength(0)
  })
})

describe('stock take — approval rules', () => {
  const settings = {
    varianceThresholdKes: 1000,
    allowSelfApproval: false,
    expiryHours: 12
  }

  it('blocks the counter from approving their own count', () => {
    const result = evaluateApproval({
      countedByStaffId: 2,
      approverStaffId: 2,
      secondApproverStaffId: null,
      varianceValue: 10,
      settings
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/cannot also approve/i)
  })

  it('allows self-approval when the override is on', () => {
    const result = evaluateApproval({
      countedByStaffId: 2,
      approverStaffId: 2,
      secondApproverStaffId: null,
      varianceValue: 10,
      settings: { ...settings, allowSelfApproval: true }
    })
    expect(result.success).toBe(true)
  })

  it('requires a second approver above the value threshold', () => {
    const result = evaluateApproval({
      countedByStaffId: 1,
      approverStaffId: 2,
      secondApproverStaffId: null,
      varianceValue: 1001,
      settings
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/second manager/i)
  })

  it('accepts a different second approver above the threshold', () => {
    const result = evaluateApproval({
      countedByStaffId: 1,
      approverStaffId: 2,
      secondApproverStaffId: 3,
      varianceValue: 1001,
      settings
    })
    expect(result.success).toBe(true)
  })

  it('rejects the same person as both approvers', () => {
    const result = evaluateApproval({
      countedByStaffId: 1,
      approverStaffId: 2,
      secondApproverStaffId: 2,
      varianceValue: 1001,
      settings
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/different manager/i)
  })

  it('values a variance in shillings at the price captured when counted', async () => {
    const h = harness()
    h.db.cacheProducts([
      {
        id: 'gid://shopify/Product/1',
        title: 'Mug',
        handle: 'mug',
        featuredImage: null,
        variants: [
          {
            id: VARIANT_A,
            productId: '1',
            title: 'Default',
            price: 250,
            availableForSale: true,
            inventoryQuantity: 10,
            image: null,
            barcode: null
          }
        ]
      }
    ])
    const sessionId = await countedSession(h, [[VARIANT_A, 6]])
    // 4 units short at 250 each.
    expect(computeVarianceValue(h.db.getStockTakeItems(sessionId))).toBe(1000)
  })

  it('defaults to a zero threshold, so an unconfigured store always needs two approvers', () => {
    const h = harness()
    const resolved = resolveStockTakeSettings(h.db)
    expect(resolved.varianceThresholdKes).toBe(0)
    expect(resolved.allowSelfApproval).toBe(false)
    expect(resolved.expiryHours).toBe(DEFAULT_EXPIRY_HOURS)
  })

  it('enforces both rules end to end at commit', async () => {
    const h = harness()
    h.db.setSetting(VARIANCE_THRESHOLD_SETTING_KEY, '1000000')
    const sessionId = await countedSession(h, [[VARIANT_A, 8]], 2)

    const selfApproved = await commitStockTake(h.deps, {
      sessionId,
      approverStaffId: 2,
      secondApproverStaffId: null
    })
    expect(selfApproved.success).toBe(false)
    expect(h.pushes).toHaveLength(0)

    h.db.setSetting(ALLOW_SELF_APPROVAL_SETTING_KEY, '1')
    const relaxed = await commitStockTake(h.deps, {
      sessionId,
      approverStaffId: 2,
      secondApproverStaffId: null
    })
    expect(relaxed.success).toBe(true)
  })
})

describe('stock take — location', () => {
  it('refuses a session taken against a different location than the till now uses', async () => {
    const h = harness()
    const sessionId = await countedSession(h, [[VARIANT_A, 8]])

    const movedTill: StockTakeDeps = { ...h.deps, locationId: OTHER_LOCATION }
    const result = await commitStockTake(movedTill, {
      sessionId,
      approverStaffId: 2,
      secondApproverStaffId: 3
    })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/different Shopify location/i)
    expect(h.pushes).toHaveLength(0)
  })

  it('stamps the session with the till’s own location, taken from main', async () => {
    const h = harness()
    const opened = await openStockTake(h.deps, 1)
    expect(opened.data?.session.location_id).toBe(LOCATION)
  })

  it('refuses to open when the till has no confirmed location', async () => {
    const h = harness({ locationId: undefined })
    const result = await openStockTake(h.deps, 1)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/no confirmed Shopify location/i)
  })

  /**
   * The strongest guarantee is structural, not behavioural: the commit
   * schema has no `locationId` field at all, so there is nothing for a
   * caller to supply.
   */
  it('has no locationId anywhere in the commit payload contract', async () => {
    const { stockTakeCommitSchema, stockTakeOpenSchema } = await import(
      '../src/main/lib/ipcValidator.js'
    )
    expect(Object.keys(stockTakeCommitSchema.shape)).not.toContain('locationId')
    expect(Object.keys(stockTakeOpenSchema.shape)).not.toContain('locationId')
  })
})

describe('stock take — expiry and staleness', () => {
  it('refuses a count older than the configured expiry', async () => {
    const h = harness()
    h.db.setSetting(EXPIRY_HOURS_SETTING_KEY, '6')
    const sessionId = await countedSession(h, [[VARIANT_A, 8]])

    h.setNow('2026-09-23T16:01:00.000Z')
    const result = await commitStockTake(h.deps, {
      sessionId,
      approverStaffId: 2,
      secondApproverStaffId: 3
    })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/too old to push/i)
    expect(h.pushes).toHaveLength(0)
  })

  it('always reports snapshot age and observed drift in the preview', async () => {
    const h = harness()
    const sessionId = await countedSession(h, [[VARIANT_A, 8]])
    h.setNow('2026-09-23T12:00:00.000Z')
    h.setLevels(levels([[VARIANT_A, ITEM_A, 7], [VARIANT_B, ITEM_B, 5]]))

    const preview = await previewCommit(h.deps, sessionId)

    expect(preview.success).toBe(true)
    expect(preview.data?.snapshotAgeHours).toBeCloseTo(3, 5)
    expect(preview.data?.observedDrift).toBe(-3)
    expect(preview.data?.stalenessWarning).toMatch(/kept selling/i)
  })

  it('shows the resulting Shopify figure per line, not the counted one', async () => {
    const h = harness()
    const sessionId = await countedSession(h, [[VARIANT_A, 8]])
    h.setLevels(levels([[VARIANT_A, ITEM_A, 7], [VARIANT_B, ITEM_B, 5]]))

    const preview = await previewCommit(h.deps, sessionId)
    const [line] = preview.data!.lines

    expect(line.countedQty).toBe(8)
    expect(line.freshQty).toBe(7)
    expect(line.delta).toBe(-2)
    expect(line.resultingQty).toBe(5)
  })
})

describe('stock take — session lifecycle', () => {
  it('allows only one active session at a time', async () => {
    const h = harness()
    await openStockTake(h.deps, 1)
    const second = await openStockTake(h.deps, 1)
    expect(second.success).toBe(false)
    expect(second.error).toMatch(/still open/i)
  })

  it('treats a recount of the same variant as a correction, not a second row', async () => {
    const h = harness()
    const opened = await openStockTake(h.deps, 1)
    const sessionId = opened.data!.session.id

    recordCount(h.deps, { sessionId, variantId: VARIANT_A, variantLabel: 'A', countedQty: 8 })
    const after = recordCount(h.deps, {
      sessionId,
      variantId: VARIANT_A,
      variantLabel: 'A',
      countedQty: 9
    })

    expect(after.data?.items).toHaveLength(1)
    expect(after.data?.items[0].counted_qty).toBe(9)
    expect(after.data?.items[0].variance).toBe(-1)
  })

  it('refuses a variant that was not stocked here when the count started', async () => {
    const h = harness()
    const opened = await openStockTake(h.deps, 1)
    const result = recordCount(h.deps, {
      sessionId: opened.data!.session.id,
      variantId: 'gid://shopify/ProductVariant/404',
      variantLabel: 'Ghost',
      countedQty: 1
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not stocked at this location/i)
  })

  it('refuses to count into a session that has been submitted', async () => {
    const h = harness()
    const sessionId = await countedSession(h, [[VARIANT_A, 8]])
    const result = recordCount(h.deps, {
      sessionId,
      variantId: VARIANT_B,
      variantLabel: 'B',
      countedQty: 5
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/can no longer be counted into/i)
  })

  it('refuses to submit an empty count', async () => {
    const h = harness()
    const opened = await openStockTake(h.deps, 1)
    const result = submitForApproval(h.deps, opened.data!.session.id)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/at least one item/i)
  })

  it('refuses to push a session that has not been submitted', async () => {
    const h = harness()
    const opened = await openStockTake(h.deps, 1)
    const sessionId = opened.data!.session.id
    recordCount(h.deps, { sessionId, variantId: VARIANT_A, variantLabel: 'A', countedQty: 8 })

    const result = await commitStockTake(h.deps, {
      sessionId,
      approverStaffId: 2,
      secondApproverStaffId: 3
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/submit this stock take/i)
    expect(h.pushes).toHaveLength(0)
  })

  it('cannot discard a committed session', async () => {
    const h = harness()
    const sessionId = await countedSession(h, [[VARIANT_A, 8]])
    await commitStockTake(h.deps, { sessionId, approverStaffId: 2, secondApproverStaffId: 3 })

    const result = abandonStockTake(h.deps, sessionId)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/cannot be discarded/i)
  })

  it('frees the till for a new count once one is discarded', async () => {
    const h = harness()
    const opened = await openStockTake(h.deps, 1)
    expect(abandonStockTake(h.deps, opened.data!.session.id).success).toBe(true)
    expect(h.db.getActiveStockTakeSession()).toBeUndefined()
  })
})

describe('stock take — the Shopify mutation input', () => {
  it('adjusts the available bucket with the cycle-count reason and a traceable reference', () => {
    const input = buildInventoryAdjustInput({
      locationId: LOCATION,
      sessionUuid: 'abc-123',
      changes: [{ inventoryItemId: ITEM_A, delta: -2, changeFromQuantity: 8 }]
    })

    expect(input).toEqual({
      name: 'available',
      reason: STOCK_TAKE_REASON,
      referenceDocumentUri: 'gid://rubis-pos/StockTake/abc-123',
      changes: [
        {
          inventoryItemId: ITEM_A,
          locationId: LOCATION,
          delta: -2,
          changeFromQuantity: 8
        }
      ]
    })
  })

  it('never emits an absolute quantity field', () => {
    const input = buildInventoryAdjustInput({
      locationId: LOCATION,
      sessionUuid: 'abc-123',
      changes: [{ inventoryItemId: ITEM_A, delta: 3, changeFromQuantity: 1 }]
    })
    expect(JSON.stringify(input)).not.toMatch(/"quantity"\s*:/)
  })
})

describe('stock take — the cached products table is never consulted', () => {
  /**
   * The snapshot comes from Shopify, not from `products`. A cache that
   * disagrees wildly with Shopify must change nothing about the
   * variance — if it did, the cached column would be acting as a second
   * ledger.
   */
  it('takes its snapshot from Shopify even when the cache says otherwise', async () => {
    const h = harness()
    h.db.cacheProducts([
      {
        id: 'gid://shopify/Product/1',
        title: 'Mug',
        handle: 'mug',
        featuredImage: null,
        variants: [
          {
            id: VARIANT_A,
            productId: '1',
            title: 'Default',
            price: 100,
            availableForSale: true,
            inventoryQuantity: 9999,
            image: null,
            barcode: null
          }
        ]
      }
    ])

    const sessionId = await countedSession(h, [[VARIANT_A, 8]])
    const [item] = h.db.getStockTakeItems(sessionId)

    expect(item.system_snapshot_qty).toBe(10)
    expect(item.variance).toBe(-2)
  })

  it('reads only the price from the cache, never the quantity', async () => {
    const h = harness()
    const spy = vi.spyOn(h.db, 'getCachedVariantPrice')
    await countedSession(h, [[VARIANT_A, 8]])
    expect(spy).toHaveBeenCalledWith(VARIANT_A)
  })
})
