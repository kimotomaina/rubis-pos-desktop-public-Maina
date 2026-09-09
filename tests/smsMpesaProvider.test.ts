/**
 * The SMS M-Pesa provider: what it will confirm, and everything it
 * refuses.
 *
 * Run against a real in-memory database rather than a stub, because the
 * things being asserted are database facts — a row exists, it is
 * unspent, its amount matches to the cent. A stub would only prove the
 * test author's idea of those.
 *
 * The client's rule is an EXACT amount. Under- and over-payment are both
 * refusals, with no override anywhere.
 */

import { describe, it, expect } from 'vitest'
import { RubisDatabase, type InsertMpesaSmsMessageInput } from '../src/main/services/database.js'
import { hashPin } from '../src/main/services/auth.js'
import {
  SmsMpesaProvider,
  amountsMatchExactly,
  toUnmatchedPayments,
  SMS_RECEIVE_ONLY_MESSAGE
} from '../src/main/services/integrations/sms-mpesa-provider.js'

function freshDb(): RubisDatabase {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  return db
}

/** Stores one received payment, shaped like the real captured sample. */
function storePayment(
  db: RubisDatabase,
  overrides: Partial<InsertMpesaSmsMessageInput> = {}
): InsertMpesaSmsMessageInput {
  const message: InsertMpesaSmsMessageInput = {
    transactionCode: 'UI7N55IAAT',
    amount: 500,
    payerName: 'Nelson Elijah Onyango',
    payerAlias: null,
    maskedPhone: '254719350972',
    accountReference: 'JazaKiti - EventDateID 233',
    occurredAt: '2026-09-07T13:44:00.000Z',
    sourceFile: 'IN20260907_134401_00_MPESA_00.txt',
    rawText: 'UI7N55IAAT Confirmed. Ksh500.00 received from Nelson Elijah Onyango.',
    createdAt: new Date().toISOString(),
    ...overrides
  }
  db.insertMpesaSmsMessage(message)
  return message
}

function provider(db: RubisDatabase): SmsMpesaProvider {
  return new SmsMpesaProvider({ db })
}

describe('verifyTransactionCode — the exact-amount rule', () => {
  it('confirms a payment whose amount matches the sale exactly', async () => {
    const db = freshDb()
    storePayment(db)

    const result = await provider(db).verifyTransactionCode({
      transactionCode: 'UI7N55IAAT',
      amount: 500
    })

    expect(result.success).toBe(true)
    expect(result.data?.verified).toBe(true)
    expect(result.data?.transactionCode).toBe('UI7N55IAAT')
    expect(result.data?.amount).toBe(500)
  })

  it('refuses an underpayment', async () => {
    const db = freshDb()
    storePayment(db, { amount: 450 })

    const result = await provider(db).verifyTransactionCode({
      transactionCode: 'UI7N55IAAT',
      amount: 500
    })

    expect(result.data?.verified).toBe(false)
    expect(result.data?.reason).toMatch(/different amount/)
  })

  it('refuses an overpayment, with no override', async () => {
    // Over is as much a mismatch as under. The client's decision, and
    // there is no path around it.
    const db = freshDb()
    storePayment(db, { amount: 550 })

    const result = await provider(db).verifyTransactionCode({
      transactionCode: 'UI7N55IAAT',
      amount: 500
    })

    expect(result.data?.verified).toBe(false)
    expect(result.data?.reason).toMatch(/different amount/)
  })

  it('refuses a payment one cent short', async () => {
    const db = freshDb()
    storePayment(db, { amount: 499.99 })

    const result = await provider(db).verifyTransactionCode({
      transactionCode: 'UI7N55IAAT',
      amount: 500
    })

    expect(result.data?.verified).toBe(false)
  })

  it('confirms an amount that floating point would otherwise reject', async () => {
    // The failure this prevents is turning away a customer who really
    // did pay, because 0.1 + 0.2 is not 0.3 in binary.
    const db = freshDb()
    storePayment(db, { amount: 0.3 })

    const result = await provider(db).verifyTransactionCode({
      transactionCode: 'UI7N55IAAT',
      amount: 0.1 + 0.2
    })

    expect(result.data?.verified).toBe(true)
  })
})

describe('verifyTransactionCode — every other refusal', () => {
  it('says the payment has not arrived, not that the code is wrong', async () => {
    // The usual cause is a message still in flight. Telling a cashier
    // the code is wrong sends them to re-type one that was right.
    const result = await provider(freshDb()).verifyTransactionCode({
      transactionCode: 'NOTHERE99',
      amount: 500
    })

    expect(result.data?.verified).toBe(false)
    expect(result.data?.reason).toMatch(/has not come through yet/)
    expect(result.data?.reason).not.toMatch(/wrong|invalid/i)
  })

  it('refuses a payment another sale already used, and says so', async () => {
    const db = freshDb()
    const staffId = db.createStaff({ name: 'Alex', pinHash: hashPin('1234'), role: 'cashier' }).staffId
    storePayment(db)
    db.queueOrderClaimingSmsPayment(
      {
        items: [],
        total: 500,
        clientOrderUuid: 'uuid-1',
        staffId,
        staffName: 'Alex',
        paymentMethod: 'mpesa',
        tenderedAmount: 500,
        changeDue: 0
      },
      { transactionCode: 'UI7N55IAAT', staffId }
    )

    const result = await provider(db).verifyTransactionCode({
      transactionCode: 'UI7N55IAAT',
      amount: 500
    })

    expect(result.data?.verified).toBe(false)
    expect(result.data?.reason).toMatch(/already used for another sale/)
  })

  it('refuses a blank code', async () => {
    const result = await provider(freshDb()).verifyTransactionCode({
      transactionCode: '   ',
      amount: 500
    })

    expect(result.data?.verified).toBe(false)
  })

  it('finds a code the cashier typed in lower case, with stray spaces', async () => {
    const db = freshDb()
    storePayment(db)

    const result = await provider(db).verifyTransactionCode({
      transactionCode: '  ui7n55iaat  ',
      amount: 500
    })

    expect(result.data?.verified).toBe(true)
  })

  it('never returns a maybe — every answer is verified or refused with a reason', async () => {
    const db = freshDb()
    storePayment(db, { amount: 450 })
    const cases = [
      { transactionCode: 'UI7N55IAAT', amount: 500 },
      { transactionCode: 'NOTHERE99', amount: 500 },
      { transactionCode: '', amount: 500 }
    ]

    for (const input of cases) {
      const result = await provider(db).verifyTransactionCode(input)
      expect(result.success).toBe(true)
      expect(result.data?.verified).toBe(false)
      expect(result.data?.reason?.trim()).toMatch(/\.$/)
    }
  })
})

describe('the SMS provider is receive-only', () => {
  it('refuses to prompt for a payment', async () => {
    const result = await provider(freshDb()).initiateStkPush({
      phoneNumber: '254712345678',
      amount: 500,
      accountReference: 'r',
      transactionDesc: 'd'
    })

    expect(result).toEqual({ success: false, error: SMS_RECEIVE_ONLY_MESSAGE })
  })

  it('refuses to query a push status', async () => {
    const result = await provider(freshDb()).queryStkPushStatus('ws_CO_1')

    expect(result).toEqual({ success: false, error: SMS_RECEIVE_ONLY_MESSAGE })
  })

  it('refuses cleanly rather than throwing, mirroring how Daraja refuses a code lookup', async () => {
    const sms = provider(freshDb())

    await expect(sms.queryStkPushStatus('ws_CO_1')).resolves.toBeDefined()
    await expect(
      sms.initiateStkPush({ phoneNumber: '254712345678', amount: 1, accountReference: '', transactionDesc: '' })
    ).resolves.toBeDefined()
  })
})

describe('listRecentUnmatched', () => {
  it('offers recent unspent payments, newest first', () => {
    const db = freshDb()
    storePayment(db, { transactionCode: 'AAA1111111', createdAt: '2026-09-07T13:40:00.000Z' })
    storePayment(db, { transactionCode: 'BBB2222222', createdAt: '2026-09-07T13:44:00.000Z' })
    const sms = new SmsMpesaProvider({ db, now: () => Date.parse('2026-09-07T13:45:00.000Z') })

    expect(sms.listRecentUnmatched().map((row) => row.transaction_code)).toEqual([
      'BBB2222222',
      'AAA1111111'
    ])
  })

  it('leaves out anything older than the window', () => {
    const db = freshDb()
    storePayment(db, { createdAt: '2026-09-07T10:00:00.000Z' })
    const sms = new SmsMpesaProvider({ db, now: () => Date.parse('2026-09-07T13:45:00.000Z') })

    expect(sms.listRecentUnmatched()).toHaveLength(0)
  })

  it('leaves out a payment another sale already used', () => {
    // Excluded rather than greyed: a spent payment is not a candidate,
    // and offering it invites the double credit this path prevents.
    const db = freshDb()
    const staffId = db.createStaff({ name: 'Alex', pinHash: hashPin('1234'), role: 'cashier' }).staffId
    storePayment(db)
    db.queueOrderClaimingSmsPayment(
      {
        items: [],
        total: 500,
        clientOrderUuid: 'uuid-1',
        staffId,
        staffName: 'Alex',
        paymentMethod: 'mpesa',
        tenderedAmount: 500,
        changeDue: 0
      },
      { transactionCode: 'UI7N55IAAT', staffId }
    )
    const sms = new SmsMpesaProvider({ db })

    expect(sms.listRecentUnmatched()).toHaveLength(0)
  })
})

describe('toUnmatchedPayments', () => {
  it('keeps only what a till screen needs', () => {
    const db = freshDb()
    storePayment(db)
    const [payment] = toUnmatchedPayments(new SmsMpesaProvider({ db }).listRecentUnmatched())

    expect(payment).toEqual({
      transactionCode: 'UI7N55IAAT',
      amount: 500,
      payerLabel: 'Nelson Elijah Onyango',
      occurredAt: '2026-09-07T13:44:00.000Z'
    })
    // The raw message and the file it came from stay in the database.
    expect(Object.keys(payment)).not.toContain('rawText')
  })

  it('falls back to a privacy alias when the message carried no name', () => {
    const db = freshDb()
    storePayment(db, { payerName: null, payerAlias: 'NK_74' })

    expect(toUnmatchedPayments(new SmsMpesaProvider({ db }).listRecentUnmatched())[0].payerLabel).toBe(
      'NK_74'
    )
  })
})

describe('amountsMatchExactly', () => {
  it('matches to the cent, not to the bit', () => {
    expect(amountsMatchExactly(0.1 + 0.2, 0.3)).toBe(true)
    expect(amountsMatchExactly(139.2, 139.2)).toBe(true)
    expect(amountsMatchExactly(500, 500.0)).toBe(true)
  })

  it('separates amounts that genuinely differ, down to one cent', () => {
    expect(amountsMatchExactly(499.99, 500)).toBe(false)
    expect(amountsMatchExactly(500.01, 500)).toBe(false)
  })
})
