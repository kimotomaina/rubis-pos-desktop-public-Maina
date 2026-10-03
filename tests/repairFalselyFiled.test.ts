/**
 * docs/phase-212: the one-time start-up repair of sales recorded as filed from the device's all-zero
 * "no invoice" counter. Runs against a real in-memory `RubisDatabase`.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RubisDatabase, FALSELY_FILED_REPAIR_REASON } from '../src/main/services/database.js'
import { hashPin } from '../src/main/services/auth.js'
import type { FiscalInvoiceRequest } from '../src/main/services/integrations/etims.js'
import type { CartItem } from '../src/renderer/src/types/shopify.js'

const ZERO_COUNTER = '0110605040000000000'
const REAL_NUMBER = '0110605040001000809'

const cartItem: CartItem = {
  id: 'gid://shopify/ProductVariant/50346858741863',
  productId: 'gid://shopify/Product/1',
  title: 'test',
  variantTitle: 'Default Title',
  price: 1,
  quantity: 1,
  image: null
}

interface Row {
  fiscalNumber: string
  qr: string
  source: 'device' | 'local-fallback'
}

/** A sale recorded as filed with the given fiscal fields, a serial and a stored request. */
function filedSale(db: RubisDatabase, staffId: number, uuid: string, row: Row): number {
  const request: FiscalInvoiceRequest = {
    clientOrderUuid: uuid,
    items: [{ description: 'test', quantity: 1, unitPrice: 1, taxRate: 0.16 }],
    total: 1,
    taxAmount: 0.14,
    paymentMethod: 'cash'
  }
  const { localId } = db.queueOrder({
    items: [cartItem],
    total: 1,
    clientOrderUuid: uuid,
    staffId,
    staffName: 'Alex',
    paymentMethod: 'cash',
    tenderedAmount: 1,
    changeDue: 0,
    buildFiscalRequest: (id) => ({ ...request, localId: id })
  })
  db.setOrderFiscalInfo(localId, row.fiscalNumber, row.qr, undefined, '2026-10-02T21:37:09.027Z', row.source, 'KRAMW011202207060504')
  db.recordTraderInvNum(localId, `INV-${String(localId).padStart(9, '0')}`)
  db.markFiscalSlipUnprinted(localId)
  return localId
}

function setup(): { db: RubisDatabase; staffId: number } {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  const staffId = db.createStaff({ name: 'Alex', pinHash: hashPin('1234'), role: 'cashier' }).staffId
  return { db, staffId }
}

describe('start-up order (a source pin: index.ts needs Electron to run)', () => {
  const source = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8')

  it('the repair runs after the sweep and before the fiscal engine and every IPC handler exist', () => {
    const sweep = source.indexOf('db.sweepUnqueuedFiscalOrders()')
    const repair = source.indexOf('db.repairFalselyFiledOrders()')
    const engine = source.indexOf('createFiscalEngine(')
    const firstHandler = source.indexOf('ipcMain.handle(')

    expect(sweep).toBeGreaterThan(-1)
    expect(repair).toBeGreaterThan(sweep)
    expect(engine).toBeGreaterThan(repair)
    expect(firstHandler).toBeGreaterThan(repair)
  })
})

describe('repairFalselyFiledOrders', () => {
  it('repairs a sale recorded as filed from the zero counter, and clears exactly the false fiscal fields', () => {
    const { db, staffId } = setup()
    const id = filedSale(db, staffId, 'uuid-false', { fiscalNumber: ZERO_COUNTER, qr: '', source: 'local-fallback' })
    expect(db.getOrder(id)!.fiscal_status).toBe('fiscalized')

    const result = db.repairFalselyFiledOrders()

    expect(result).toEqual({ ran: true, localIds: [id] })
    const order = db.getOrder(id)!
    expect(order.fiscal_status).toBe('needs_fixing')
    expect(order.fiscal_error_kind).toBe('system')
    expect(order.fiscal_error_reason).toBe(FALSELY_FILED_REPAIR_REASON)
    expect(order.fiscal_invoice_number).toBeNull()
    expect(order.fiscal_qr_code).toBeNull()
    expect(order.fiscal_fiscalized_at).toBeNull()
    expect(order.fiscal_fiscalized_at_source).toBeNull()
    expect(order.fiscal_slip_unprinted_at).toBeNull()
  })

  it('keeps what is true: the serial, the trader number and the stored request', () => {
    const { db, staffId } = setup()
    const id = filedSale(db, staffId, 'uuid-false', { fiscalNumber: ZERO_COUNTER, qr: '', source: 'local-fallback' })

    db.repairFalselyFiledOrders()

    const order = db.getOrder(id)!
    expect(order.fiscal_cu_serial).toBe('KRAMW011202207060504')
    expect(order.fiscal_trader_inv_num).toBe(`INV-${String(id).padStart(9, '0')}`)
    expect(JSON.parse(order.fiscal_request_json!).clientOrderUuid).toBe('uuid-false')
  })

  it('leaves a sale the device really filed untouched (device time source and a QR)', () => {
    const { db, staffId } = setup()
    const id = filedSale(db, staffId, 'uuid-real', { fiscalNumber: REAL_NUMBER, qr: 'base64qr', source: 'device' })

    const result = db.repairFalselyFiledOrders()

    expect(result).toEqual({ ran: true, localIds: [] })
    const order = db.getOrder(id)!
    expect(order.fiscal_status).toBe('fiscalized')
    expect(order.fiscal_invoice_number).toBe(REAL_NUMBER)
    expect(order.fiscal_qr_code).toBe('base64qr')
    expect(order.fiscal_fiscalized_at_source).toBe('device')
  })

  it.each([
    ['a zero tail and a local-fallback time, but a QR', { fiscalNumber: ZERO_COUNTER, qr: 'base64qr', source: 'local-fallback' }],
    ['a zero tail and an empty QR, but a device time', { fiscalNumber: ZERO_COUNTER, qr: '', source: 'device' }],
    ['an empty QR and a local-fallback time, but a real number', { fiscalNumber: REAL_NUMBER, qr: '', source: 'local-fallback' }]
  ] as Array<[string, Row]>)('leaves a sale matching only two of the three conditions untouched: %s', (_label, row) => {
    const { db, staffId } = setup()
    const id = filedSale(db, staffId, 'uuid-partial', row)

    const result = db.repairFalselyFiledOrders()

    expect(result.localIds).toEqual([])
    const order = db.getOrder(id)!
    expect(order.fiscal_status).toBe('fiscalized')
    expect(order.fiscal_invoice_number).toBe(row.fiscalNumber)
  })

  it('leaves a sale that is not `fiscalized` untouched, even with the same fields', () => {
    const { db, staffId } = setup()
    const id = filedSale(db, staffId, 'uuid-waiting', { fiscalNumber: ZERO_COUNTER, qr: '', source: 'local-fallback' })
    db.setOrderFiscalFailure(id, 'waiting', 'device unreachable', 'technical')

    const result = db.repairFalselyFiledOrders()

    expect(result.localIds).toEqual([])
    expect(db.getOrder(id)!.fiscal_status).toBe('waiting')
  })

  it('repairs only the false sale when a real one sits beside it', () => {
    const { db, staffId } = setup()
    const real = filedSale(db, staffId, 'uuid-real', { fiscalNumber: REAL_NUMBER, qr: 'base64qr', source: 'device' })
    const bad = filedSale(db, staffId, 'uuid-false', { fiscalNumber: ZERO_COUNTER, qr: '', source: 'local-fallback' })

    const result = db.repairFalselyFiledOrders()

    expect(result.localIds).toEqual([bad])
    expect(db.getOrder(real)!.fiscal_status).toBe('fiscalized')
    expect(db.getOrder(bad)!.fiscal_status).toBe('needs_fixing')
  })

  it('runs once: the second call changes nothing and does not even run the update', () => {
    const { db, staffId } = setup()
    const first = filedSale(db, staffId, 'uuid-false-1', { fiscalNumber: ZERO_COUNTER, qr: '', source: 'local-fallback' })
    expect(db.repairFalselyFiledOrders().localIds).toEqual([first])
    const ranAt = db.getSetting('repair_212_ran_at')
    expect(ranAt).toBeTruthy()

    // A matching row that appears after the first run must be left alone by the second.
    const later = filedSale(db, staffId, 'uuid-false-2', { fiscalNumber: '9999999999000000000', qr: '', source: 'local-fallback' })
    const second = db.repairFalselyFiledOrders()

    expect(second).toEqual({ ran: false, localIds: [] })
    expect(db.getOrder(later)!.fiscal_status).toBe('fiscalized')
    expect(db.getSetting('repair_212_ran_at')).toBe(ranAt)
  })

  it('records that it ran even when nothing matched, so a clean till is not scanned again', () => {
    const { db } = setup()

    expect(db.repairFalselyFiledOrders()).toEqual({ ran: true, localIds: [] })
    expect(db.getSetting('repair_212_ran_at')).toBeTruthy()
    expect(db.repairFalselyFiledOrders().ran).toBe(false)
  })

  it('moves the repaired sale into the Needs Attention list', () => {
    const { db, staffId } = setup()
    const id = filedSale(db, staffId, 'uuid-false', { fiscalNumber: ZERO_COUNTER, qr: '', source: 'local-fallback' })

    db.repairFalselyFiledOrders()

    const flagged = db.getOrdersNeedingAttention(Date.now(), 15 * 60_000).map((row) => row.local_id)
    expect(flagged).toContain(id)
  })
})
