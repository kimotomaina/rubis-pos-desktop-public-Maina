/**
 * The inbox reader: what it stores, what it leaves alone, and what it
 * says about itself when nothing is arriving.
 *
 * Two rules hold this file together. First, re-reading the same folder
 * must never produce a second approvable payment — the folder is read
 * every few seconds forever and its files are never deleted, so
 * idempotence is not a nicety. Second, a file that fails to parse might
 * be half-written or half-arrived, so it is left alone until it settles
 * rather than being written off.
 *
 * The parser is a stand-in here on purpose. This file proves the
 * reader's behaviour; the regexes are proven separately, against real
 * captured messages.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  createMpesaSmsInbox,
  describeInboxHealth,
  type InboxFileSystem,
  type MpesaSmsInboxStatus
} from '../src/main/services/mpesa-sms-inbox.js'
import type { MpesaSmsPayment } from '../src/main/lib/mpesaSms.js'
import type { InsertMpesaSmsMessageInput } from '../src/main/services/database.js'

/** A payment shaped like the real Paybill sample, for the stand-in parser to return. */
function payment(transactionCode: string, raw: string): MpesaSmsPayment {
  return {
    transactionCode,
    amount: 500,
    payerName: 'Nelson Elijah Onyango',
    payerAlias: null,
    maskedPhone: '254719350972',
    accountReference: 'JazaKiti - EventDateID 233',
    occurredAt: '2026-09-07T13:44:00.000Z',
    raw
  }
}

/**
 * Stand-in parser: any text containing a bare `<CODE> Confirmed.` opener
 * is a payment, anything else is not. Deliberately crude — the real
 * anchors belong to the parser's own tests.
 */
const fakeParse = (raw: string): MpesaSmsPayment | null => {
  const match = /^([A-Z0-9]{6,12}) Confirmed\./.exec(raw)
  return match ? payment(match[1], raw) : null
}

/** An in-memory database slice recording what the reader tried to store. */
function fakeDb(): {
  inserts: InsertMpesaSmsMessageInput[]
  insertMpesaSmsMessage(data: InsertMpesaSmsMessageInput): { inserted: boolean }
} {
  const stored = new Set<string>()
  const inserts: InsertMpesaSmsMessageInput[] = []
  return {
    inserts,
    insertMpesaSmsMessage(data) {
      inserts.push(data)
      // Mirrors the real table's UNIQUE(transaction_code).
      if (stored.has(data.transactionCode)) return { inserted: false }
      stored.add(data.transactionCode)
      return { inserted: true }
    }
  }
}

/** An in-memory inbox folder. */
function fakeFolder(files: Record<string, { text: string; modifiedAtMs: number }>): InboxFileSystem {
  return {
    listFiles: async () => Object.keys(files),
    modifiedAtMs: async (path) => entry(files, path).modifiedAtMs,
    readBytes: async (path) => Buffer.from(entry(files, path).text, 'utf8')
  }
}

/** Looks a file up by the joined path the reader builds. */
function entry(
  files: Record<string, { text: string; modifiedAtMs: number }>,
  path: string
): { text: string; modifiedAtMs: number } {
  const name = path.split(/[\\/]/).pop() ?? path
  const found = files[name]
  if (!found) throw new Error(`ENOENT: ${path}`)
  return found
}

const PAYBILL_SMS =
  'UI7N55IAAT Confirmed. on 7/9/26 at 1:44 PM Ksh500.00 received from Nelson Elijah Onyango 254719350972.'

describe('createMpesaSmsInbox', () => {
  it('stores a payment read from a single inbox file', async () => {
    const db = fakeDb()
    const inbox = createMpesaSmsInbox({
      inboxPath: 'C:/gammu/inbox',
      db,
      parse: fakeParse,
      now: () => 100_000,
      fileSystem: fakeFolder({
        'IN20260907_134401_00_MPESA_00.txt': { text: PAYBILL_SMS, modifiedAtMs: 0 }
      }),
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    })

    await inbox.pollNow()

    expect(db.inserts).toHaveLength(1)
    expect(db.inserts[0].transactionCode).toBe('UI7N55IAAT')
    expect(db.inserts[0].sourceFile).toBe('IN20260907_134401_00_MPESA_00.txt')
    // Stored verbatim: the parsed fields are an interpretation, the
    // original is the evidence.
    expect(db.inserts[0].rawText).toBe(PAYBILL_SMS)
  })

  it('joins a multipart message before parsing it', async () => {
    const db = fakeDb()
    const inbox = createMpesaSmsInbox({
      inboxPath: 'C:/gammu/inbox',
      db,
      parse: fakeParse,
      now: () => 100_000,
      fileSystem: fakeFolder({
        'IN20260907_134401_00_MPESA_00.txt': {
          text: 'UI7N55IAAT Confirmed. on 7/9/26 at 1:44 PM ',
          modifiedAtMs: 0
        },
        'IN20260907_134401_01_MPESA_00.txt': {
          text: 'Ksh500.00 received from Nelson Elijah Onyango.',
          modifiedAtMs: 0
        }
      }),
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    })

    await inbox.pollNow()

    // One payment, not two half-payments and not none.
    expect(db.inserts).toHaveLength(1)
    expect(db.inserts[0].rawText).toContain('UI7N55IAAT Confirmed.')
    expect(db.inserts[0].rawText).toContain('Ksh500.00 received')
    expect(db.inserts[0].sourceFile).toBe(
      'IN20260907_134401_00_MPESA_00.txt, IN20260907_134401_01_MPESA_00.txt'
    )
  })

  it('stores each transaction code once however many times the folder is read', async () => {
    const db = fakeDb()
    const inbox = createMpesaSmsInbox({
      inboxPath: 'C:/gammu/inbox',
      db,
      parse: fakeParse,
      now: () => 100_000,
      fileSystem: fakeFolder({
        'IN20260907_134401_00_MPESA_00.txt': { text: PAYBILL_SMS, modifiedAtMs: 0 }
      }),
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    })

    await inbox.pollNow()
    await inbox.pollNow()
    await inbox.pollNow()

    // One attempt in total: an already-resolved file is not re-read.
    expect(db.inserts).toHaveLength(1)
  })

  it('still stores only once if the same file is offered to the database again', async () => {
    // Belt and braces: the reader's in-memory skip list is an
    // optimisation, and losing it on restart must change nothing. The
    // unique transaction code is what actually prevents a second
    // approvable payment.
    const db = fakeDb()
    const folder = fakeFolder({
      'IN20260907_134401_00_MPESA_00.txt': { text: PAYBILL_SMS, modifiedAtMs: 0 }
    })
    const build = (): ReturnType<typeof createMpesaSmsInbox> =>
      createMpesaSmsInbox({
        inboxPath: 'C:/gammu/inbox',
        db,
        parse: fakeParse,
        now: () => 100_000,
        fileSystem: folder,
        logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
      })

    await build().pollNow()
    await build().pollNow()

    expect(db.inserts).toHaveLength(2)
    expect(db.inserts.filter((insert) => insert.transactionCode === 'UI7N55IAAT')).toHaveLength(2)
    // Two attempts, one stored — the second returned inserted: false.
  })

  it('leaves a young unparseable file alone and picks it up once its other part lands', async () => {
    const db = fakeDb()
    const files: Record<string, { text: string; modifiedAtMs: number }> = {
      'IN20260907_134401_00_MPESA_00.txt': {
        text: 'UI7N55IAAT Confirm',
        modifiedAtMs: 99_000
      }
    }
    let clock = 100_000
    const inbox = createMpesaSmsInbox({
      inboxPath: 'C:/gammu/inbox',
      db,
      parse: fakeParse,
      settleMs: 10_000,
      now: () => clock,
      fileSystem: fakeFolder(files),
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    })

    // Half-written: 1s old, nothing recorded, nothing written off.
    await inbox.pollNow()
    expect(db.inserts).toHaveLength(0)

    // The rest of the message arrives inside the settle window.
    files['IN20260907_134401_00_MPESA_00.txt'] = { text: 'UI7N55IAAT Confirmed. ', modifiedAtMs: 103_000 }
    files['IN20260907_134401_01_MPESA_00.txt'] = { text: 'Ksh500.00 received.', modifiedAtMs: 103_000 }
    clock = 104_000

    await inbox.pollNow()

    expect(db.inserts).toHaveLength(1)
    expect(db.inserts[0].transactionCode).toBe('UI7N55IAAT')
  })

  it('stops reconsidering a message once it has settled and is not a payment', async () => {
    const db = fakeDb()
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const inbox = createMpesaSmsInbox({
      inboxPath: 'C:/gammu/inbox',
      db,
      parse: fakeParse,
      settleMs: 10_000,
      debugLogging: true,
      now: () => 100_000,
      fileSystem: fakeFolder({
        'IN20260907_134401_00_MPESA_00.txt': {
          text: 'Your M-PESA balance was Ksh19,500.00',
          modifiedAtMs: 50_000
        }
      }),
      logger
    })

    await inbox.pollNow()
    await inbox.pollNow()

    // A till receives plenty of legitimate non-payment messages. They
    // are ignored, not treated as errors, and not re-read forever.
    expect(db.inserts).toHaveLength(0)
    expect(logger.log).toHaveBeenCalledTimes(1)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('skips a file that cannot be read this time round, and retries it next poll', async () => {
    const db = fakeDb()
    let locked = true
    const inbox = createMpesaSmsInbox({
      inboxPath: 'C:/gammu/inbox',
      db,
      parse: fakeParse,
      now: () => 100_000,
      fileSystem: {
        listFiles: async () => ['IN20260907_134401_00_MPESA_00.txt'],
        modifiedAtMs: async () => 0,
        readBytes: async () => {
          if (locked) throw new Error('EBUSY: file is locked')
          return Buffer.from(PAYBILL_SMS, 'utf8')
        }
      },
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    })

    await inbox.pollNow()
    expect(db.inserts).toHaveLength(0)

    locked = false
    await inbox.pollNow()
    expect(db.inserts).toHaveLength(1)
  })

  it('reports a missing folder rather than an empty list', async () => {
    // The failure this prevents: a cashier reading "no payments" off a
    // screen when the truth is that nothing is being read at all.
    const inbox = createMpesaSmsInbox({
      inboxPath: 'C:/gammu/inbox',
      db: fakeDb(),
      parse: fakeParse,
      now: () => 100_000,
      fileSystem: {
        listFiles: async () => {
          throw new Error('ENOENT: no such file or directory')
        },
        modifiedAtMs: async () => 0,
        readBytes: async () => Buffer.alloc(0)
      },
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    })

    const status = await inbox.pollNow()

    expect(status.folderPresent).toBe(false)
    expect(status.error).toMatch(/ENOENT/)
    expect(describeInboxHealth(status)).toMatch(/cannot read M-Pesa payment messages/)
  })

  it('reports itself quiet when nothing has arrived for a long time', async () => {
    let clock = 100_000
    const inbox = createMpesaSmsInbox({
      inboxPath: 'C:/gammu/inbox',
      db: fakeDb(),
      parse: fakeParse,
      quietAfterMs: 60_000,
      now: () => clock,
      fileSystem: fakeFolder({}),
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    })

    expect((await inbox.pollNow()).quiet).toBe(false)

    clock = 100_000 + 61_000
    const status = await inbox.pollNow()

    expect(status.folderPresent).toBe(true)
    expect(status.quiet).toBe(true)
    expect(describeInboxHealth(status)).toMatch(/No M-Pesa message has come in for a while/)
  })

  it('clears quiet once a payment arrives', async () => {
    let clock = 100_000
    const files: Record<string, { text: string; modifiedAtMs: number }> = {}
    const inbox = createMpesaSmsInbox({
      inboxPath: 'C:/gammu/inbox',
      db: fakeDb(),
      parse: fakeParse,
      quietAfterMs: 60_000,
      now: () => clock,
      fileSystem: fakeFolder(files),
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    })

    clock = 100_000 + 61_000
    expect((await inbox.pollNow()).quiet).toBe(true)

    files['IN20260907_134401_00_MPESA_00.txt'] = { text: PAYBILL_SMS, modifiedAtMs: clock }
    const status = await inbox.pollNow()

    expect(status.quiet).toBe(false)
    expect(status.lastPaymentAt).not.toBeNull()
  })

  it('reports "not set up" rather than pretending to poll when no folder is configured', async () => {
    const inbox = createMpesaSmsInbox({
      inboxPath: '   ',
      db: fakeDb(),
      parse: fakeParse,
      now: () => 100_000,
      fileSystem: fakeFolder({}),
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    })

    const status = await inbox.pollNow()

    expect(status.configured).toBe(false)
    expect(describeInboxHealth(status)).toMatch(/have not been set up on this till yet/)
  })

  it('coalesces concurrent polls into one pass', async () => {
    const listFiles = vi.fn(async () => [])
    const inbox = createMpesaSmsInbox({
      inboxPath: 'C:/gammu/inbox',
      db: fakeDb(),
      parse: fakeParse,
      now: () => 100_000,
      fileSystem: { listFiles, modifiedAtMs: async () => 0, readBytes: async () => Buffer.alloc(0) },
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    })

    await Promise.all([inbox.pollNow(), inbox.pollNow(), inbox.pollNow()])

    expect(listFiles).toHaveBeenCalledTimes(1)
  })
})

describe('describeInboxHealth', () => {
  const healthy: MpesaSmsInboxStatus = {
    configured: true,
    parserReady: true,
    folderPresent: true,
    lastPolledAt: '2026-09-07T13:44:00.000Z',
    lastPaymentAt: '2026-09-07T13:44:00.000Z',
    quiet: false,
    error: null
  }

  it('says nothing when payments are arriving normally', () => {
    expect(describeInboxHealth(healthy)).toBeNull()
  })

  /**
   * The parser is not finished, so a till selecting the message method
   * today reads as not ready. That has to reach the cashier, not just a
   * log file: the symptom otherwise is an empty payment list with no
   * explanation, and a person at a counter concluding the modem is
   * broken.
   */
  it('says the till is not ready when no message can be recognised yet', () => {
    const message = describeInboxHealth({ ...healthy, parserReady: false })

    expect(message).toMatch(/not ready on this till yet/)
    expect(message).toMatch(/Take payment another way/)
  })

  it('reports not-ready ahead of quiet, so nobody is sent to check a working modem', () => {
    const message = describeInboxHealth({ ...healthy, parserReady: false, quiet: true })

    expect(message).toMatch(/not ready on this till yet/)
    expect(message).not.toMatch(/signal/)
  })

  it('never shows a folder path, a service name, or an error code to a cashier', () => {
    const messages = [
      describeInboxHealth({ ...healthy, configured: false }),
      describeInboxHealth({ ...healthy, parserReady: false }),
      describeInboxHealth({ ...healthy, folderPresent: false, error: 'ENOENT: C:/gammu/inbox' }),
      describeInboxHealth({ ...healthy, quiet: true })
    ]

    for (const message of messages) {
      expect(message).not.toBeNull()
      expect(message).not.toMatch(/gammu|smsd|ENOENT|inbox|C:|SMS\b/i)
      expect(message?.trim()).toMatch(/\.$/)
    }
  })
})
