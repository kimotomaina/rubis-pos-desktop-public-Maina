/**
 * `resolveCheckFitForcedScreen` tests (docs/phase-167 Part B item 1).
 *
 * Pure, framework-free, tested directly — split out of `main/index.ts`
 * specifically so this could be unit tested at all (that file imports
 * Electron at module load time and is not importable in a test run).
 */

import { describe, it, expect } from 'vitest'
import {
  resolveCheckFitForcedScreen,
  resolveCheckFitSendingDisabled,
  guardCheckFitSending,
  shouldStartBackgroundSenders,
  CHECK_FIT_SENDING_DISABLED_MESSAGE
} from '../src/main/lib/checkFit.js'

describe('resolveCheckFitForcedScreen', () => {
  it('returns null when unset — the real state of every actual launch', () => {
    expect(resolveCheckFitForcedScreen(undefined)).toBeNull()
  })

  it('returns the raw value unchanged when set', () => {
    expect(resolveCheckFitForcedScreen('zReport')).toBe('zReport')
    expect(resolveCheckFitForcedScreen('variantModal')).toBe('variantModal')
    expect(resolveCheckFitForcedScreen('mpesaManualKeyboard')).toBe('mpesaManualKeyboard')
  })

  it('treats an empty string as set, not as unset — only a genuinely absent variable resolves to null', () => {
    expect(resolveCheckFitForcedScreen('')).toBe('')
  })
})

/**
 * `resolveCheckFitSendingDisabled` tests (docs/phase-169-1 commit A).
 */
describe('resolveCheckFitSendingDisabled', () => {
  it('is off when unset — the real state of every actual launch', () => {
    expect(resolveCheckFitSendingDisabled(undefined)).toBe(false)
  })

  it('is off for an empty string', () => {
    expect(resolveCheckFitSendingDisabled('')).toBe(false)
  })

  it('is on for the value check-fit.mjs sets', () => {
    expect(resolveCheckFitSendingDisabled('1')).toBe(true)
  })

  it('is on for any other non-empty value', () => {
    expect(resolveCheckFitSendingDisabled('true')).toBe(true)
    expect(resolveCheckFitSendingDisabled('yes')).toBe(true)
  })
})

/**
 * `guardCheckFitSending` tests (docs/phase-169-1 commit A) — the
 * decision every sending IPC handler (orders:checkout, receipt:print,
 * fiscal:resend, fiscal:correct-pin-and-resend, orders:retrySync) makes.
 */
describe('guardCheckFitSending', () => {
  it('lets the request through when sending is not disabled', () => {
    expect(guardCheckFitSending(false)).toBeNull()
  })

  it('refuses with a plain message when sending is disabled', () => {
    expect(guardCheckFitSending(true)).toEqual({
      success: false,
      error: CHECK_FIT_SENDING_DISABLED_MESSAGE
    })
  })

  it('still lets the mock printer through when sending is disabled (skipWhenMock)', () => {
    expect(guardCheckFitSending(true, { skipWhenMock: true })).toBeNull()
  })

  it('refuses the real (non-mock) printer when sending is disabled', () => {
    expect(guardCheckFitSending(true, { skipWhenMock: false })).toEqual({
      success: false,
      error: CHECK_FIT_SENDING_DISABLED_MESSAGE
    })
  })

  it('lets the mock printer through even when not disabled (skipWhenMock is irrelevant here)', () => {
    expect(guardCheckFitSending(false, { skipWhenMock: true })).toBeNull()
  })
})

/**
 * `shouldStartBackgroundSenders` tests (docs/phase-169-1 commit A) —
 * gates `engine.start()`/`fiscalEngine.start()`/`mpesaSmsInbox.start()`
 * in `main/index.ts`.
 */
describe('shouldStartBackgroundSenders', () => {
  it('is true when sending is not disabled — every real launch', () => {
    expect(shouldStartBackgroundSenders(false)).toBe(true)
  })

  it('is false when sending is disabled — check:fit', () => {
    expect(shouldStartBackgroundSenders(true)).toBe(false)
  })
})
