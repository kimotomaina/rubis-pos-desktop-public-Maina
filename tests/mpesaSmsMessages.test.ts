/**
 * The `mpesa_sms_messages` table, against a real in-memory SQLite —
 * because the rule that matters here is enforced by the database, not by
 * the code above it.
 *
 * `UNIQUE(transaction_code)` is what stops one M-Pesa payment being
 * spent on two sales. The inbox folder is re-read every few seconds and
 * gammu's files are never deleted, so the same message is offered to the
 * database over and over, across restarts. A set held in memory would be
 * empty after a restart and would let an already-spent payment be
 * approved a second time; only the constraint survives that.
 */

import { describe, it, expect } from 'vitest'
import { RubisDatabase, type InsertMpesaSmsMessageInput } from '../src/main/services/database.js'

function freshDb(): RubisDatabase {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  return db
}

/** The real captured Paybill message, as the parser would hand it over. */
function paybillMessage(
  overrides: Partial<InsertMpesaSmsMessageInput> = {}
): InsertMpesaSmsMessageInput {
  return {
    transactionCode: 'UI7N55IAAT',
    amount: 500,
    payerName: 'Nelson Elijah Onyango',
    payerAlias: null,
    maskedPhone: '254719350972',
    accountReference: 'JazaKiti - EventDateID 233',
    occurredAt: '2026-09-07T13:44:00.000Z',
    sourceFile: 'IN20260907_134401_00_MPESA_00.txt',
    rawText: 'UI7N55IAAT Confirmed. on 7/9/26 at 1:44 PM Ksh500.00 received from Nelson Elijah Onyango 254719350972.',
    createdAt: '2026-09-07T13:44:05.000Z',
    ...overrides
  }
}

describe('insertMpesaSmsMessage', () => {
  it('stores a payment and reports it as newly inserted', () => {
    const db = freshDb()

    expect(db.insertMpesaSmsMessage(paybillMessage())).toEqual({ inserted: true })

    const row = db.getMpesaSmsMessageByCode('UI7N55IAAT')
    expect(row?.amount).toBe(500)
    expect(row?.payer_name).toBe('Nelson Elijah Onyango')
    expect(row?.account_reference).toBe('JazaKiti - EventDateID 233')
    expect(row?.matched_order_local_id).toBeNull()
  })

  it('stores the message verbatim alongside the parsed fields', () => {
    // The parsed fields are an interpretation. Anyone checking a
    // disputed payment later needs the original, not the reading of it.
    const db = freshDb()
    const message = paybillMessage()

    db.insertMpesaSmsMessage(message)

    expect(db.getMpesaSmsMessageByCode('UI7N55IAAT')?.raw_text).toBe(message.rawText)
  })

  it('refuses a second row for the same transaction code', () => {
    const db = freshDb()

    expect(db.insertMpesaSmsMessage(paybillMessage()).inserted).toBe(true)
    expect(db.insertMpesaSmsMessage(paybillMessage()).inserted).toBe(false)
    expect(db.insertMpesaSmsMessage(paybillMessage()).inserted).toBe(false)

    expect(db.listUnmatchedMpesaSmsMessages('2026-01-01T00:00:00.000Z')).toHaveLength(1)
  })

  it('does not throw on a repeat — a re-read is the normal case, not an error', () => {
    const db = freshDb()
    db.insertMpesaSmsMessage(paybillMessage())

    expect(() => db.insertMpesaSmsMessage(paybillMessage())).not.toThrow()
  })

  it('keeps the first reading when a repeat arrives with different details', () => {
    // A later re-read must never rewrite a payment a cashier may already
    // have approved.
    const db = freshDb()
    db.insertMpesaSmsMessage(paybillMessage())

    db.insertMpesaSmsMessage(paybillMessage({ amount: 5000, payerName: 'Someone Else' }))

    const row = db.getMpesaSmsMessageByCode('UI7N55IAAT')
    expect(row?.amount).toBe(500)
    expect(row?.payer_name).toBe('Nelson Elijah Onyango')
  })

  it('keeps two different payments apart', () => {
    const db = freshDb()

    db.insertMpesaSmsMessage(paybillMessage())
    db.insertMpesaSmsMessage(paybillMessage({ transactionCode: 'UI7N55IABB', amount: 250 }))

    expect(db.listUnmatchedMpesaSmsMessages('2026-01-01T00:00:00.000Z')).toHaveLength(2)
  })
})

describe('getMpesaSmsMessageByCode', () => {
  it('finds a code the cashier typed in lower case', () => {
    const db = freshDb()
    db.insertMpesaSmsMessage(paybillMessage())

    expect(db.getMpesaSmsMessageByCode('ui7n55iaat')?.transaction_code).toBe('UI7N55IAAT')
  })

  it('ignores whitespace around a typed or scanned code', () => {
    const db = freshDb()
    db.insertMpesaSmsMessage(paybillMessage())

    expect(db.getMpesaSmsMessageByCode('  UI7N55IAAT  ')?.transaction_code).toBe('UI7N55IAAT')
  })

  it('returns undefined for a code that has not arrived', () => {
    expect(freshDb().getMpesaSmsMessageByCode('NOTHERE123')).toBeUndefined()
  })
})

describe('listUnmatchedMpesaSmsMessages', () => {
  it('returns newest first', () => {
    const db = freshDb()
    db.insertMpesaSmsMessage(paybillMessage({ createdAt: '2026-09-07T13:40:00.000Z' }))
    db.insertMpesaSmsMessage(
      paybillMessage({ transactionCode: 'UI7N55IABB', createdAt: '2026-09-07T13:44:00.000Z' })
    )

    expect(
      db.listUnmatchedMpesaSmsMessages('2026-01-01T00:00:00.000Z').map((row) => row.transaction_code)
    ).toEqual(['UI7N55IABB', 'UI7N55IAAT'])
  })

  it('excludes anything older than the window', () => {
    const db = freshDb()
    db.insertMpesaSmsMessage(paybillMessage({ createdAt: '2026-09-07T10:00:00.000Z' }))

    expect(db.listUnmatchedMpesaSmsMessages('2026-09-07T13:00:00.000Z')).toHaveLength(0)
  })

  it('honours the limit', () => {
    const db = freshDb()
    for (let index = 0; index < 5; index++) {
      db.insertMpesaSmsMessage(paybillMessage({ transactionCode: `UI7N55IA0${index}` }))
    }

    expect(db.listUnmatchedMpesaSmsMessages('2026-01-01T00:00:00.000Z', 3)).toHaveLength(3)
  })
})
