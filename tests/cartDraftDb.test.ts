/**
 * The cart draft and removal audit in SQLite (docs/phase-197): one
 * overwritten draft row, deleted in the order's own transaction; removal
 * rows written only after a manager's PIN checks out and stamped with the
 * order at checkout.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { RubisDatabase } from '../src/main/services/database.js'
import { hashPin } from '../src/main/services/auth.js'
import { recordApprovedRemovals } from '../src/main/services/cart-removals.js'
import {
  checkoutRequestSchema,
  recordCartRemovalsSchema,
  saveCartDraftSchema
} from '../src/main/lib/ipcValidator.js'
import type { CartItem } from '../src/renderer/src/types/shopify.js'

function freshDb(): RubisDatabase {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  return db
}

function seedStaff(db: RubisDatabase): { cashierId: number; managerId: number } {
  const cashier = db.createStaff({ name: 'Cash', pinHash: hashPin('1111'), role: 'cashier' })
  const manager = db.createStaff({ name: 'Mgr', pinHash: hashPin('2222'), role: 'admin' })
  return { cashierId: cashier.staffId, managerId: manager.staffId }
}

const item: CartItem = {
  id: 'v1',
  productId: 'p1',
  title: 'Mug',
  variantTitle: 'Small',
  price: 60,
  quantity: 1,
  image: null
}

function sell(db: RubisDatabase, staffId: number, cartToken?: string): number {
  return db.queueOrder({
    items: [item],
    total: 60,
    clientOrderUuid: `uuid-${Math.random()}`,
    staffId,
    staffName: 'Cash',
    paymentMethod: 'cash',
    tenderedAmount: 60,
    changeDue: 0,
    cartToken
  }).localId
}

const removal = (cartToken: string, variantId = 'v1') => ({
  cart_token: cartToken,
  variant_id: variantId,
  qty_before: 2,
  qty_after: 0,
  staff_id: 1,
  manager_id: 2,
  at: '2026-10-02T10:00:00.000Z'
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('cart draft', () => {
  it('saves the cart and reads it back', () => {
    const db = freshDb()

    db.saveCartDraft('{"items":[1]}')

    expect(db.getCartDraft()?.payload_json).toBe('{"items":[1]}')
  })

  it('overwrites rather than appends: saving twice leaves one row with the latest cart', () => {
    const db = freshDb()

    db.saveCartDraft('first')
    db.saveCartDraft('second')

    expect(db.getCartDraft()?.payload_json).toBe('second')
    expect(
      (db as unknown as { conn: { prepare: (sql: string) => { get: () => { n: number } } } }).conn
        .prepare('SELECT COUNT(*) AS n FROM cart_drafts')
        .get().n
    ).toBe(1)
  })

  it('has no draft until one is saved, and none after it is cleared', () => {
    const db = freshDb()
    expect(db.getCartDraft()).toBeUndefined()

    db.saveCartDraft('x')
    db.clearCartDraft()

    expect(db.getCartDraft()).toBeUndefined()
  })

  it('is deleted in the same transaction that creates the order', () => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)
    db.saveCartDraft('the cart being sold')

    sell(db, cashierId)

    expect(db.getCartDraft()).toBeUndefined()
  })

  it('survives when the order does not get created: the delete runs inside the order transaction, after it', () => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)
    db.saveCartDraft('the cart being sold')

    expect(() =>
      db.queueOrder({
        items: [item],
        total: 60,
        clientOrderUuid: 'uuid-rolled-back',
        staffId: cashierId,
        staffName: 'Cash',
        paymentMethod: 'cash',
        tenderedAmount: 60,
        changeDue: 0,
        buildFiscalRequest: () => {
          throw new Error('the sale could not be queued')
        }
      })
    ).toThrow('the sale could not be queued')

    expect(db.getCartDraft()?.payload_json).toBe('the cart being sold')
    expect(db.getOrders()).toEqual([])
  })

  it('never aborts a sale: if the draft cannot be deleted the order is still created', () => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)
    const conn = (db as unknown as { conn: { exec: (sql: string) => void } }).conn
    conn.exec('DROP TABLE cart_drafts')
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const localId = sell(db, cashierId, 'token-1')

    expect(localId).toBeGreaterThan(0)
    expect(db.getOrder(localId)).toBeDefined()
    expect(logged).toHaveBeenCalledTimes(1)
  })
})

describe('cart line removals', () => {
  it('are appended with no order id', () => {
    const db = freshDb()

    db.recordCartLineRemovals([removal('t1'), removal('t1', 'v2')])

    const rows = db.listCartLineRemovals()
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.order_local_id === null)).toBe(true)
  })

  it('are stamped with the order id at checkout, for that cart only', () => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)
    db.recordCartLineRemovals([removal('this-cart'), removal('abandoned-cart')])

    const localId = sell(db, cashierId, 'this-cart')

    const rows = db.listCartLineRemovals()
    expect(rows.find((row) => row.cart_token === 'this-cart')?.order_local_id).toBe(localId)
    expect(rows.find((row) => row.cart_token === 'abandoned-cart')?.order_local_id).toBeNull()
  })

  it('are not stamped on an order that carries no cart token', () => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)
    db.recordCartLineRemovals([removal('t1')])

    sell(db, cashierId)

    expect(db.listCartLineRemovals()[0].order_local_id).toBeNull()
  })

  it('are not re-stamped by a later order from the same cart token', () => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)
    db.recordCartLineRemovals([removal('t1')])
    const first = sell(db, cashierId, 't1')

    sell(db, cashierId, 't1')

    expect(db.listCartLineRemovals()[0].order_local_id).toBe(first)
  })
})

describe('recordApprovedRemovals: written only after the manager PIN checks out', () => {
  const request = (managerId: number, managerPin: string, staffId = 1) => ({
    managerId,
    managerPin,
    staffId,
    cartToken: 'cart-1',
    changes: [{ variantId: 'v1', qtyBefore: 3, qtyAfter: 1 }]
  })

  it('writes one row per change, naming the manager and the cashier, for a correct admin PIN', () => {
    const db = freshDb()
    const { cashierId, managerId } = seedStaff(db)

    const result = recordApprovedRemovals(db, request(managerId, '2222', cashierId), () => new Date('2026-10-02T10:00:00Z'))

    expect(result).toEqual({ success: true })
    expect(db.listCartLineRemovals()).toEqual([
      {
        id: 1,
        order_local_id: null,
        cart_token: 'cart-1',
        variant_id: 'v1',
        qty_before: 3,
        qty_after: 1,
        staff_id: cashierId,
        manager_id: managerId,
        at: '2026-10-02T10:00:00.000Z'
      }
    ])
  })

  it('writes nothing for a wrong PIN', () => {
    const db = freshDb()
    const { managerId } = seedStaff(db)

    const result = recordApprovedRemovals(db, request(managerId, '0000'))

    expect(result.success).toBe(false)
    expect(db.listCartLineRemovals()).toEqual([])
  })

  it('writes nothing when the right PIN belongs to a cashier, not a manager', () => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)

    const result = recordApprovedRemovals(db, request(cashierId, '1111'))

    expect(result.success).toBe(false)
    expect(db.listCartLineRemovals()).toEqual([])
  })

  it('writes nothing for an unknown manager', () => {
    const db = freshDb()
    seedStaff(db)

    expect(recordApprovedRemovals(db, request(9999, '2222')).success).toBe(false)
    expect(db.listCartLineRemovals()).toEqual([])
  })
})

describe('IPC payloads', () => {
  const line = { id: 'v1', productId: 'p1', title: 'Mug', variantTitle: '', price: 60, quantity: 1, image: null }

  // CHANGED (docs/phase-249): every checkout payload now carries the screen's checkout key, which the schema requires.
  it('checkout accepts a cart token and rejects an empty one', () => {
    const base = {
      items: [line],
      total: 60,
      staffId: 1,
      paymentMethod: 'cash',
      tenderedAmount: 60,
      changeDue: 0,
      checkoutKey: '0b7d9c2e-4f1a-4c3b-9e8d-1a2b3c4d5e6f'
    }
    expect(checkoutRequestSchema.safeParse({ ...base, cartToken: 'abc' }).success).toBe(true)
    expect(checkoutRequestSchema.safeParse(base).success).toBe(true)
    expect(checkoutRequestSchema.safeParse({ ...base, cartToken: '' }).success).toBe(false)
  })

  it('the draft payload needs a token and at least one line, and carries no payment fields', () => {
    expect(saveCartDraftSchema.safeParse({ cartToken: 't', items: [line] }).success).toBe(true)
    expect(saveCartDraftSchema.safeParse({ cartToken: 't', items: [] }).success).toBe(false)
    expect(saveCartDraftSchema.safeParse({ items: [line] }).success).toBe(false)
    const parsed = saveCartDraftSchema.parse({ cartToken: 't', items: [line], tenderedAmount: 500, mpesaCode: 'ABC' })
    expect(Object.keys(parsed).sort()).toEqual(['cartToken', 'items'])
  })

  it('the removal payload needs a manager id and PIN', () => {
    const change = { variantId: 'v1', qtyBefore: 2, qtyAfter: 0 }
    const ok = { managerId: 2, managerPin: '2222', staffId: 1, cartToken: 't', changes: [change] }
    expect(recordCartRemovalsSchema.safeParse(ok).success).toBe(true)
    expect(recordCartRemovalsSchema.safeParse({ ...ok, managerPin: '' }).success).toBe(false)
    expect(recordCartRemovalsSchema.safeParse({ ...ok, changes: [] }).success).toBe(false)
  })
})
