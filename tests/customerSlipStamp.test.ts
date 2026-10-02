/**
 * The Enjoy slip's DUPLICATE stamp follows its own record (docs/phase-198-1):
 * `orders.customer_slip_printed_at`, written once when the slip first reaches
 * paper. Driven through the same `slipStamps` and `recordSlipOutcome` the
 * `receipt:print` handler calls, with the real printing code and a real database.
 */

import { describe, it, expect, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildPrinterRegistry, printOrderSlips } from '../src/main/services/printer.js'
import type { OrderSlipSelection, OrderSlipsResult, PrinterSettings, ReceiptOrder } from '../src/main/services/printer.js'
import { recordSlipOutcome, slipStamps } from '../src/main/services/slip-records.js'
import { RubisDatabase } from '../src/main/services/database.js'
import { freshDb, seedSale } from './helpers/slipOrders.js'
import { recordingPrinter } from './helpers/recordingPrinter.js'

const SETTINGS: PrinterSettings = { interfaceName: 'tcp://x', storeName: 'ENJOY', taxRate: 0.16 }
const ITEMS = [{ title: 'RUBIS Mug', variantTitle: 'Small', quantity: 1, unitPrice: 60 }]
const BASE: ReceiptOrder = {
  localId: 1,
  createdAt: new Date(2026, 8, 27, 18, 58).toISOString(),
  cashierName: 'Mary Wanjiku',
  paymentMethod: 'cash',
  tenderedAmount: 100,
  changeDue: 40,
  total: 60,
  fiscalPending: true
}
const registry = buildPrinterRegistry([])

/** One print, the way the handler does it: stamps from the records, print, record what reached paper. */
async function printSale(
  db: RubisDatabase,
  localId: number,
  factory: () => import('../src/main/services/printer.js').ThermalPrinterLike,
  options: { auto?: boolean; fiscalOnly?: boolean; slips?: OrderSlipSelection } = {}
): Promise<OrderSlipsResult> {
  const row = db.getOrder(localId)!
  const printed = await printOrderSlips(
    { ...BASE, localId, ...slipStamps(db, row) },
    ITEMS,
    registry,
    SETTINGS,
    options.slips ?? { fiscal: true, customer: !options.fiscalOnly },
    'receipt',
    factory,
    async () => 'C:/x.pdf'
  )
  recordSlipOutcome(db, row, printed, { auto: options.auto, fiscalOnly: options.fiscalOnly, staffId: 1 })
  return printed
}

const customerIsDuplicate = (jobs: Array<{ lines: string[] }>, job: number): boolean =>
  jobs[job].lines[0] === '*** DUPLICATE ***'

describe('the customer slip stamp', () => {
  it('an automatic print that succeeds makes a later manual reprint a DUPLICATE', async () => {
    const db = freshDb()
    const { localId } = seedSale(db)
    const first = recordingPrinter()
    const second = recordingPrinter()

    await printSale(db, localId, first.factory, { auto: true })
    await printSale(db, localId, second.factory)

    expect(customerIsDuplicate(first.jobs, 1)).toBe(false)
    expect(first.jobs[1].lines[0]).toBe('E N J O Y')
    expect(customerIsDuplicate(second.jobs, 1)).toBe(true)
    expect(db.getOrder(localId)?.customer_slip_printed_at).toBeTruthy()
  })

  it('an automatic customer slip that fails: the manual print is not a DUPLICATE, the next one is', async () => {
    const db = freshDb()
    const { localId } = seedSale(db)
    const failing = recordingPrinter((job) => (job === 2 ? 'error' : null))
    const manual = recordingPrinter()
    const next = recordingPrinter()

    await printSale(db, localId, failing.factory, { auto: true })
    expect(db.getOrder(localId)?.customer_slip_printed_at ?? null).toBeNull()
    await printSale(db, localId, manual.factory)
    await printSale(db, localId, next.factory)

    expect(manual.jobs[1].lines[0]).toBe('E N J O Y')
    expect(customerIsDuplicate(manual.jobs, 1)).toBe(false)
    expect(customerIsDuplicate(next.jobs, 1)).toBe(true)
  })

  it('a PDF fallback does not set the column: with the printer out, the fiscal slip is a PDF and the customer slip does not print', async () => {
    const db = freshDb()
    const { localId } = seedSale(db)
    const offline = recordingPrinter(() => 'offline')

    const printed = await printSale(db, localId, offline.factory, { auto: true })

    expect(printed.fiscal?.success && printed.fiscal.data?.mode).toBe('pdf')
    expect(db.getOrder(localId)?.customer_slip_printed_at ?? null).toBeNull()
  })

  it('a customer result that is a PDF never sets the column', () => {
    const db = freshDb()
    const { localId } = seedSale(db)

    recordSlipOutcome(
      db,
      db.getOrder(localId)!,
      { fiscal: null, customer: { success: true, data: { printed: false, mock: false, mode: 'pdf' } } },
      { auto: true }
    )

    expect(db.getOrder(localId)?.customer_slip_printed_at ?? null).toBeNull()
  })

  it('a fiscal-only print leaves the column alone', async () => {
    const db = freshDb()
    const { localId } = seedSale(db)

    await printSale(db, localId, recordingPrinter().factory, { fiscalOnly: true })

    expect(db.getOrder(localId)?.customer_slip_printed_at ?? null).toBeNull()
  })

  it('is write-once: a later successful print keeps the first time', async () => {
    const db = freshDb()
    const { localId } = seedSale(db)
    await printSale(db, localId, recordingPrinter().factory, { auto: true })
    const first = db.getOrder(localId)?.customer_slip_printed_at

    await printSale(db, localId, recordingPrinter().factory)

    expect(db.getOrder(localId)?.customer_slip_printed_at).toBe(first)
  })

  it('does not depend on which button was pressed: a manual first print is an original', async () => {
    const db = freshDb()
    const { localId } = seedSale(db)
    const only = recordingPrinter()

    await printSale(db, localId, only.factory)

    expect(customerIsDuplicate(only.jobs, 1)).toBe(false)
  })

  it('keeps the fiscal-side stamp on its own record: the customer slip printing does not make the sale record a DUPLICATE', async () => {
    const db = freshDb()
    const { localId } = seedSale(db)
    const second = recordingPrinter()

    await printSale(db, localId, recordingPrinter().factory, { auto: true })
    await printSale(db, localId, second.factory)

    expect(second.jobs[0].lines[0]).not.toBe('*** DUPLICATE ***')
    expect(db.hasReceiptPrinted(localId)).toBe(false)
  })
})

describe('an older database', () => {
  const files: string[] = []
  afterEach(() => {
    for (const file of files.splice(0)) for (const suffix of ['', '-wal', '-shm']) if (existsSync(file + suffix)) rmSync(file + suffix)
  })

  it('gains customer_slip_printed_at, empty, and keeps its rows', () => {
    const path = join(tmpdir(), `rubis-phase1981-${Date.now()}-${Math.random().toString(16).slice(2)}.db`)
    files.push(path)
    const old = new BetterSqlite3(path)
    old.exec(`CREATE TABLE orders (
      local_id INTEGER PRIMARY KEY AUTOINCREMENT, shopify_order_id TEXT, total REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_sync' CHECK (status IN ('pending_sync', 'synced', 'failed', 'voided')),
      created_at TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', staff_id INTEGER, payment_method TEXT,
      tendered_amount REAL, change_due REAL, reference_number TEXT, shift_id INTEGER, fiscal_invoice_number TEXT,
      fiscal_qr_code TEXT, fiscal_fiscalized_at TEXT, fiscal_status TEXT, fiscal_error_reason TEXT,
      fiscal_error_kind TEXT, fiscal_request_json TEXT, fiscal_data_issue TEXT, fiscal_vat_groups_json TEXT)`)
    old.prepare("INSERT INTO orders (total, status, created_at) VALUES (60, 'synced', '2026-09-01T10:00:00.000Z')").run()
    old.close()

    const db = new RubisDatabase({ dbPath: path })
    db.init()
    try {
      expect(db.getOrder(1)?.total).toBe(60)
      expect(db.getOrder(1)?.customer_slip_printed_at ?? null).toBeNull()
      db.markCustomerSlipPrinted(1)
      expect(db.getOrder(1)?.customer_slip_printed_at).toBeTruthy()
    } finally {
      db.close()
    }
  })
})
