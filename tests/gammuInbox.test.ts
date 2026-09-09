/**
 * Reassembling gammu-smsd's FILES-backend inbox.
 *
 * The rule these tests hold: a multipart M-Pesa confirmation must come
 * back out as ONE message, and a single-file message must go through
 * the identical path, because which of the two the real modem produces
 * has not yet been observed. Anything that assumes single-file would
 * silently drop half of every payment on a modem that splits them.
 */

import { describe, it, expect } from 'vitest'
import {
  decodeInboxFile,
  parseGammuInboxFileName,
  reassembleInboxFiles,
  type GammuInboxFile
} from '../src/main/services/integrations/gammu-inbox.js'

/** Builds an inbox file with gammu's documented naming. */
function file(
  fileName: string,
  content: string,
  modifiedAtMs = 1_000
): GammuInboxFile {
  return { fileName, content, modifiedAtMs }
}

describe('parseGammuInboxFileName', () => {
  it('splits gammu\'s documented name into its fields', () => {
    expect(parseGammuInboxFileName('IN20260907_134401_00_MPESA_00.txt')).toEqual({
      receivedAt: '20260907_134401',
      partIndex: 0,
      sender: 'MPESA',
      sequence: 0
    })
  })

  it('reads the part index of a later part', () => {
    expect(parseGammuInboxFileName('IN20260907_134401_01_MPESA_00.txt')?.partIndex).toBe(1)
  })

  it('keeps a sender that itself contains underscores', () => {
    // The trailing sequence is always two digits, so the sender is
    // whatever sits between the part index and that final field.
    expect(parseGammuInboxFileName('IN20260907_134401_00_M_PESA_KE_00.txt')?.sender).toBe(
      'M_PESA_KE'
    )
  })

  it('returns null for a name that is not gammu\'s', () => {
    expect(parseGammuInboxFileName('notes.txt')).toBeNull()
    expect(parseGammuInboxFileName('IN2026_00_MPESA.txt')).toBeNull()
  })
})

describe('decodeInboxFile', () => {
  it('reads plain UTF-8', () => {
    expect(decodeInboxFile(Buffer.from('QGH1 Confirmed.', 'utf8'))).toBe('QGH1 Confirmed.')
  })

  it('strips a UTF-8 byte-order mark', () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('QGH1', 'utf8')])
    expect(decodeInboxFile(withBom)).toBe('QGH1')
  })

  it('reads UTF-16 little-endian, as a UCS-2 message can produce', () => {
    const withBom = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('QGH1', 'utf16le')])
    expect(decodeInboxFile(withBom)).toBe('QGH1')
  })

  it('reads UTF-16 big-endian', () => {
    const body = Buffer.from('QGH1', 'utf16le')
    const swapped = Buffer.from(body)
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const first = swapped[i]
      swapped[i] = swapped[i + 1]
      swapped[i + 1] = first
    }
    expect(decodeInboxFile(Buffer.concat([Buffer.from([0xfe, 0xff]), swapped]))).toBe('QGH1')
  })
})

describe('reassembleInboxFiles', () => {
  it('joins the parts of one multipart message, in part order', () => {
    const messages = reassembleInboxFiles([
      file('IN20260907_134401_01_MPESA_00.txt', 'balance is Ksh19,500.00'),
      file('IN20260907_134401_00_MPESA_00.txt', 'UI7N55IAAT Confirmed. New Utility ')
    ])

    expect(messages).toHaveLength(1)
    expect(messages[0].text).toBe('UI7N55IAAT Confirmed. New Utility balance is Ksh19,500.00')
    expect(messages[0].sourceFiles).toEqual([
      'IN20260907_134401_00_MPESA_00.txt',
      'IN20260907_134401_01_MPESA_00.txt'
    ])
  })

  it('joins three parts in order, not in the order the folder listed them', () => {
    const messages = reassembleInboxFiles([
      file('IN20260907_134401_02_MPESA_00.txt', 'CCC'),
      file('IN20260907_134401_00_MPESA_00.txt', 'AAA'),
      file('IN20260907_134401_01_MPESA_00.txt', 'BBB')
    ])

    expect(messages[0].text).toBe('AAABBBCCC')
  })

  it('treats a single-file message as a group of one, through the same path', () => {
    const messages = reassembleInboxFiles([
      file('IN20260907_134401_00_MPESA_00.txt', 'UI7N55IAAT Confirmed.')
    ])

    expect(messages).toHaveLength(1)
    expect(messages[0].text).toBe('UI7N55IAAT Confirmed.')
  })

  it('keeps two messages from the same sender separate', () => {
    // Two payments a minute apart must never be joined into one
    // unparseable blob, nor into one plausible wrong payment.
    const messages = reassembleInboxFiles([
      file('IN20260907_134401_00_MPESA_00.txt', 'first', 1_000),
      file('IN20260907_134501_00_MPESA_00.txt', 'second', 2_000)
    ])

    expect(messages.map((message) => message.text)).toEqual(['first', 'second'])
  })

  it('strips only the trailing line break of each part, never a trailing space', () => {
    // A concatenated SMS can split on a space. Losing it would run two
    // words together and change what the parser sees.
    const messages = reassembleInboxFiles([
      file('IN20260907_134401_00_MPESA_00.txt', 'Ksh500.00 received \n'),
      file('IN20260907_134401_01_MPESA_00.txt', 'from Nelson\n')
    ])

    expect(messages[0].text).toBe('Ksh500.00 received from Nelson')
  })

  it('keeps a file whose name is not gammu\'s as a message of its own', () => {
    // A differently-configured InboxFormat must not mean silently
    // dropped payments.
    const messages = reassembleInboxFiles([file('whatever.txt', 'UI7N55IAAT Confirmed.')])

    expect(messages).toHaveLength(1)
    expect(messages[0].text).toBe('UI7N55IAAT Confirmed.')
  })

  it('reports the newest part\'s mtime, which is what the settle window measures', () => {
    const messages = reassembleInboxFiles([
      file('IN20260907_134401_00_MPESA_00.txt', 'A', 1_000),
      file('IN20260907_134401_01_MPESA_00.txt', 'B', 9_000)
    ])

    expect(messages[0].modifiedAtMs).toBe(9_000)
  })

  it('returns messages oldest first', () => {
    const messages = reassembleInboxFiles([
      file('IN20260907_140000_00_MPESA_00.txt', 'newer', 5_000),
      file('IN20260907_134401_00_MPESA_00.txt', 'older', 1_000)
    ])

    expect(messages.map((message) => message.text)).toEqual(['older', 'newer'])
  })
})
