/**
 * Shopify reconciliation runner tests (docs/phase-170 commit 2).
 *
 * Uses an injected mock axios client (no real Shopify call) and a fake
 * `ReconciliationDatabase` recording every write.
 */

import { describe, it, expect, vi } from 'vitest'
import type { AxiosInstance } from 'axios'
import { createReconciliationRunner } from '../src/main/services/reconciliation.js'
import type { ReconciliationDatabase, ReconciliationResult } from '../src/main/services/reconciliation.js'
import type { ReconciliationCandidateRow, SyncQueueItem } from '../src/main/services/database.js'

const mockClient = (postImpl: ReturnType<typeof vi.fn>) => ({ post: postImpl }) as unknown as AxiosInstance

const scopesReady = { data: { data: { currentAppInstallation: { accessScopes: [{ handle: 'read_orders' }] } } } }
const scopesMissing = { data: { data: { currentAppInstallation: { accessScopes: [{ handle: 'read_products' }] } } } }

function ordersReply(nodes: unknown[]) {
  return { data: { data: { orders: { nodes } } } }
}

function candidate(overrides: Partial<ReconciliationCandidateRow> = {}): ReconciliationCandidateRow {
  return {
    local_id: 5,
    status: 'pending_sync',
    shopify_order_id: null,
    shopify_push_count: 1,
    created_at: '2026-09-20T10:00:00.000Z',
    client_order_uuid: 'uuid-5',
    ...overrides
  }
}

function fakeDb(candidates: ReconciliationCandidateRow[] = []): ReconciliationDatabase & {
  linkCalls: Array<[number, string]>
} {
  const linkCalls: Array<[number, string]> = []
  return {
    getReconciliationCandidates: vi.fn(() => candidates),
    getShopifyPushMarker: vi.fn(() => undefined),
    linkOrderToShopify: vi.fn((localId: number, shopifyOrderId: string) => {
      linkCalls.push([localId, shopifyOrderId])
      return { linked: true }
    }),
    linkCalls
  }
}

describe('reconciliation runCheck', () => {
  it('lost-response sale: exactly one match, not cancelled -> linked, never resent', async () => {
    const db = fakeDb([candidate()])
    const post = vi
      .fn()
      .mockResolvedValueOnce(scopesReady)
      .mockResolvedValueOnce(
        ordersReply([
          { id: 'gid://shopify/Order/900', name: '#1900', createdAt: '2026-09-20T10:00:05Z', cancelledAt: null, sourceIdentifier: 'uuid-5' }
        ])
      )
      .mockResolvedValueOnce({ data: { data: { ordersCount: { count: 0, precision: 'EXACT' } } } })

    let last: ReconciliationResult | undefined
    const runner = createReconciliationRunner({ db, getClient: () => mockClient(post), onResult: (r) => (last = r) })

    const outcome = await runner.runCheck(new AbortController().signal)

    expect(outcome).toEqual({ ok: true })
    expect(db.linkCalls).toEqual([[5, 'gid://shopify/Order/900']])
    expect(last?.findings).toEqual([{ kind: 'linked', localId: 5, shopifyOrderId: 'gid://shopify/Order/900', shopifyName: '#1900' }])
  })

  it('two matches: reported, never linked', async () => {
    const db = fakeDb([candidate()])
    const post = vi
      .fn()
      .mockResolvedValueOnce(scopesReady)
      .mockResolvedValueOnce(
        ordersReply([
          { id: 'gid://shopify/Order/1', name: '#1001', createdAt: '2026-09-20T10:00:00Z', cancelledAt: null, sourceIdentifier: 'uuid-5' },
          { id: 'gid://shopify/Order/2', name: '#1002', createdAt: '2026-09-20T10:05:00Z', cancelledAt: null, sourceIdentifier: 'uuid-5' }
        ])
      )
      .mockResolvedValueOnce({ data: { data: { ordersCount: { count: 0, precision: 'EXACT' } } } })

    let last: ReconciliationResult | undefined
    const runner = createReconciliationRunner({ db, getClient: () => mockClient(post), onResult: (r) => (last = r) })
    await runner.runCheck(new AbortController().signal)

    expect(db.linkCalls).toHaveLength(0)
    expect(last?.findings).toEqual([
      { kind: 'duplicate', localId: 5, shopifyIds: ['gid://shopify/Order/1', 'gid://shopify/Order/2'], shopifyNames: ['#1001', '#1002'] }
    ])
  })

  it('the only match is cancelled: held, reported, never linked', async () => {
    const db = fakeDb([candidate()])
    const post = vi
      .fn()
      .mockResolvedValueOnce(scopesReady)
      .mockResolvedValueOnce(
        ordersReply([
          { id: 'gid://shopify/Order/1', name: '#1001', createdAt: '2026-09-20T10:00:00Z', cancelledAt: '2026-09-21T00:00:00Z', sourceIdentifier: 'uuid-5' }
        ])
      )
      .mockResolvedValueOnce({ data: { data: { ordersCount: { count: 0, precision: 'EXACT' } } } })

    let last: ReconciliationResult | undefined
    const runner = createReconciliationRunner({ db, getClient: () => mockClient(post), onResult: (r) => (last = r) })
    await runner.runCheck(new AbortController().signal)

    expect(db.linkCalls).toHaveLength(0)
    expect(last?.findings).toEqual([{ kind: 'held-cancelled', localId: 5, shopifyId: 'gid://shopify/Order/1' }])
  })

  it('a synced sale whose Shopify order is gone is reported as missing', async () => {
    const db = fakeDb([candidate({ local_id: 9, status: 'synced', shopify_order_id: 'gid://shopify/Order/9', shopify_push_count: 1, client_order_uuid: 'uuid-9' })])
    const post = vi
      .fn()
      .mockResolvedValueOnce(scopesReady)
      .mockResolvedValueOnce({ data: { data: { nodes: [null] } } })
      .mockResolvedValueOnce({ data: { data: { ordersCount: { count: 1, precision: 'EXACT' } } } })

    let last: ReconciliationResult | undefined
    const runner = createReconciliationRunner({ db, getClient: () => mockClient(post), onResult: (r) => (last = r) })
    await runner.runCheck(new AbortController().signal)

    expect(last?.findings).toEqual([{ kind: 'missing', localId: 9, shopifyOrderId: 'gid://shopify/Order/9' }])
    // The "other tills" number subtracts this till's own synced count (1) from the store total (1).
    expect(last?.otherTillsCount).toBe(0)
  })

  it('scope missing: fails safe, no candidate is ever read or looked up', async () => {
    const db = fakeDb([candidate()])
    const post = vi.fn().mockResolvedValueOnce(scopesMissing)

    let last: ReconciliationResult | undefined
    const runner = createReconciliationRunner({ db, getClient: () => mockClient(post), onResult: (r) => (last = r) })
    const outcome = await runner.runCheck(new AbortController().signal)

    expect(outcome).toEqual({ ok: false })
    expect(last?.ok).toBe(false)
    expect(last?.failureReason).toMatch(/read_orders/i)
    expect(db.getReconciliationCandidates).not.toHaveBeenCalled()
    expect(post).toHaveBeenCalledTimes(1) // only the scope check itself
  })

  it('credentials missing: fails safe, no Shopify call at all', async () => {
    const db = fakeDb([candidate()])
    const post = vi.fn()

    let last: ReconciliationResult | undefined
    const runner = createReconciliationRunner({ db, getClient: () => null, onResult: (r) => (last = r) })
    const outcome = await runner.runCheck(new AbortController().signal)

    expect(outcome).toEqual({ ok: false })
    expect(last?.failureReason).toMatch(/credentials missing/i)
    expect(post).not.toHaveBeenCalled()
  })
})

describe('reconciliation guardPush', () => {
  const item = (overrides: Partial<SyncQueueItem> = {}): SyncQueueItem => ({
    id: 1,
    entity_type: 'order',
    entity_id: 5,
    action: 'orderCreate',
    payload: {
      clientOrderUuid: 'uuid-5',
      total: 10,
      createdAt: '2026-09-20T10:00:00Z',
      staffId: 1,
      staffName: 'Alex',
      paymentMethod: 'cash',
      tenderedAmount: 10,
      changeDue: 0,
      lineItems: []
    },
    attempts: 0,
    last_error: null,
    created_at: '2026-09-20T10:00:00Z',
    next_attempt_at: 0,
    ...overrides
  })

  it('credentials missing: holds rather than pushing blind, with no Shopify call', async () => {
    const db = fakeDb()
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString()
    db.getShopifyPushMarker = vi.fn(() => ({ count: 1, lastPushAt: fiveMinutesAgo }))
    const post = vi.fn()
    const runner = createReconciliationRunner({ db, getClient: () => null })

    const decision = await runner.guardPush(item())

    expect(decision.action).toBe('hold')
    expect(post).not.toHaveBeenCalled()
  })

  it('a fresh sale (push count 0) is always allowed to push, with no Shopify call', async () => {
    const db = fakeDb()
    db.getShopifyPushMarker = vi.fn(() => ({ count: 0, lastPushAt: null }))
    const post = vi.fn()
    const runner = createReconciliationRunner({ db, getClient: () => mockClient(post) })

    const decision = await runner.guardPush(item())

    expect(decision).toEqual({ action: 'push' })
    expect(post).not.toHaveBeenCalled()
  })

  it('a push under 2 minutes ago is held without a Shopify call', async () => {
    const db = fakeDb()
    const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString()
    db.getShopifyPushMarker = vi.fn(() => ({ count: 1, lastPushAt: oneMinuteAgo }))
    const post = vi.fn()
    const runner = createReconciliationRunner({ db, getClient: () => mockClient(post) })

    const decision = await runner.guardPush(item())

    expect(decision.action).toBe('hold')
    expect(post).not.toHaveBeenCalled()
  })

  it('a push over 2 minutes ago with no match found is allowed to push', async () => {
    const db = fakeDb()
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString()
    db.getShopifyPushMarker = vi.fn(() => ({ count: 1, lastPushAt: fiveMinutesAgo }))
    const post = vi.fn().mockResolvedValue(ordersReply([]))
    const runner = createReconciliationRunner({ db, getClient: () => mockClient(post) })

    const decision = await runner.guardPush(item())

    expect(decision).toEqual({ action: 'push' })
  })

  it('a push over 2 minutes ago with exactly one match is linked, not pushed', async () => {
    const db = fakeDb()
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString()
    db.getShopifyPushMarker = vi.fn(() => ({ count: 1, lastPushAt: fiveMinutesAgo }))
    const post = vi.fn().mockResolvedValue(
      ordersReply([{ id: 'gid://shopify/Order/900', name: '#1900', createdAt: '2026-09-20T10:00:05Z', cancelledAt: null, sourceIdentifier: 'uuid-5' }])
    )
    const runner = createReconciliationRunner({ db, getClient: () => mockClient(post) })

    const decision = await runner.guardPush(item())

    expect(decision).toEqual({ action: 'linked', shopifyOrderId: 'gid://shopify/Order/900' })
    expect(db.linkCalls).toEqual([[5, 'gid://shopify/Order/900']])
  })

  it('the lookup being unavailable (an error result) holds, never pushes blind', async () => {
    const db = fakeDb()
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString()
    db.getShopifyPushMarker = vi.fn(() => ({ count: 1, lastPushAt: fiveMinutesAgo }))
    const post = vi.fn().mockResolvedValue({ data: { errors: [{ message: 'boom' }] } })
    const runner = createReconciliationRunner({ db, getClient: () => mockClient(post) })

    const decision = await runner.guardPush(item())

    expect(decision.action).toBe('hold')
  })

  it('reuses the same-tick lookup the periodic check already made (no second Shopify call)', async () => {
    const db = fakeDb([candidate()])
    const post = vi
      .fn()
      .mockResolvedValueOnce(scopesReady)
      .mockResolvedValueOnce(ordersReply([]))
      .mockResolvedValueOnce({ data: { data: { ordersCount: { count: 0, precision: 'EXACT' } } } })
    db.getShopifyPushMarker = vi.fn(() => ({ count: 1, lastPushAt: new Date(Date.now() - 5 * 60_000).toISOString() }))
    const runner = createReconciliationRunner({ db, getClient: () => mockClient(post) })

    await runner.runCheck(new AbortController().signal) // looks up uuid-5 once, caches it (no match -> nothing to report)
    const decision = await runner.guardPush(item()) // same uuid, same tick

    expect(decision).toEqual({ action: 'push' })
    // Exactly the 3 calls the check itself made - no extra lookup for the guard.
    expect(post).toHaveBeenCalledTimes(3)
  })

  it("beginTick() clears the cache, so a new tick's guard looks up again", async () => {
    const db = fakeDb()
    db.getShopifyPushMarker = vi.fn(() => ({ count: 1, lastPushAt: new Date(Date.now() - 5 * 60_000).toISOString() }))
    const post = vi.fn().mockResolvedValue(ordersReply([]))
    const runner = createReconciliationRunner({ db, getClient: () => mockClient(post) })

    await runner.guardPush(item())
    runner.beginTick()
    await runner.guardPush(item())

    expect(post).toHaveBeenCalledTimes(2)
  })
})
