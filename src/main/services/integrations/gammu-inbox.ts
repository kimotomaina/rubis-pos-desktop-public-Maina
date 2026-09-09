/**
 * Reading gammu-smsd's FILES-backend inbox: decoding one file, and
 * joining the parts of a message that arrived split across several.
 *
 * Pure and filesystem-free — every function here takes the bytes and
 * names already read from disk, so the rules can be unit tested without
 * a modem, a folder, or a clock. `mpesa-sms-inbox.ts` does the I/O.
 *
 * **Why reassembly exists at all.** An M-Pesa confirmation is longer
 * than a single 160-character SMS, so it travels as a concatenated
 * multipart message. Whether gammu-smsd's files backend writes those
 * parts as one file or several depends on its `InboxFormat` and on the
 * modem, and this has not yet been observed against the real device.
 * The reader therefore handles both: a single-file message is simply a
 * group of one, through the same code path.
 */

/** One inbox file, already read from disk. */
export interface GammuInboxFile {
  fileName: string
  /** Decoded text — see {@link decodeInboxFile}. */
  content: string
  /** File mtime in milliseconds. Used only for the settle window, never for grouping. */
  modifiedAtMs: number
}

/** The fields gammu encodes in an inbox file's name. */
export interface GammuInboxFileName {
  /** `YYYYMMDD_HHMMSS` as written, kept as a string — it is a grouping key, not a date. */
  receivedAt: string
  /** Position of this part within a multipart message, `0` for a single-part message. */
  partIndex: number
  /** Sender as gammu wrote it, e.g. `MPESA` or `+254700000000`. */
  sender: string
  /** Gammu's disambiguator for files written in the same second. */
  sequence: number
}

/** One message, reassembled from every part that belongs to it. */
export interface GammuInboxMessage {
  /** The joined text of every part, in part order. */
  text: string
  /** Every file that contributed, in the order they were joined. */
  sourceFiles: string[]
  /** The newest contributing file's mtime — what the settle window is measured against. */
  modifiedAtMs: number
}

/**
 * gammu-smsd's documented inbox file name, e.g.
 * `IN20260907_134401_00_MPESA_00.txt`:
 * `IN` + date + `_` + time + `_` + part index + `_` + sender + `_` +
 * sequence + `.txt`.
 *
 * The sender segment is matched greedily up to the final underscore
 * because a sender can itself contain underscores, while the trailing
 * sequence is always exactly two digits.
 */
const INBOX_FILE_NAME = /^IN(\d{8})_(\d{6})_(\d{2})_(.*)_(\d{2})\.txt$/i

/** Byte-order marks this reader recognises, longest first so UTF-8's is not mistaken for a prefix. */
const BOM_UTF8 = 'efbbbf'
const BOM_UTF16LE = 'fffe'
const BOM_UTF16BE = 'feff'

/**
 * Decodes one inbox file.
 *
 * gammu writes plain text, but which encoding depends on its
 * `InboxFormat` setting and on whether the message needed UCS-2 — so
 * the byte-order mark decides rather than an assumption. A file with no
 * mark is read as UTF-8, which is also correct for plain ASCII.
 *
 * @param {Buffer} buffer raw file bytes
 * @returns {string} decoded text with any byte-order mark removed
 */
export function decodeInboxFile(buffer: Buffer): string {
  const head = buffer.subarray(0, 3).toString('hex').toLowerCase()

  if (head.startsWith(BOM_UTF8)) {
    return buffer.subarray(3).toString('utf8')
  }
  if (head.startsWith(BOM_UTF16LE)) {
    return buffer.subarray(2).toString('utf16le')
  }
  if (head.startsWith(BOM_UTF16BE)) {
    return swapEndian(buffer.subarray(2)).toString('utf16le')
  }
  return buffer.toString('utf8')
}

/**
 * Splits an inbox file name into its parts.
 *
 * @param {string} fileName
 * @returns {GammuInboxFileName | null} `null` when the name does not match gammu's pattern
 */
export function parseGammuInboxFileName(fileName: string): GammuInboxFileName | null {
  const match = INBOX_FILE_NAME.exec(fileName)
  if (!match) return null

  const [, date, time, partIndex, sender, sequence] = match
  return {
    receivedAt: `${date}_${time}`,
    partIndex: Number(partIndex),
    sender,
    sequence: Number(sequence)
  }
}

/**
 * Groups inbox files into whole messages and joins each group's parts
 * in order.
 *
 * Parts of one concatenated message are identified by sharing a sender
 * and a received timestamp, and are ordered by the part index in the
 * file name. A file whose name does not match gammu's pattern — a
 * differently-configured `InboxFormat`, or something else entirely in
 * the folder — becomes a message on its own rather than being dropped
 * or guessed at.
 *
 * **If the grouping is wrong, it fails safe.** Should the real modem
 * write parts with differing timestamps, each part becomes its own
 * message, every one of them fails to parse, and the payment is simply
 * not offered to the cashier. That blocks a sale, which is the correct
 * direction for a payment: the cost is a delay, not released stock. It
 * is also immediately visible, which is what makes it a
 * verify-with-real-modem item rather than a silent risk.
 *
 * Only the trailing line break of each part is stripped before joining.
 * Trailing spaces are left alone: a concatenated SMS can split on one,
 * and losing it would run two words together.
 *
 * @param {GammuInboxFile[]} files
 * @returns {GammuInboxMessage[]} oldest message first
 */
export function reassembleInboxFiles(files: GammuInboxFile[]): GammuInboxMessage[] {
  const groups = new Map<string, GammuInboxFile[]>()

  for (const file of files) {
    const parsed = parseGammuInboxFileName(file.fileName)
    const key = parsed ? `${parsed.sender}|${parsed.receivedAt}` : `file|${file.fileName}`
    const group = groups.get(key)
    if (group) {
      group.push(file)
    } else {
      groups.set(key, [file])
    }
  }

  const messages: GammuInboxMessage[] = []
  for (const group of groups.values()) {
    const ordered = [...group].sort(compareParts)
    messages.push({
      text: ordered.map((file) => file.content.replace(/\r?\n+$/, '')).join(''),
      sourceFiles: ordered.map((file) => file.fileName),
      modifiedAtMs: Math.max(...ordered.map((file) => file.modifiedAtMs))
    })
  }

  return messages.sort((a, b) => a.modifiedAtMs - b.modifiedAtMs)
}

/**
 * Orders the parts of one message: by part index, then by gammu's
 * same-second sequence, then by name so the result never depends on the
 * order the directory happened to list.
 */
function compareParts(a: GammuInboxFile, b: GammuInboxFile): number {
  const left = parseGammuInboxFileName(a.fileName)
  const right = parseGammuInboxFileName(b.fileName)

  if (left && right) {
    if (left.partIndex !== right.partIndex) return left.partIndex - right.partIndex
    if (left.sequence !== right.sequence) return left.sequence - right.sequence
  }
  return a.fileName.localeCompare(b.fileName)
}

/** Reverses each 16-bit pair so a big-endian UTF-16 buffer can be read as little-endian. */
function swapEndian(buffer: Buffer): Buffer {
  const swapped = Buffer.from(buffer)
  for (let index = 0; index + 1 < swapped.length; index += 2) {
    const first = swapped[index]
    swapped[index] = swapped[index + 1]
    swapped[index + 1] = first
  }
  return swapped
}
