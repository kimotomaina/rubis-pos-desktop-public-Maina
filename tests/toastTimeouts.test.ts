/**
 * `toastTimeouts` tests (phase-84, Task 2).
 *
 * Every toast's duration is a named, exported constant rather than a
 * magic number buried in a component — this asserts each one directly,
 * per producer, including the one standing exception (the fiscal
 * notice never auto-dismisses).
 */

import { describe, it, expect } from 'vitest'
import {
  CONNECTIVITY_TOAST_TIMEOUT_MS,
  SCAN_TOAST_TIMEOUT_MS,
  SALE_COMPLETE_TOAST_TIMEOUT_MS,
  UPDATE_TOAST_TIMEOUT_MS,
  FISCAL_NOTICE_TIMEOUT_MS
} from '../src/renderer/src/lib/toastTimeouts.js'

describe('toast timeouts', () => {
  it('ConnectivityToast auto-dismisses after 5 seconds', () => {
    expect(CONNECTIVITY_TOAST_TIMEOUT_MS).toBe(5000)
  })

  it('the scan/search feedback toast auto-dismisses after 2.5 seconds', () => {
    expect(SCAN_TOAST_TIMEOUT_MS).toBe(2500)
  })

  it('the sale-complete toast auto-dismisses after 5 seconds', () => {
    expect(SALE_COMPLETE_TOAST_TIMEOUT_MS).toBe(5000)
  })

  it('UpdateToast auto-dismisses after a generous 5 minutes (an available update must not be lost)', () => {
    expect(UPDATE_TOAST_TIMEOUT_MS).toBe(5 * 60 * 1000)
  })

  it('the fiscal notice never auto-dismisses — the standing exception', () => {
    expect(FISCAL_NOTICE_TIMEOUT_MS).toBeNull()
  })

  it('every timeout is either null or a positive number of milliseconds', () => {
    for (const value of [
      CONNECTIVITY_TOAST_TIMEOUT_MS,
      SCAN_TOAST_TIMEOUT_MS,
      SALE_COMPLETE_TOAST_TIMEOUT_MS,
      UPDATE_TOAST_TIMEOUT_MS,
      FISCAL_NOTICE_TIMEOUT_MS
    ]) {
      expect(value === null || value > 0).toBe(true)
    }
  })
})
