/**
 * Holding a sale and serving the next customer (docs/phase-217): the held_sales
 * table, the hold/resume/discard services, the startup rules, the order
 * transaction's completion stamp, and the Close Shift refusal.
 *
 * A held sale is not a sale. Most of what is proved here is what does NOT happen:
 * no order, no sync-queue row, no fiscal request, no trader number.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RubisDatabase, nextHeldLabel } from '../src/main/services/database.js'
import { hashPin } from '../src/main/services/auth.js'
import {
  closeShiftUnlessHeld,
  discardHeldSaleApproved,
  holdCart
} from '../src/main/services/held-sales.js'
import type { HoldRequest } from '../src/main/services/held-sales.js'
import { discardHeldSaleSchema, holdSaleSchema, validate } from '../src/main/lib/ipcValidator.js'
import { MAX_HELD_LABEL_LENGTH, MAX_HELD_SALES } from '../src/main/lib/heldSaleRules.js'
import { MAX_HELD_SALES as RENDERER_MAX_HELD_SALES } from '../src/renderer/src/lib/heldSale.js'
import { getLocalDayRange, todayLocalDay } from '../src/main/services/reports.js'
import type { CartItem } from '../src/renderer/src/types/shopify.js'

const LOCATION = 'gid://shopify/Location/77557989479'

const mug: CartItem = {
  id: 'gid://shopify/ProductVariant/1',
  productId: 'gid://shopify/Product/1',
  title: 'Mug',
  variantTitle: 'Small',
  price: 55,
  basePrice: 60,
  quantity: 2,
  image: null,
  discount: { type: 'percent', value: 10 },
  vatClass: 'A',
  hsCode: '0013.12.02',
  hsName: 'Maize'
}
const milk: CartItem = {
  id: 'gid://shopify/ProductVariant/2',
  productId: 'gid://shopify/Product/2',
  title: 'Milk',
  variantTitle: 'Default Title',
  price: 65,
  basePrice: 65,
  quantity: 1,
  image: null
}

const dirs: string[] = []
const opened: RubisDatabase[] = []

function freshDb(path = ':memory:'): RubisDatabase {
  const db = new RubisDatabase({ dbPath: path })
  db.init()
  opened.push(db)
  return db
}

function fileDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rubis-held-'))
  dirs.push(dir)
  return join(dir, 'rubis.db')
}

afterEach(() => {
  for (const db of opened.splice(0)) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function seedStaff(db: RubisDatabase): { cashierId: number; managerId: number; otherCashierId: number } {
  const cashier = db.createStaff({ name: 'Cash', pinHash: hashPin('1111'), role: 'cashier' })
  const manager = db.createStaff({ name: 'Mgr', pinHash: hashPin('2222'), role: 'admin' })
  const other = db.createStaff({ name: 'Other', pinHash: hashPin('3333'), role: 'cashier' })
  return { cashierId: cashier.staffId, managerId: manager.staffId, otherCashierId: other.staffId }
}

function cartRequest(staffId: number, cartToken: string, overrides: Partial<HoldRequest> = {}): HoldRequest {
  return {
    cartToken,
    staffId,
    total: 163,
    items: [mug, milk],
    cartDiscount: { type: 'fixed', value: 5 },
    customerPin: 'P051234567Z',
    companyName: 'ACME TRADERS LTD',
    ...overrides
  }
}

function hold(db: RubisDatabase, staffId: number, cartToken: string, overrides: Partial<HoldRequest> = {}) {
  const request = cartRequest(staffId, cartToken, overrides)
  const checked = validate(holdSaleSchema, request)
  if (!checked.success) throw new Error(checked.error)
  const result = holdCart(db, checked.data)
  if (!result.success || !result.data) throw new Error(result.error)
  return result.data
}

type Conn = { prepare: (sql: string) => { get: (...a: unknown[]) => Record<string, unknown>; all: (...a: unknown[]) => Record<string, unknown>[] } }
const conn = (db: RubisDatabase): Conn => (db as unknown as { conn: Conn }).conn
const count = (db: RubisDatabase, table: string): number =>
  conn(db).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n as number

function sell(
  db: RubisDatabase,
  staffId: number,
  cartToken: string,
  paymentMethod: 'cash' | 'mpesa',
  items: CartItem[],
  total: number
): number {
  return db.queueOrder({
    items,
    total,
    clientOrderUuid: `uuid-${cartToken}`,
    staffId,
    staffName: 'Cash',
    paymentMethod,
    tenderedAmount: total,
    changeDue: 0,
    cartToken,
    locationId: LOCATION,
    locationName: 'Rubis Kisumu'
  }).localId
}

describe('the limit is one number in two places', () => {
  it('the renderer copy of the limit equals the one the main process enforces', () => {
    expect(RENDERER_MAX_HELD_SALES).toBe(MAX_HELD_SALES)
    expect(MAX_HELD_SALES).toBe(3)
  })
})

describe('a held sale is not a sale', () => {
  it('writes no order, no sync-queue row, no fiscal request and no trader number', () => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)
    const traderSeqBefore = db.getSetting('last_trader_seq')

    hold(db, cashierId, 'cart-1')

    expect(count(db, 'orders')).toBe(0)
    expect(count(db, 'sync_queue')).toBe(0)
    expect(db.getSetting('last_trader_seq')).toBe(traderSeqBefore)
    expect(db.getSetting('last_trader_seq')).toBeUndefined()
  })

  it('stores the lines, discounts, customer and token, and no payment state', () => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)

    hold(db, cashierId, 'cart-1')
    const row = conn(db).prepare('SELECT payload_json FROM held_sales').get()
    const payload = JSON.parse(row.payload_json as string) as Record<string, unknown>

    expect(Object.keys(payload).sort()).toEqual(['cartDiscount', 'companyName', 'customerPin', 'items'])
    expect(JSON.stringify(payload)).not.toMatch(/"(paymentMethod|tenderedAmount|changeDue|referenceNumber|mpesa\w*|cardManual)"/)
  })

  it('refuses a request that carries payment state: the schema has no such field', () => {
    const request = { ...cartRequest(1, 'cart-1'), paymentMethod: 'mpesa', tenderedAmount: 500 }
    const checked = validate(holdSaleSchema, request)

    expect(checked.success).toBe(true)
    expect(checked.success && 'paymentMethod' in checked.data).toBe(false)
  })

  it('resumes with every line, quantity, price, base price, discount, customer PIN and company name exactly as held', () => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)
    const held = hold(db, cashierId, 'cart-1')

    const { summary, payloadJson } = db.resumeHeldSale(held.id)
    const back = JSON.parse(payloadJson) as { items: CartItem[]; cartDiscount: unknown; customerPin: string; companyName: string }

    expect(back.items).toEqual([mug, milk])
    expect(back.items[0].price).toBe(55)
    expect(back.items[0].basePrice).toBe(60)
    expect(back.items[0].discount).toEqual({ type: 'percent', value: 10 })
    expect(back.cartDiscount).toEqual({ type: 'fixed', value: 5 })
    expect(back.customerPin).toBe('P051234567Z')
    expect(back.companyName).toBe('ACME TRADERS LTD')
    expect(summary.cartToken).toBe('cart-1')
  })
})

describe('labels and the limit', () => {
  it('names held sales Customer 1, 2, 3 and gives the lowest free number to the next', () => {
    const db = freshDb()
    const { cashierId, managerId } = seedStaff(db)

    const first = hold(db, cashierId, 't1')
    const second = hold(db, cashierId, 't2')
    expect([first.label, second.label]).toEqual(['Customer 1', 'Customer 2'])

    const result = discardHeldSaleApproved(db, { id: first.id, staffId: cashierId, managerId, managerPin: '2222', reason: 'left' })
    expect(result.success).toBe(true)

    expect(hold(db, cashierId, 't3').label).toBe('Customer 1')
    expect(hold(db, cashierId, 't4').label).toBe('Customer 3')
  })

  it('nextHeldLabel skips custom names and fills gaps', () => {
    expect(nextHeldLabel([])).toBe('Customer 1')
    expect(nextHeldLabel(['Customer 1', 'lady in red', 'Customer 3'])).toBe('Customer 2')
    expect(nextHeldLabel(['Customer 2'])).toBe('Customer 1')
  })

  it('refuses a fourth hold with a plain message and writes nothing', () => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)
    for (const token of ['t1', 't2', 't3']) hold(db, cashierId, token)

    const result = holdCart(db, cartRequest(cashierId, 't4'))

    expect(result.success).toBe(false)
    expect(result.error).toContain('3 sales')
    expect(db.listOpenHeldSales()).toHaveLength(MAX_HELD_SALES)
  })

  it('lets a resumed cart be held again at the limit, reusing its row, label and token', () => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)
    for (const token of ['t1', 't2', 't3']) hold(db, cashierId, token)
    const [first] = db.listOpenHeldSales()
    db.resumeHeldSale(first.id)

    const again = hold(db, cashierId, 't1', { items: [milk], total: 65 })

    expect(again.id).toBe(first.id)
    expect(again.label).toBe(first.label)
    expect(again.status).toBe('held')
    expect(again.lineCount).toBe(1)
    expect(db.listOpenHeldSales()).toHaveLength(3)
  })

  it('renames, trims, caps the length and refuses an empty name', () => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)
    const held = hold(db, cashierId, 't1')

    expect(db.renameHeldSale(held.id, '  lady in red ').label).toBe('lady in red')
    expect(db.renameHeldSale(held.id, 'x'.repeat(100)).label).toHaveLength(MAX_HELD_LABEL_LENGTH)
    expect(() => db.renameHeldSale(held.id, '   ')).toThrow('needs a name')
  })

  it('resumes a sale only once: a second resume says it is no longer on hold', () => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)
    const held = hold(db, cashierId, 't1')

    db.resumeHeldSale(held.id)

    expect(() => db.resumeHeldSale(held.id)).toThrow('no longer on hold')
  })
})

describe('discarding a held sale', () => {
  it('needs the manager PIN: a wrong PIN, a cashier PIN and no PIN all leave the sale held', () => {
    const db = freshDb()
    const { cashierId, managerId, otherCashierId } = seedStaff(db)
    const held = hold(db, cashierId, 't1')

    const wrong = discardHeldSaleApproved(db, { id: held.id, staffId: cashierId, managerId, managerPin: '0000', reason: 'left' })
    const cashier = discardHeldSaleApproved(db, { id: held.id, staffId: cashierId, managerId: otherCashierId, managerPin: '3333', reason: 'left' })
    const none = validate(discardHeldSaleSchema, { id: held.id, staffId: cashierId, managerId, reason: 'left' })

    expect(wrong.success).toBe(false)
    expect(cashier.success).toBe(false)
    expect(none.success).toBe(false)
    expect(db.listOpenHeldSales()).toHaveLength(1)
    expect(db.listOpenHeldSales()[0].status).toBe('held')
  })

  it('needs a reason: the request schema and the database both refuse an empty one', () => {
    const db = freshDb()
    const { cashierId, managerId } = seedStaff(db)
    const held = hold(db, cashierId, 't1')

    expect(validate(discardHeldSaleSchema, { id: held.id, staffId: cashierId, managerId, managerPin: '2222', reason: '  ' }).success).toBe(false)
    expect(() => db.discardHeldSale({ id: held.id, staffId: cashierId, managerId, reason: '  ' })).toThrow('reason is required')
    expect(db.listOpenHeldSales()).toHaveLength(1)
  })

  it('records who, when, the label, the total, the lines, the reason and the manager, and keeps the row', () => {
    const db = freshDb()
    const { cashierId, managerId } = seedStaff(db)
    const held = hold(db, cashierId, 't1')
    db.renameHeldSale(held.id, 'lady in red')

    const result = discardHeldSaleApproved(db, { id: held.id, staffId: cashierId, managerId, managerPin: '2222', reason: ' customer left without paying ' })
    const { startIso, endIso } = getLocalDayRange(todayLocalDay())
    const [entry] = db.getDiscardedHeldSales(startIso, endIso)

    expect(result.success).toBe(true)
    expect(db.listOpenHeldSales()).toHaveLength(0)
    expect(entry).toMatchObject({
      label: 'lady in red',
      total: 163,
      lineCount: 2,
      heldByName: 'Cash',
      discardedByName: 'Cash',
      managerName: 'Mgr',
      reason: 'customer left without paying'
    })
    expect(new Date(entry.discardedAt).getTime()).toBeGreaterThan(Date.now() - 60_000)
    expect(count(db, 'held_sales')).toBe(1)
  })

  it('cannot discard a sale that is on screen (resumed) or already gone', () => {
    const db = freshDb()
    const { cashierId, managerId } = seedStaff(db)
    const held = hold(db, cashierId, 't1')
    db.resumeHeldSale(held.id)

    const onScreen = discardHeldSaleApproved(db, { id: held.id, staffId: cashierId, managerId, managerPin: '2222', reason: 'left' })

    expect(onScreen.success).toBe(false)
    expect(onScreen.error).toContain('no longer on hold')
  })

  it('lists only the discards of the day asked for', () => {
    const db = freshDb()
    const { cashierId, managerId } = seedStaff(db)
    const held = hold(db, cashierId, 't1')
    discardHeldSaleApproved(db, { id: held.id, staffId: cashierId, managerId, managerPin: '2222', reason: 'left' })

    const yesterday = getLocalDayRange('2020-01-01')
    expect(db.getDiscardedHeldSales(yesterday.startIso, yesterday.endIso)).toHaveLength(0)
  })
})

describe('after a restart', () => {
  it('held sales survive: closing and reopening the database brings them back, held', () => {
    const path = fileDbPath()
    const first = freshDb(path)
    const { cashierId } = seedStaff(first)
    hold(first, cashierId, 't1')
    hold(first, cashierId, 't2')
    first.close()

    const second = freshDb(path)

    expect(second.listOpenHeldSales().map((sale) => [sale.label, sale.status])).toEqual([
      ['Customer 1', 'held'],
      ['Customer 2', 'held']
    ])
  })

  it('a crash after resume: the row returns to the strip as held, prices unchanged', () => {
    const path = fileDbPath()
    const first = freshDb(path)
    const { cashierId } = seedStaff(first)
    const held = hold(first, cashierId, 't1')
    first.resumeHeldSale(held.id)
    expect(first.listOpenHeldSales()[0].status).toBe('resumed')
    first.close()

    const second = freshDb(path)
    const [back] = second.listOpenHeldSales()
    const { payloadJson } = second.resumeHeldSale(back.id)

    expect(back.status).toBe('held')
    expect(JSON.parse(payloadJson).items).toEqual([mug, milk])
  })

  it('when a saved cart draft has the token of a held sale, the held row wins and the draft is discarded', () => {
    const path = fileDbPath()
    const first = freshDb(path)
    const { cashierId } = seedStaff(first)
    hold(first, cashierId, 't1')
    first.saveCartDraft(JSON.stringify({ cartToken: 't1', items: [mug] }))
    first.close()

    const second = freshDb(path)

    expect(second.getCartDraft()).toBeUndefined()
    expect(second.listOpenHeldSales()).toHaveLength(1)
  })

  it('a resumed sale that crashed with its draft saved comes back once, as held, and the draft is dropped', () => {
    const path = fileDbPath()
    const first = freshDb(path)
    const { cashierId } = seedStaff(first)
    const held = hold(first, cashierId, 't1')
    first.resumeHeldSale(held.id)
    first.saveCartDraft(JSON.stringify({ cartToken: 't1', items: [mug] }))
    first.close()

    const second = freshDb(path)

    expect(second.getCartDraft()).toBeUndefined()
    expect(second.listOpenHeldSales().map((sale) => sale.status)).toEqual(['held'])
  })

  it('leaves a draft with any other token alone', () => {
    const path = fileDbPath()
    const first = freshDb(path)
    const { cashierId } = seedStaff(first)
    hold(first, cashierId, 't1')
    first.saveCartDraft(JSON.stringify({ cartToken: 'someone-else', items: [mug] }))
    first.close()

    const second = freshDb(path)

    expect(JSON.parse(second.getCartDraft()!.payload_json).cartToken).toBe('someone-else')
  })

  it('does not drop a draft whose held sale was completed: completed rows do not win', () => {
    const path = fileDbPath()
    const first = freshDb(path)
    const { cashierId } = seedStaff(first)
    const held = hold(first, cashierId, 't1')
    first.resumeHeldSale(held.id)
    sell(first, cashierId, 't1', 'cash', [mug, milk], 163)
    first.saveCartDraft(JSON.stringify({ cartToken: 't1', items: [mug] }))
    first.close()

    const second = freshDb(path)

    expect(second.getCartDraft()).toBeDefined()
    expect(second.listOpenHeldSales()).toHaveLength(0)
  })
})

describe('completing a resumed sale', () => {
  it('marks the held row completed, with the order id, in the order transaction', () => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)
    const held = hold(db, cashierId, 't1')
    db.resumeHeldSale(held.id)

    const localId = sell(db, cashierId, 't1', 'cash', [mug, milk], 163)
    const row = conn(db).prepare('SELECT status, order_local_id, completed_at FROM held_sales WHERE id = ?').get(held.id)

    expect(row.status).toBe('completed')
    expect(row.order_local_id).toBe(localId)
    expect(row.completed_at).toEqual(expect.any(String))
    expect(db.listOpenHeldSales()).toHaveLength(0)
  })

  it('does not mark anything when the order is not created: the sale and its stamp are one transaction', () => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)
    const held = hold(db, cashierId, 't1')
    db.resumeHeldSale(held.id)

    expect(() =>
      db.queueOrder({
        items: [mug],
        total: 55,
        clientOrderUuid: 'uuid',
        staffId: cashierId,
        staffName: 'Cash',
        paymentMethod: 'cash',
        tenderedAmount: 55,
        changeDue: 0,
        cartToken: 't1',
        buildFiscalRequest: () => {
          throw new Error('fiscal request could not be built')
        }
      })
    ).toThrow('fiscal request')

    expect(count(db, 'orders')).toBe(0)
    expect(db.listOpenHeldSales()[0].status).toBe('resumed')
  })

  it('does not return to the strip after a restart', () => {
    const path = fileDbPath()
    const first = freshDb(path)
    const { cashierId } = seedStaff(first)
    const held = hold(first, cashierId, 't1')
    first.resumeHeldSale(held.id)
    sell(first, cashierId, 't1', 'cash', [mug, milk], 163)
    first.close()

    expect(freshDb(path).listOpenHeldSales()).toHaveLength(0)
  })

  it('two held sales completed with different payment methods make two separate sales, each with its own total, payment and trader number', () => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)
    const a = hold(db, cashierId, 'cart-a', { items: [mug], total: 99 })
    const b = hold(db, cashierId, 'cart-b', { items: [milk], total: 65 })

    db.resumeHeldSale(b.id)
    const orderB = sell(db, cashierId, 'cart-b', 'mpesa', [milk], 65)
    db.resumeHeldSale(a.id)
    const orderA = sell(db, cashierId, 'cart-a', 'cash', [mug], 99)

    const rows = conn(db)
      .prepare('SELECT local_id, total, payment_method, fiscal_trader_inv_num FROM orders ORDER BY local_id')
      .all()
    const byId = Object.fromEntries(rows.map((row) => [row.local_id as number, row]))

    expect(rows).toHaveLength(2)
    expect(byId[orderB]).toMatchObject({ total: 65, payment_method: 'mpesa' })
    expect(byId[orderA]).toMatchObject({ total: 99, payment_method: 'cash' })
    expect(byId[orderA].fiscal_trader_inv_num).toBeTruthy()
    expect(byId[orderB].fiscal_trader_inv_num).toBeTruthy()
    expect(byId[orderA].fiscal_trader_inv_num).not.toBe(byId[orderB].fiscal_trader_inv_num)
    expect(
      conn(db).prepare("SELECT order_local_id FROM held_sales WHERE cart_token = 'cart-a'").get().order_local_id
    ).toBe(orderA)
    expect(
      conn(db).prepare("SELECT order_local_id FROM held_sales WHERE cart_token = 'cart-b'").get().order_local_id
    ).toBe(orderB)
  })
})

describe('Close Shift', () => {
  it('is refused in the main process while a sale is held, and again while one is resumed', () => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)
    const { shiftId } = db.openShift(cashierId, 1000)
    const held = hold(db, cashierId, 't1')

    // CHANGED (docs/phase-232). OLD: closed at the real clock, straight after opening. NEW: a shift cannot close before its window's
    // last minute, so these close three days on, long after the window ended; the held-sale rule is what is tested.
    const later = Date.now() + 3 * 24 * 60 * 60 * 1000
    const whileHeld = closeShiftUnlessHeld(db, shiftId, 1000, null, later)
    db.resumeHeldSale(held.id)
    const whileResumed = closeShiftUnlessHeld(db, shiftId, 1000, null, later)

    expect(whileHeld.success).toBe(false)
    expect(whileHeld.error).toContain('Customer 1')
    expect(whileResumed.success).toBe(false)
    expect(db.getOpenShift()).not.toBeNull()
  })

  it('goes through once the held sale is completed or discarded', () => {
    const db = freshDb()
    const { cashierId, managerId } = seedStaff(db)
    const { shiftId } = db.openShift(cashierId, 1000)
    const a = hold(db, cashierId, 't1')
    const b = hold(db, cashierId, 't2')
    discardHeldSaleApproved(db, { id: a.id, staffId: cashierId, managerId, managerPin: '2222', reason: 'left' })
    db.resumeHeldSale(b.id)
    sell(db, cashierId, 't2', 'cash', [mug], 99)

    // CHANGED (docs/phase-232): closed three days on, after the window ended (see above).
    const result = closeShiftUnlessHeld(db, shiftId, 1099, null, Date.now() + 3 * 24 * 60 * 60 * 1000)

    expect(result.success).toBe(true)
  })
})
