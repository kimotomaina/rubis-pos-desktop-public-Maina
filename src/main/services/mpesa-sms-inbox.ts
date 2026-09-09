/**
 * Reads M-Pesa confirmation messages out of gammu-smsd's FILES-backend
 * inbox and stores them, so a cashier can approve one against a sale.
 *
 * Polls rather than watches. `fs.watch` on Windows, against a folder
 * another process is writing, misses events, doubles them, and fires
 * before a write has finished — none of which are acceptable on a
 * payment path. A directory listing every few seconds is cheap,
 * predictable, and it is the pattern `connectivityMonitor.ts` already
 * uses.
 *
 * **Gammu's files are never deleted or moved.** Deleting races with
 * gammu still writing, and a destroyed inbox file is unrecoverable
 * evidence for a money transaction. Processed state lives in
 * `mpesa_sms_messages` instead, keyed by the transaction code, so it
 * survives a restart.
 *
 * The parser is injected. It is the piece that has to be settled against
 * real captured messages, and keeping it out of here means this module's
 * behaviour can be proven without also betting on a regex.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Logger } from './logger.js'
import type { MpesaSmsParser } from '../lib/mpesaSms.js'
import type { InsertMpesaSmsMessageInput } from './database.js'
import { decodeInboxFile, reassembleInboxFiles, type GammuInboxFile } from './integrations/gammu-inbox.js'

/** How often the inbox folder is listed. Fast enough that a cashier never waits on the poll itself. */
export const INBOX_POLL_INTERVAL_MS = 3_000

/**
 * How long a file must have been untouched before a failure to parse it
 * is accepted as final.
 *
 * Two things hide behind a parse failure: a file gammu is still writing,
 * and the first part of a multipart message whose second part has not
 * landed yet. Both resolve within seconds. Ten seconds is long enough
 * for the second part of a concatenated SMS to arrive, and short enough
 * that a genuinely unreadable file stops being re-read quickly.
 */
export const FILE_SETTLE_MS = 10_000

/**
 * How long the folder may go without producing a new payment before the
 * inbox reports itself quiet.
 *
 * A dead modem and a quiet shop look identical from here, so this does
 * not claim a fault — it reports the silence, and the screen says what
 * it means. What must never happen is a cashier reading an empty list as
 * "no payment yet" when the real answer is "nothing has been read for an
 * hour".
 */
export const INBOX_QUIET_AFTER_MS = 15 * 60_000

/** What the inbox reader knows about its own health, for the screen to show. */
export interface MpesaSmsInboxStatus {
  /** An inbox folder has been configured for this till. */
  configured: boolean
  /**
   * Whether the parser can recognise a payment message at all.
   *
   * `false` while the field patterns are still unsettled. Reported here,
   * rather than only warned about in a log, because the log is invisible
   * to the person at the counter and the symptom they would otherwise
   * see is an empty payment list with no explanation.
   */
  parserReady: boolean
  /** The folder was there on the last poll. */
  folderPresent: boolean
  /** ISO-8601 of the last completed poll, or `null` before the first one. */
  lastPolledAt: string | null
  /** ISO-8601 of the last message stored, or `null` if none has been since start-up. */
  lastPaymentAt: string | null
  /** Nothing new for {@link INBOX_QUIET_AFTER_MS}. Not a fault on its own. */
  quiet: boolean
  /** Plain-language reason the last poll could not read the folder. */
  error: string | null
}

/** The slice of the database this reader writes to. */
export interface MpesaSmsInboxDb {
  insertMpesaSmsMessage(data: InsertMpesaSmsMessageInput): { inserted: boolean }
}

/** Filesystem surface, injected so the reader can be tested without a folder. */
export interface InboxFileSystem {
  listFiles(directory: string): Promise<string[]>
  modifiedAtMs(path: string): Promise<number>
  readBytes(path: string): Promise<Buffer>
}

/** Options accepted by {@link createMpesaSmsInbox}. */
export interface MpesaSmsInboxOptions {
  /** Folder gammu-smsd writes received messages to. Blank means this till is not using the SMS method. */
  inboxPath: string
  db: MpesaSmsInboxDb
  parse: MpesaSmsParser
  logger?: Logger
  /** Defaults to {@link INBOX_POLL_INTERVAL_MS}. */
  intervalMs?: number
  /** Defaults to {@link FILE_SETTLE_MS}. */
  settleMs?: number
  /** Defaults to {@link INBOX_QUIET_AFTER_MS}. */
  quietAfterMs?: number
  /**
   * Whether {@link parse} can recognise a payment message yet. Defaults
   * to `true`; pass `MPESA_SMS_PARSER_READY` so the screen tells the
   * truth while the parser is still being settled against real samples.
   */
  parserReady?: boolean
  /** Injectable clock, defaulting to `Date.now`. */
  now?: () => number
  /** Defaults to a `node:fs/promises` adapter. */
  fileSystem?: InboxFileSystem
  /** Logs every ignored message. Off by default — a till receives plenty of legitimate non-payment SMS. */
  debugLogging?: boolean
}

/** Handle returned by {@link createMpesaSmsInbox}. */
export interface MpesaSmsInbox {
  /** Polls immediately, then starts the interval. Idempotent. */
  start(): void
  /** Stops the interval. Idempotent. */
  stop(): void
  /** Runs one poll now; concurrent calls coalesce into the one in flight. */
  pollNow(): Promise<MpesaSmsInboxStatus>
  getStatus(): MpesaSmsInboxStatus
}

/** Node-backed filesystem adapter used in production. */
const nodeFileSystem: InboxFileSystem = {
  listFiles: (directory) => readdir(directory),
  modifiedAtMs: async (path) => (await stat(path)).mtimeMs,
  readBytes: (path) => readFile(path)
}

/**
 * Turns the inbox status into one sentence for the cashier.
 *
 * Kept pure and beside the status it describes so the wording is
 * testable. No folder paths, no service names, no error codes: whoever
 * reads this is standing at a till, and the only useful questions are
 * whether payments are arriving and who to tell if they are not.
 *
 * @param {MpesaSmsInboxStatus} status
 * @returns {string | null} `null` when there is nothing worth saying
 */
export function describeInboxHealth(status: MpesaSmsInboxStatus): string | null {
  if (!status.configured) {
    return 'M-Pesa payments by message have not been set up on this till yet. Ask an administrator to finish the setup.'
  }
  if (!status.parserReady) {
    // Checked before the folder: with no working parser it makes no
    // difference whether messages are arriving, and "nothing has come in
    // for a while" would send someone to check a modem that is fine.
    return 'M-Pesa payments by message are not ready on this till yet, so a payment cannot be confirmed here. Take payment another way.'
  }
  if (!status.folderPresent) {
    return 'This till cannot read M-Pesa payment messages right now. The message reader may not be running. Payments cannot be confirmed until it is fixed.'
  }
  if (status.quiet) {
    return 'No M-Pesa message has come in for a while. If a customer has paid and nothing appears here, check that the payment phone or modem is switched on and has signal.'
  }
  return null
}

/**
 * Creates the inbox reader.
 *
 * @param {MpesaSmsInboxOptions} options
 * @returns {MpesaSmsInbox}
 */
export function createMpesaSmsInbox(options: MpesaSmsInboxOptions): MpesaSmsInbox {
  const { db, parse } = options
  const inboxPath = options.inboxPath.trim()
  const logger = options.logger ?? console
  const intervalMs = options.intervalMs ?? INBOX_POLL_INTERVAL_MS
  const settleMs = options.settleMs ?? FILE_SETTLE_MS
  const quietAfterMs = options.quietAfterMs ?? INBOX_QUIET_AFTER_MS
  const now = options.now ?? Date.now
  const fileSystem = options.fileSystem ?? nodeFileSystem
  const debugLogging = options.debugLogging ?? false
  const parserReady = options.parserReady ?? true

  /**
   * Files already resolved — either stored as a payment, or settled and
   * found not to be one. Skipping them keeps each poll proportional to
   * what is new rather than to a folder that only ever grows.
   *
   * Losing this on restart costs one full re-read and nothing else: the
   * unique transaction code makes re-storing a message a no-op. This is
   * an optimisation, never the thing that prevents a double payment.
   */
  const resolvedFiles = new Set<string>()

  let timer: ReturnType<typeof setInterval> | null = null
  let inFlight: Promise<MpesaSmsInboxStatus> | null = null
  const startedAtMs = now()
  let lastPaymentAtMs: number | null = null

  let status: MpesaSmsInboxStatus = {
    configured: inboxPath.length > 0,
    parserReady,
    folderPresent: false,
    lastPolledAt: null,
    lastPaymentAt: null,
    quiet: false,
    error: null
  }

  /** Reads one file, returning `null` if it could not be read this time round. */
  async function readInboxFile(fileName: string): Promise<GammuInboxFile | null> {
    const path = join(inboxPath, fileName)
    try {
      const [modifiedAtMs, bytes] = await Promise.all([
        fileSystem.modifiedAtMs(path),
        fileSystem.readBytes(path)
      ])
      return { fileName, content: decodeInboxFile(bytes), modifiedAtMs }
    } catch {
      // Locked mid-write, or deleted between listing and reading. Both
      // resolve themselves; the next poll picks the file up.
      return null
    }
  }

  async function runPoll(): Promise<MpesaSmsInboxStatus> {
    const polledAt = new Date(now()).toISOString()

    if (!status.configured) {
      status = { ...status, lastPolledAt: polledAt }
      return status
    }

    let fileNames: string[]
    try {
      fileNames = await fileSystem.listFiles(inboxPath)
    } catch (error) {
      status = {
        ...status,
        folderPresent: false,
        lastPolledAt: polledAt,
        quiet: false,
        error: error instanceof Error ? error.message : 'The message folder could not be read'
      }
      return status
    }

    const pending = fileNames.filter(
      (name) => name.toLowerCase().endsWith('.txt') && !resolvedFiles.has(name)
    )
    const files = (await Promise.all(pending.map(readInboxFile))).filter(
      (file): file is GammuInboxFile => file !== null
    )

    for (const message of reassembleInboxFiles(files)) {
      const payment = parse(message.text)

      if (!payment) {
        // Either not a payment at all, or a message still arriving. Only
        // the settle window tells those apart, so an unsettled group is
        // left exactly where it is and reconsidered next poll — with any
        // later part of the same message alongside it.
        if (now() - message.modifiedAtMs >= settleMs) {
          for (const fileName of message.sourceFiles) resolvedFiles.add(fileName)
          if (debugLogging) {
            logger.log(
              `[rubis-pos] M-Pesa inbox: ignored ${message.sourceFiles.join(', ')} — not an incoming payment`
            )
          }
        }
        continue
      }

      const { inserted } = db.insertMpesaSmsMessage({
        transactionCode: payment.transactionCode,
        amount: payment.amount,
        payerName: payment.payerName,
        payerAlias: payment.payerAlias,
        maskedPhone: payment.maskedPhone,
        accountReference: payment.accountReference,
        occurredAt: payment.occurredAt,
        sourceFile: message.sourceFiles.join(', '),
        rawText: payment.raw,
        createdAt: new Date(now()).toISOString()
      })

      for (const fileName of message.sourceFiles) resolvedFiles.add(fileName)
      if (inserted) {
        lastPaymentAtMs = now()
        logger.log(`[rubis-pos] M-Pesa inbox: stored payment ${payment.transactionCode}`)
      }
    }

    const quietSinceMs = now() - (lastPaymentAtMs ?? startedAtMs)
    status = {
      configured: true,
      parserReady,
      folderPresent: true,
      lastPolledAt: polledAt,
      lastPaymentAt: lastPaymentAtMs === null ? null : new Date(lastPaymentAtMs).toISOString(),
      quiet: quietSinceMs >= quietAfterMs,
      error: null
    }
    return status
  }

  async function poll(): Promise<MpesaSmsInboxStatus> {
    if (inFlight) return inFlight

    inFlight = runPoll()
    try {
      return await inFlight
    } finally {
      inFlight = null
    }
  }

  return {
    start(): void {
      if (timer) return
      void poll()
      timer = setInterval(() => void poll(), intervalMs)
    },

    stop(): void {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },

    pollNow: poll,

    getStatus(): MpesaSmsInboxStatus {
      return status
    }
  }
}
