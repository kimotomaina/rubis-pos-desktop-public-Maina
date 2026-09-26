/**
 * `getFiscalNotice` tests (phase-78, Parts B and C).
 *
 * `FiscalNotice.tsx` itself is not mounted here — this repo tests the
 * pure mapping function directly, matching `checkoutMath.ts`'s tests
 * (`tests/checkout.test.ts`), which do the same for `PosCheckoutPanel`.
 */

import { describe, it, expect } from 'vitest'
import { getFiscalNotice } from '../src/renderer/src/lib/fiscalNotice.js'

describe('getFiscalNotice', () => {
  it('returns null when fiscalized — no notice needed', () => {
    expect(
      getFiscalNotice({
        fiscalStatus: 'fiscalized',
        fiscalErrorReason: null,
        fiscalErrorKind: null,
        fiscalDataIssue: null
      })
    ).toBeNull()
  })

  it('returns null when fiscalization was never attempted', () => {
    expect(
      getFiscalNotice({
        fiscalStatus: null,
        fiscalErrorReason: null,
        fiscalErrorKind: null,
        fiscalDataIssue: null
      })
    ).toBeNull()
  })

  it('waiting: a calm, reassuring message, no code or jargon', () => {
    const notice = getFiscalNotice({
      fiscalStatus: 'waiting',
      fiscalErrorReason: 'ZFPLabServer cannot reach the fiscal device',
      fiscalErrorKind: 'technical',
      fiscalDataIssue: null
    })

    expect(notice).toEqual({
      kind: 'waiting',
      message: "Tax device unavailable. This sale will be sent automatically when it's back."
    })
    // The stored technical reason is never surfaced verbatim here — the
    // waiting message is a fixed, cashier-friendly sentence regardless
    // of the underlying technical detail.
    expect(notice?.message).not.toContain('ZFPLabServer')
  })

  it('needs_fixing/data: includes the stored plain-language reason', () => {
    const notice = getFiscalNotice({
      fiscalStatus: 'needs_fixing',
      fiscalErrorReason: 'HS code is not valid',
      fiscalErrorKind: 'data',
      fiscalDataIssue: null
    })

    expect(notice).toEqual({
      kind: 'data',
      message: "Sale complete, but the tax device rejected it: HS code is not valid. It's been flagged for correction."
    })
    expect(notice?.fixableAs).toBeUndefined()
  })

  it('needs_fixing/data falls back to a generic phrase when no reason is stored', () => {
    const notice = getFiscalNotice({
      fiscalStatus: 'needs_fixing',
      fiscalErrorReason: null,
      fiscalErrorKind: 'data',
      fiscalDataIssue: null
    })

    expect(notice?.message).toBe(
      "Sale complete, but the tax device rejected it: the tax device rejected it. It's been flagged for correction."
    )
  })

  it('needs_fixing/system: reads as a system/support issue, not a data-fixing instruction', () => {
    const notice = getFiscalNotice({
      fiscalStatus: 'needs_fixing',
      fiscalErrorReason: 'ZFPLabServer rejected the request format',
      fiscalErrorKind: 'system',
      fiscalDataIssue: null
    })

    expect(notice).toEqual({
      kind: 'system',
      message:
        "Sale complete, but it couldn't be sent to the tax device due to a system error. It's been flagged. Please tell support."
    })
    // Never tells the cashier to fix anything themselves.
    expect(notice?.message).not.toMatch(/fix|correct/i)
    // The raw technical reason never leaks into a system-kind message.
    expect(notice?.message).not.toContain('ZFPLabServer')
    expect(notice?.fixableAs).toBeUndefined()
  })

  describe('fixableAs (phase-78, Part C — wrong-PIN fix-and-resend)', () => {
    it('is "wrong-pin" only when needs_fixing/data carries the wrong-pin marker', () => {
      const notice = getFiscalNotice({
        fiscalStatus: 'needs_fixing',
        fiscalErrorReason: 'Wrong client PIN',
        fiscalErrorKind: 'data',
        fiscalDataIssue: 'wrong-pin'
      })

      expect(notice?.fixableAs).toBe('wrong-pin')
    })

    it('is undefined for any other data rejection, even with a similar-sounding reason', () => {
      const notice = getFiscalNotice({
        fiscalStatus: 'needs_fixing',
        fiscalErrorReason: 'Missing defined item',
        fiscalErrorKind: 'data',
        fiscalDataIssue: null
      })

      expect(notice?.fixableAs).toBeUndefined()
    })

    it('is undefined for a system rejection, even if fiscalDataIssue were somehow set', () => {
      const notice = getFiscalNotice({
        fiscalStatus: 'needs_fixing',
        fiscalErrorReason: 'malformed request',
        fiscalErrorKind: 'system',
        fiscalDataIssue: 'wrong-pin'
      })

      expect(notice?.fixableAs).toBeUndefined()
    })

    it('is undefined for waiting, even if fiscalDataIssue were somehow set', () => {
      const notice = getFiscalNotice({
        fiscalStatus: 'waiting',
        fiscalErrorReason: 'device unreachable',
        fiscalErrorKind: 'technical',
        fiscalDataIssue: 'wrong-pin'
      })

      expect(notice?.fixableAs).toBeUndefined()
    })
  })

  it.each([
    ['fiscalized', null, null, null] as const,
    [null, null, null, null] as const,
    ['waiting', 'device unreachable', 'technical', null] as const,
    ['needs_fixing', 'Wrong client PIN', 'data', 'wrong-pin'] as const,
    ['needs_fixing', 'malformed request', 'system', null] as const
  ])('every message stays plain: no device codes, no em dashes (%s/%s)', (status, reason, kind, dataIssue) => {
    const notice = getFiscalNotice({
      fiscalStatus: status,
      fiscalErrorReason: reason,
      fiscalErrorKind: kind,
      fiscalDataIssue: dataIssue
    })
    if (!notice) return
    expect(notice.message).not.toMatch(/\bSTE[12]?\b/i)
    expect(notice.message).not.toMatch(/\bcode\s*\d/i)
    expect(notice.message).not.toContain('—') // em dash
  })
})
