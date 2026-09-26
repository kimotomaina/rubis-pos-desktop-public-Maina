/**
 * End-of-day report + manager "Approve day" (docs/phase-150.md deferred
 * approval to this; docs/phase-151/152 design it — see docs/phase-15x.md
 * for this step's own report).
 *
 * Real SQLite throughout, not the lightweight fake `reports.test.ts` uses
 * for `generateZReport`/`generateDailySummary` — several of the required
 * behaviors here (a real join across `orders`/`mpesa_payments`, a real
 * transaction rolling back, a real UNIQUE/autoincrement sequence) are
 * precisely what a mock cannot exercise honestly.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { RubisDatabase } from '../src/main/services/database.js'
import type { QueueOrderInput, RecordMpesaPaymentInput } from '../src/main/services/database.js'
import { hashPin } from '../src/main/services/auth.js'
import {
  generateEndOfDayReport,
  getLocalDayRange,
  localDayOf
} from '../src/main/services/reports.js'
import type { CartItem } from '../src/renderer/src/types/shopify.js'

function freshDb(): RubisDatabase {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  return db
}

function seedStaff(db: RubisDatabase): { ann: number; bob: number; manager: number } {
  return {
    ann: db.createStaff({ name: 'Ann', pinHash: hashPin('1111'), role: 'cashier' }).staffId,
    bob: db.createStaff({ name: 'Bob', pinHash: hashPin('2222'), role: 'cashier' }).staffId,
    manager: db.createStaff({ name: 'Manager Mo', pinHash: hashPin('9999'), role: 'admin' }).staffId
  }
}

const cartItem: CartItem = {
  id: 'gid://shopify/ProductVariant/1',
  productId: 'gid://shopify/Product/1',
  title: 'Item',
  variantTitle: 'Default',
  price: 100,
  quantity: 1,
  image: null
}

let uuidCounter = 0
function orderInput(overrides: Partial<QueueOrderInput> = {}): QueueOrderInput {
  uuidCounter += 1
  return {
    items: [cartItem],
    total: 100,
    clientOrderUuid: `uuid-${uuidCounter}`,
    staffId: 1,
    staffName: 'Cashier',
    paymentMethod: 'cash',
    tenderedAmount: 100,
    changeDue: 0,
    ...overrides
  }
}

/** Runs `fn` with the system clock frozen at `iso`, then restores real time. */
function at<T>(iso: string, fn: () => T): T {
  vi.useFakeTimers().setSystemTime(new Date(iso))
  try {
    return fn()
  } finally {
    vi.useRealTimers()
  }
}

afterEach(() => {
  vi.useRealTimers()
})

function seedCash(
  db: RubisDatabase,
  staffId: number,
  total: number,
  iso: string
): { localId: number } {
  return at(iso, () =>
    db.queueOrder(orderInput({ staffId, total, tenderedAmount: total, paymentMethod: 'cash' }))
  )
}

function seedManual(
  db: RubisDatabase,
  staffId: number,
  amount: number,
  reference: string,
  iso: string
): { localId: number } | null {
  return at(iso, () =>
    db.queueOrderRecordingManualPayment(
      orderInput({ staffId, total: amount, tenderedAmount: amount, paymentMethod: 'mpesa' }),
      {
        mode: 'manual',
        verificationStatus: 'manual_unverified',
        reference,
        amount,
        enteredByStaffId: staffId,
        approvedByStaffId: null
      } satisfies RecordMpesaPaymentInput
    )
  )
}

function seedDaraja(
  db: RubisDatabase,
  staffId: number,
  amount: number,
  reference: string,
  iso: string
): { localId: number } {
  return at(iso, () =>
    db.queueOrderRecordingMpesaPayment(
      orderInput({ staffId, total: amount, tenderedAmount: amount, paymentMethod: 'mpesa' }),
      {
        mode: 'daraja',
        verificationStatus: 'confirmed',
        reference,
        amount,
        enteredByStaffId: staffId
      } satisfies RecordMpesaPaymentInput
    )
  )
}

describe('getLocalDayRange / localDayOf — Africa/Nairobi (UTC+3, no DST)', () => {
  it('returns the UTC [start, end) pair for one Nairobi calendar day', () => {
    const { startIso, endIso } = getLocalDayRange('2026-09-10')
    expect(startIso).toBe('2026-09-09T21:00:00.000Z')
    expect(endIso).toBe('2026-09-10T21:00:00.000Z')
  })

  it('maps a UTC instant just after Nairobi midnight to that Nairobi day', () => {
    // 2026-09-10T00:30:00 Nairobi == 2026-09-09T21:30:00Z.
    expect(localDayOf('2026-09-09T21:30:00.000Z')).toBe('2026-09-10')
  })

  it('maps a UTC instant just before Nairobi midnight to the same Nairobi day, not the next', () => {
    // 2026-09-10T23:59:00 Nairobi == 2026-09-10T20:59:00Z.
    expect(localDayOf('2026-09-10T20:59:00.000Z')).toBe('2026-09-10')
    // One minute later crosses into the next Nairobi day.
    expect(localDayOf('2026-09-10T21:00:00.000Z')).toBe('2026-09-11')
  })
})

describe('generateEndOfDayReport', () => {
  it("sums each cashier's totals by method, splits M-Pesa by mode, and excludes voided orders", () => {
    const db = freshDb()
    const { ann, bob } = seedStaff(db)

    seedCash(db, ann, 50, '2026-09-10T09:00:00.000Z')
    seedManual(db, ann, 60, 'ABC1111111', '2026-09-10T10:00:00.000Z')
    seedDaraja(db, ann, 70, 'DEF2222222', '2026-09-10T11:00:00.000Z')
    const voided = seedCash(db, bob, 999, '2026-09-10T12:00:00.000Z')
    db.voidOrder(voided.localId)
    seedManual(db, bob, 40, 'GHI3333333', '2026-09-10T13:00:00.000Z')

    const report = generateEndOfDayReport(db, '2026-09-10')

    const annRow = report.cashiers.find((c) => c.staffId === ann)!
    expect(annRow.orderCount).toBe(3)
    expect(annRow.totalsByMethod).toEqual({ cash: 50, mpesa: 130, card: 0 })
    expect(annRow.mpesaByMode).toEqual({ manual: 60, daraja: 70 })

    const bobRow = report.cashiers.find((c) => c.staffId === bob)!
    expect(bobRow.orderCount).toBe(1) // the voided cash sale does not count
    expect(bobRow.totalsByMethod).toEqual({ cash: 0, mpesa: 40, card: 0 })
    expect(bobRow.mpesaByMode).toEqual({ manual: 40, daraja: 0 })

    expect(report.totalsByMethod).toEqual({ cash: 50, mpesa: 170, card: 0 })
  })

  it('a sale at 00:30 Nairobi time lands on that Nairobi day, not the previous one', () => {
    const db = freshDb()
    const { ann } = seedStaff(db)
    seedCash(db, ann, 25, '2026-09-09T21:30:00.000Z') // 00:30 on the 10th, Nairobi

    expect(generateEndOfDayReport(db, '2026-09-10').cashiers[0]?.totalsByMethod.cash).toBe(25)
    expect(generateEndOfDayReport(db, '2026-09-09').cashiers).toEqual([])
  })

  it('a sale at 23:59 Nairobi time stays on that day and does not leak into the next', () => {
    const db = freshDb()
    const { ann } = seedStaff(db)
    seedCash(db, ann, 35, '2026-09-10T20:59:00.000Z') // 23:59 on the 10th, Nairobi

    expect(generateEndOfDayReport(db, '2026-09-10').cashiers[0]?.totalsByMethod.cash).toBe(35)
    expect(generateEndOfDayReport(db, '2026-09-11').cashiers).toEqual([])
  })

  it('surfaces an unapproved manual entry from an earlier day as carry-over, labeled with its own day', () => {
    const db = freshDb()
    const { ann } = seedStaff(db)
    seedManual(db, ann, 20, 'EEE5555555', '2026-09-08T09:00:00.000Z')

    const report = generateEndOfDayReport(db, '2026-09-10')

    expect(report.manualEntries).toEqual([])
    expect(report.carryOver).toHaveLength(1)
    expect(report.carryOver[0].localDay).toBe('2026-09-08')
    expect(report.pendingIds).toEqual([report.carryOver[0].paymentId])
    expect(report.pendingManualTotal).toBe(20)
  })

  it('an entry reconciled one-by-one on the old Reconciliation page shows as approved, and is excluded from pendingIds', () => {
    const db = freshDb()
    const { ann, manager } = seedStaff(db)
    seedManual(db, ann, 30, 'FFF6666666', '2026-09-10T09:00:00.000Z')

    const paymentId = db.listUnreconciledMpesaPayments()[0].id
    db.markMpesaPaymentReconciled(paymentId, manager, 'checked against the statement')

    const report = generateEndOfDayReport(db, '2026-09-10')
    const entry = report.manualEntries[0]
    expect(entry.approved).toBe(true)
    expect(entry.reconciledByStaffId).toBe(manager)
    expect(report.pendingIds).toEqual([])
  })
})

describe('RubisDatabase.approveMpesaEntries', () => {
  it('approves exactly the pending ids given and records one approval covering them', () => {
    const db = freshDb()
    const { ann, manager } = seedStaff(db)
    seedManual(db, ann, 60, 'AAA1111111', '2026-09-10T09:00:00.000Z')
    seedManual(db, ann, 40, 'BBB2222222', '2026-09-10T09:10:00.000Z')
    const report = generateEndOfDayReport(db, '2026-09-10')

    const result = db.approveMpesaEntries(report.pendingIds, [], manager, '2026-09-10', 'end of day')

    expect(result.alreadyApproved).toBe(false)
    expect(result.approvedCount).toBe(2)
    expect(result.approval?.entry_count).toBe(2)
    expect(result.approval?.total_amount).toBe(100)
    expect(result.approval?.approved_by_staff_id).toBe(manager)
    expect(result.approval?.note).toBe('end of day')

    const after = generateEndOfDayReport(db, '2026-09-10')
    expect(after.pendingIds).toEqual([])
    expect(after.manualEntries.every((e) => e.approved)).toBe(true)
  })

  it('does not approve an entry recorded after the report was generated — it appears, still pending, on the next report', () => {
    const db = freshDb()
    const { ann, manager } = seedStaff(db)
    seedManual(db, ann, 60, 'CCC3333333', '2026-09-10T09:00:00.000Z')
    const reportBefore = generateEndOfDayReport(db, '2026-09-10')
    expect(reportBefore.pendingIds).toHaveLength(1)

    // A second sale lands after the report was generated but before it is approved.
    seedManual(db, ann, 45, 'DDD4444444', '2026-09-10T09:05:00.000Z')

    const result = db.approveMpesaEntries(reportBefore.pendingIds, [], manager, '2026-09-10', null)
    expect(result.approvedCount).toBe(1)

    const reportAfter = generateEndOfDayReport(db, '2026-09-10')
    const late = reportAfter.manualEntries.find((e) => e.reference === 'DDD4444444')!
    expect(late.approved).toBe(false)
    expect(reportAfter.pendingIds).toEqual([late.paymentId])
  })

  it('a second approval of the same ids changes nothing and reports "already approved", backed by the earlier approval record', () => {
    const db = freshDb()
    const { ann, manager } = seedStaff(db)
    seedManual(db, ann, 60, 'EEE5555555', '2026-09-10T09:00:00.000Z')
    const report = generateEndOfDayReport(db, '2026-09-10')

    const first = db.approveMpesaEntries(report.pendingIds, [], manager, '2026-09-10', 'first pass')
    expect(first.alreadyApproved).toBe(false)

    const second = db.approveMpesaEntries(report.pendingIds, [], manager, '2026-09-10', 'second pass')
    expect(second.alreadyApproved).toBe(true)
    expect(second.approvedCount).toBe(0)
    expect(second.approval?.id).toBe(first.approval?.id)
    // The second attempt's note never overwrote the first approval's.
    expect(second.approval?.note).toBe('first pass')
  })

  it('reports "already approved" with no specific record when the ids were settled by the older per-payment reconcile, not a day approval', () => {
    const db = freshDb()
    const { ann, manager } = seedStaff(db)
    seedManual(db, ann, 30, 'FFF6666666', '2026-09-10T09:00:00.000Z')
    const paymentId = db.listUnreconciledMpesaPayments()[0].id
    db.markMpesaPaymentReconciled(paymentId, manager, 'checked against the statement')

    const result = db.approveMpesaEntries([paymentId], [], manager, '2026-09-10', null)

    expect(result.alreadyApproved).toBe(true)
    expect(result.approvedCount).toBe(0)
    expect(result.approval).toBeNull()
  })

  it('rolls back the whole approval — including the mpesa_day_approvals row — when the update itself fails', () => {
    const db = freshDb()
    const { ann, manager } = seedStaff(db)
    seedManual(db, ann, 60, 'GGG7777777', '2026-09-10T09:00:00.000Z')
    const report = generateEndOfDayReport(db, '2026-09-10')

    const spy = vi
      .spyOn(db as unknown as { markMpesaPaymentsApproved: () => void }, 'markMpesaPaymentsApproved')
      .mockImplementation(() => {
        throw new Error('simulated failure mid-transaction')
      })

    expect(() =>
      db.approveMpesaEntries(report.pendingIds, [], manager, '2026-09-10', null)
    ).toThrow('simulated failure mid-transaction')
    spy.mockRestore()

    // No partial approval: the payment is still unreconciled...
    const after = generateEndOfDayReport(db, '2026-09-10')
    expect(after.pendingIds).toEqual(report.pendingIds)
    // ...and the mpesa_day_approvals insert rolled back too — better-sqlite3's
    // transaction() undoes everything since the last commit on any throw,
    // including the AUTOINCREMENT sequence, so id 1 was never left behind.
    expect(db.getMpesaDayApprovalById(1)).toBeUndefined()

    // A real, non-forced retry still succeeds — the failure above did not
    // corrupt anything.
    const retried = db.approveMpesaEntries(report.pendingIds, [], manager, '2026-09-10', null)
    expect(retried.approvedCount).toBe(1)
  })

  it('rolls back the exclusion rows too when the update fails mid-transaction', () => {
    const db = freshDb()
    const { ann, manager } = seedStaff(db)
    seedManual(db, ann, 60, 'HHH8888888', '2026-09-10T09:00:00.000Z')
    seedManual(db, ann, 25, 'III9999999', '2026-09-10T09:05:00.000Z')
    const report = generateEndOfDayReport(db, '2026-09-10')
    const [approveId, excludeId] = report.pendingIds

    const spy = vi
      .spyOn(db as unknown as { markMpesaPaymentsApproved: () => void }, 'markMpesaPaymentsApproved')
      .mockImplementation(() => {
        throw new Error('simulated failure mid-transaction')
      })

    expect(() =>
      db.approveMpesaEntries(
        [approveId],
        [{ paymentId: excludeId, reason: 'not on statement' }],
        manager,
        '2026-09-10',
        null
      )
    ).toThrow('simulated failure mid-transaction')
    spy.mockRestore()

    const after = generateEndOfDayReport(db, '2026-09-10')
    expect(after.pendingIds.sort()).toEqual([approveId, excludeId].sort())
    expect(db.getLatestExclusionsForPayments([excludeId])).toEqual([])
  })

  it('throws when given no ids in either list', () => {
    const db = freshDb()
    const { manager } = seedStaff(db)
    expect(() => db.approveMpesaEntries([], [], manager, '2026-09-10', null)).toThrow(/no entries/i)
  })
})

describe('RubisDatabase.approveMpesaEntries — per-entry exclusions (docs/phase-153)', () => {
  it('unticking one entry approves the others and leaves it pending, with its reason recorded', () => {
    const db = freshDb()
    const { ann, manager } = seedStaff(db)
    seedManual(db, ann, 60, 'JJJ1010101', '2026-09-10T09:00:00.000Z')
    seedManual(db, ann, 25, 'KKK2020202', '2026-09-10T09:05:00.000Z')
    const report = generateEndOfDayReport(db, '2026-09-10')
    const approved = report.manualEntries.find((e) => e.reference === 'JJJ1010101')!
    const leftOut = report.manualEntries.find((e) => e.reference === 'KKK2020202')!

    const result = db.approveMpesaEntries(
      [approved.paymentId],
      [{ paymentId: leftOut.paymentId, reason: 'not on statement' }],
      manager,
      '2026-09-10',
      null
    )

    expect(result.approvedCount).toBe(1)
    expect(result.excludedCount).toBe(1)
    expect(result.approval?.entry_count).toBe(1)
    expect(result.approval?.excluded_count).toBe(1)
    expect(result.approval?.total_amount).toBe(60) // only the approved entry's amount

    const after = generateEndOfDayReport(db, '2026-09-10')
    expect(after.manualEntries.find((e) => e.reference === 'JJJ1010101')!.approved).toBe(true)
    expect(after.manualEntries.find((e) => e.reference === 'KKK2020202')!.approved).toBe(false)
    expect(after.pendingIds).toEqual([leftOut.paymentId])
  })

  it('the left-out entry surfaces its reason, day, and manager name on the next report\'s carry-over', () => {
    const db = freshDb()
    const { ann, manager } = seedStaff(db)
    seedManual(db, ann, 25, 'LLL3030303', '2026-09-08T09:00:00.000Z')
    const report = generateEndOfDayReport(db, '2026-09-10')
    const entry = report.carryOver[0]

    db.approveMpesaEntries([], [{ paymentId: entry.paymentId, reason: 'not on statement' }], manager, '2026-09-10', null)

    const next = generateEndOfDayReport(db, '2026-09-11')
    const carried = next.carryOver.find((e) => e.paymentId === entry.paymentId)!
    expect(carried.approved).toBe(false)
    expect(carried.lastExclusion).toEqual({
      localDay: '2026-09-10',
      staffName: 'Manager Mo',
      reason: 'not on statement'
    })
  })

  it('unticking every entry records a review with 0 approved and every exclusion stored — nothing approved', () => {
    const db = freshDb()
    const { ann, manager } = seedStaff(db)
    seedManual(db, ann, 60, 'MMM4040404', '2026-09-10T09:00:00.000Z')
    seedManual(db, ann, 25, 'NNN5050505', '2026-09-10T09:05:00.000Z')
    const report = generateEndOfDayReport(db, '2026-09-10')

    const result = db.approveMpesaEntries(
      [],
      report.pendingIds.map((id) => ({ paymentId: id, reason: 'pending statement check' })),
      manager,
      '2026-09-10',
      null
    )

    expect(result.alreadyApproved).toBe(false)
    expect(result.approvedCount).toBe(0)
    expect(result.excludedCount).toBe(2)
    expect(result.approval?.entry_count).toBe(0)
    expect(result.approval?.excluded_count).toBe(2)
    expect(result.approval?.total_amount).toBe(0)

    const after = generateEndOfDayReport(db, '2026-09-10')
    expect(after.pendingIds.sort()).toEqual([...report.pendingIds].sort())
    expect(after.manualEntries.every((e) => !e.approved)).toBe(true)
  })

  // An id present in both lists, a duplicate id, and an empty submission
  // are all refused at the wire boundary (`approveDayReportSchema`,
  // tested in `tests/ipcValidator.test.ts`) — the database method itself
  // dedupes each list independently and has no way to know a caller
  // meant two different things by the same id, so it is not this
  // method's job to catch that particular mistake.

  it('refuses a non-manual id', () => {
    const db = freshDb()
    const { ann, manager } = seedStaff(db)
    const daraja = seedDaraja(db, ann, 40, 'PPP7070707', '2026-09-10T09:00:00.000Z')
    const darajaPaymentId = db.listMpesaPayments().find((p) => p.order_local_id === daraja.localId)!.id

    expect(() =>
      db.approveMpesaEntries([darajaPaymentId], [], manager, '2026-09-10', null)
    ).toThrow(/manual, still-pending/i)
  })

  it('refuses an already-approved id given as an exclusion', () => {
    const db = freshDb()
    const { ann, manager } = seedStaff(db)
    seedManual(db, ann, 60, 'QQQ8080808', '2026-09-10T09:00:00.000Z')
    const report = generateEndOfDayReport(db, '2026-09-10')
    db.approveMpesaEntries(report.pendingIds, [], manager, '2026-09-10', null)

    expect(() =>
      db.approveMpesaEntries([], [{ paymentId: report.pendingIds[0], reason: 'changed my mind' }], manager, '2026-09-10', null)
    ).toThrow(/manual, still-pending/i)
  })

  it('the "same person" marker appears only when the approver recorded that entry themselves', () => {
    const db = freshDb()
    const { ann, manager } = seedStaff(db)
    seedManual(db, ann, 60, 'RRR9090909', '2026-09-10T09:00:00.000Z')
    seedManual(db, manager, 40, 'SSS0101010', '2026-09-10T09:05:00.000Z')
    const report = generateEndOfDayReport(db, '2026-09-10')
    db.approveMpesaEntries(report.pendingIds, [], manager, '2026-09-10', null)

    const after = generateEndOfDayReport(db, '2026-09-10')
    expect(after.manualEntries.find((e) => e.reference === 'RRR9090909')!.sameApproverAsRecorder).toBe(
      false
    )
    expect(after.manualEntries.find((e) => e.reference === 'SSS0101010')!.sameApproverAsRecorder).toBe(
      true
    )
  })
})
