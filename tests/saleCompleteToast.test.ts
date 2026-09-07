/**
 * `getSaleCompleteMessage` tests (phase-84, Task 2).
 *
 * `SaleCompleteToast.tsx` itself is not mounted here — same convention
 * as `fiscalNotice.test.ts`: the pure derivation is tested directly.
 */

import { describe, it, expect } from 'vitest'
import { getSaleCompleteMessage } from '../src/renderer/src/lib/saleCompleteToast.js'

describe('getSaleCompleteMessage', () => {
  it('says the tax receipt was issued when the sale fiscalized', () => {
    expect(
      getSaleCompleteMessage({
        fiscalStatus: 'fiscalized',
        fiscalErrorReason: null,
        fiscalErrorKind: null,
        fiscalDataIssue: null
      })
    ).toBe('Sale complete - tax receipt issued.')
  })

  it('says plain "Sale complete." when fiscalization was never attempted', () => {
    expect(
      getSaleCompleteMessage({
        fiscalStatus: null,
        fiscalErrorReason: null,
        fiscalErrorKind: null,
        fiscalDataIssue: null
      })
    ).toBe('Sale complete.')
  })

  it('is suppressed (null) when the sale is waiting on the fiscal device — the banner owns it', () => {
    expect(
      getSaleCompleteMessage({
        fiscalStatus: 'waiting',
        fiscalErrorReason: 'device unreachable',
        fiscalErrorKind: 'technical',
        fiscalDataIssue: null
      })
    ).toBeNull()
  })

  it('is suppressed (null) for a needs_fixing data rejection — no contradictory toast', () => {
    expect(
      getSaleCompleteMessage({
        fiscalStatus: 'needs_fixing',
        fiscalErrorReason: 'Wrong client PIN',
        fiscalErrorKind: 'data',
        fiscalDataIssue: 'wrong-pin'
      })
    ).toBeNull()
  })

  it('is suppressed (null) for a needs_fixing system error', () => {
    expect(
      getSaleCompleteMessage({
        fiscalStatus: 'needs_fixing',
        fiscalErrorReason: 'ZFPLabServer rejected the request format',
        fiscalErrorKind: 'system',
        fiscalDataIssue: null
      })
    ).toBeNull()
  })

  it('never uses an em dash', () => {
    const message = getSaleCompleteMessage({
      fiscalStatus: 'fiscalized',
      fiscalErrorReason: null,
      fiscalErrorKind: null,
      fiscalDataIssue: null
    })
    expect(message).not.toContain('—')
  })
})
