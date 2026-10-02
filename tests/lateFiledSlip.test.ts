/**
 * A sale filed after the customer left (docs/phase-198): the fiscal engine's
 * callback, the one-time ORIGINAL print guarded by `receipt_printed_at`, the
 * Needs Attention flag when the slip cannot be printed, the append-only reprint
 * log, and the upgrade of an older database.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createFiscalEngine } from '../src/main/services/fiscal-engine.js'
import type { FiscalEngineDatabase } from '../src/main/services/fiscal-engine.js'
import { printLateFiledSlip } from '../src/main/services/late-filed-slip.js'
import { RubisDatabase } from '../src/main/services/database.js'
import type { FiscalQueueItem } from '../src/main/services/database.js'
import type { FiscalInvoiceRequest, FiscalSubmitOutcome } from '../src/main/services/integrations/etims.js'
import type { ReceiptPrintResult } from '../src/main/services/printer.js'
import type { ServiceResult } from '../src/main/services/shopify-types.js'
import { freshDb, seedSale } from './helpers/slipOrders.js'

const silent = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as never

describe('the fiscal engine calls onFiled after a queued filing', () => {
  const item = (id: number): FiscalQueueItem => ({
    id,
    entity_type: 'etims_invoice',
    entity_id: id + 100,
    action: 'fiscalizeInvoice',
    payload: { clientOrderUuid: `u${id}`, items: [{ description: 'Bread', quantity: 1, unitPrice: 60, taxRate: 0.16 }], total: 60, taxAmount: 8 },
    attempts: 0,
    last_error: null,
    created_at: '2026-08-24T10:00:00.000Z',
    next_attempt_at: 0
  })
  const OK: FiscalSubmitOutcome = {
    ok: true,
    data: { invoiceNumber: 'KRA-1', qrCode: 'qr', fiscalizedAt: '2026-08-24T10:00:00.000Z' }
  }

  function engineWith(items: FiscalQueueItem[], submit: (r: FiscalInvoiceRequest) => Promise<FiscalSubmitOutcome>, onFiled?: (id: number) => void) {
    const db = {
      getPendingFiscalQueue: vi.fn(() => items),
      markFiscalQueueItemSynced: vi.fn(),
      recordFiscalQueueFailure: vi.fn(() => ({ exhausted: false })),
      removeFiscalQueueItem: vi.fn(),
      setOrderFiscalFailure: vi.fn(),
      getOrder: vi.fn(() => undefined)
    }
    const engine = createFiscalEngine({
      db: db as unknown as FiscalEngineDatabase,
      submitInvoice: submit as never,
      now: () => 1_700_000_000_000,
      logger: silent,
      onFiled
    })
    return { db, engine }
  }

  it('is called with the sale id once the filing is stored, and not for a failure', async () => {
    const onFiled = vi.fn()
    const outcomes = [OK, { ok: false, reason: 'device busy', kind: 'technical', retryable: true } as FiscalSubmitOutcome]
    const { db, engine } = engineWith([item(1), item(2)], async () => outcomes.shift() as FiscalSubmitOutcome, onFiled)

    await engine.tick()

    expect(onFiled).toHaveBeenCalledTimes(1)
    expect(onFiled).toHaveBeenCalledWith(101)
    expect(db.markFiscalQueueItemSynced.mock.invocationCallOrder[0]).toBeLessThan(onFiled.mock.invocationCallOrder[0])
  })

  it('a callback that throws does not stop the queue', async () => {
    const onFiled = vi.fn(() => {
      throw new Error('printer exploded')
    })
    const { db, engine } = engineWith([item(1), item(2)], async () => OK, onFiled)

    await engine.tick()

    expect(db.markFiscalQueueItemSynced).toHaveBeenCalledTimes(2)
    expect(onFiled).toHaveBeenCalledTimes(2)
  })

  it('works with no callback at all', async () => {
    const { db, engine } = engineWith([item(1)], async () => OK)

    await engine.tick()

    expect(db.markFiscalQueueItemSynced).toHaveBeenCalledTimes(1)
  })
})

describe('printLateFiledSlip', () => {
  const onPaper: ServiceResult<ReceiptPrintResult> = { success: true, data: { printed: true, mock: false } }
  const viaPdf: ServiceResult<ReceiptPrintResult> = { success: true, data: { printed: false, mock: false, mode: 'pdf' } }

  function filedSale() {
    const db = freshDb()
    const { localId } = seedSale(db)
    db.setOrderFiscalInfo(localId, '0123456789012345678', 'https://example.invalid/q', undefined, '2026-10-02T10:00:00.000Z', 'device', 'CU-1')
    return { db, localId }
  }

  it('prints the fiscal slip once as the original, then marks it, so a second call prints nothing', async () => {
    const { db, localId } = filedSale()
    const printFiscalSlip = vi.fn(async () => onPaper)

    await printLateFiledSlip({ db, printFiscalSlip, logger: silent }, localId)
    await printLateFiledSlip({ db, printFiscalSlip, logger: silent }, localId)

    expect(printFiscalSlip).toHaveBeenCalledTimes(1)
    expect(db.hasReceiptPrinted(localId)).toBe(true)
    expect(db.getOrder(localId)?.fiscal_slip_unprinted_at ?? null).toBeNull()
  })

  it('does not print a slip that already went out at checkout', async () => {
    const { db, localId } = filedSale()
    db.markReceiptPrinted(localId)
    const printFiscalSlip = vi.fn(async () => onPaper)

    await printLateFiledSlip({ db, printFiscalSlip, logger: silent }, localId)

    expect(printFiscalSlip).not.toHaveBeenCalled()
    expect(db.getUnprintedFiscalSlips()).toEqual([])
  })

  it('does nothing for a sale that is not filed, or that does not exist', async () => {
    const db = freshDb()
    const { localId } = seedSale(db)
    const printFiscalSlip = vi.fn(async () => onPaper)

    await printLateFiledSlip({ db, printFiscalSlip, logger: silent }, localId)
    await printLateFiledSlip({ db, printFiscalSlip, logger: silent }, 9999)

    expect(printFiscalSlip).not.toHaveBeenCalled()
  })

  it.each([
    ['only a PDF was saved', async () => viaPdf],
    ['the printer failed', async () => ({ success: false, error: 'Printer unreachable' }) as ServiceResult<ReceiptPrintResult>],
    [
      'printing threw',
      async (): Promise<ServiceResult<ReceiptPrintResult>> => {
        throw new Error('spooler is down')
      }
    ]
  ])('flags the sale for Needs Attention when %s, tries once, and never retries', async (_name, outcome) => {
    const { db, localId } = filedSale()
    const printFiscalSlip = vi.fn(outcome)

    await printLateFiledSlip({ db, printFiscalSlip, logger: silent }, localId)

    expect(printFiscalSlip).toHaveBeenCalledTimes(1)
    expect(db.hasReceiptPrinted(localId)).toBe(false)
    expect(db.getUnprintedFiscalSlips().map((row) => row.local_id)).toEqual([localId])
  })

  it('takes the sale off the list when its slip is later printed from Order History', async () => {
    const { db, localId } = filedSale()
    await printLateFiledSlip({ db, printFiscalSlip: async () => viaPdf, logger: silent }, localId)
    expect(db.getUnprintedFiscalSlips()).toHaveLength(1)

    db.markReceiptPrinted(localId)

    expect(db.getUnprintedFiscalSlips()).toEqual([])
    expect(db.getOrder(localId)?.fiscal_slip_unprinted_at ?? null).toBeNull()
  })
})

describe('the Needs Attention list of unprinted tax invoices', () => {
  it('lists the oldest first with the cashier, and leaves out a voided sale', () => {
    const db = freshDb()
    const first = seedSale(db).localId
    const second = seedSale(db).localId
    for (const id of [first, second]) db.setOrderFiscalInfo(id, `INV${id}`, 'qr')
    db.markFiscalSlipUnprinted(second)
    db.markFiscalSlipUnprinted(first)

    const rows = db.getUnprintedFiscalSlips()

    expect(rows.map((r) => r.local_id)).toEqual([first, second])
    expect(rows[0].staff_name).toBe('Mary Wanjiku')
    expect(rows[0].total).toBe(60)
  })

  it('keeps the first time a sale was flagged', () => {
    const db = freshDb()
    const { localId } = seedSale(db)
    db.setOrderFiscalInfo(localId, 'INV1', 'qr')

    db.markFiscalSlipUnprinted(localId)
    const first = db.getOrder(localId)?.fiscal_slip_unprinted_at
    db.markFiscalSlipUnprinted(localId)

    expect(db.getOrder(localId)?.fiscal_slip_unprinted_at).toBe(first)
  })

  it('never flags a sale whose slip was already printed', () => {
    const db = freshDb()
    const { localId } = seedSale(db)
    db.setOrderFiscalInfo(localId, 'INV1', 'qr')
    db.markReceiptPrinted(localId)

    db.markFiscalSlipUnprinted(localId)

    expect(db.getUnprintedFiscalSlips()).toEqual([])
  })
})

describe('receipt_reprints', () => {
  it('appends one row per reprint, with the order, slip, staff and time', () => {
    const db = freshDb()
    const { localId, staffId } = seedSale(db)

    db.recordReceiptReprint({ order_id: localId, slip: 'fiscal', staff_id: staffId, at: '2026-10-02T10:00:00.000Z' })
    db.recordReceiptReprint({ order_id: localId, slip: 'enjoy', staff_id: null })

    const rows = db.listReceiptReprints()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ order_id: localId, slip: 'fiscal', staff_id: staffId, at: '2026-10-02T10:00:00.000Z' })
    expect(rows[1]).toMatchObject({ slip: 'enjoy', staff_id: null })
    expect(rows[1].at).toBeTruthy()
  })

  it('refuses a slip other than fiscal or enjoy', () => {
    const db = freshDb()

    expect(() => db.recordReceiptReprint({ order_id: 1, slip: 'other' as never, staff_id: null })).toThrow()
  })

  it('has no way to change or remove a row', () => {
    const methods = Object.getOwnPropertyNames(RubisDatabase.prototype).filter((name) => /reprint/i.test(name))

    expect(methods.sort()).toEqual(['listReceiptReprints', 'recordReceiptReprint'])
  })
})

describe('an older database', () => {
  const files: string[] = []
  afterEach(() => {
    for (const file of files.splice(0)) for (const suffix of ['', '-wal', '-shm']) if (existsSync(file + suffix)) rmSync(file + suffix)
  })

  /** The orders table as it was before this phase: none of the two new columns, nor receipt_printed_at. */
  const OLD_ORDERS = `CREATE TABLE orders (
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
    reference_number REAL,
    shift_id INTEGER,
    fiscal_invoice_number TEXT,
    fiscal_qr_code TEXT,
    fiscal_fiscalized_at TEXT,
    fiscal_status TEXT,
    fiscal_error_reason TEXT,
    fiscal_error_kind TEXT,
    fiscal_request_json TEXT,
    fiscal_data_issue TEXT,
    fiscal_vat_groups_json TEXT
  )`

  it('gains both columns and the reprint table, keeps its rows, and reads the new columns as empty', () => {
    const path = join(tmpdir(), `rubis-phase198-${Date.now()}-${Math.random().toString(16).slice(2)}.db`)
    files.push(path)
    const old = new BetterSqlite3(path)
    old.exec(OLD_ORDERS)
    old
      .prepare("INSERT INTO orders (total, status, created_at, fiscal_invoice_number, fiscal_status) VALUES (60, 'synced', '2026-09-01T10:00:00.000Z', 'OLD-1', 'fiscalized')")
      .run()
    old.close()

    const db = new RubisDatabase({ dbPath: path })
    db.init()
    try {
      const order = db.getOrder(1)
      expect(order?.fiscal_invoice_number).toBe('OLD-1')
      expect(order?.fiscal_trader_inv_num ?? null).toBeNull()
      expect(order?.fiscal_slip_unprinted_at ?? null).toBeNull()
      db.recordTraderInvNum(1, 'INV-000000001')
      expect(db.getOrder(1)?.fiscal_trader_inv_num).toBe('INV-000000001')
      expect(db.listReceiptReprints()).toEqual([])
    } finally {
      db.close()
    }
  })
})
