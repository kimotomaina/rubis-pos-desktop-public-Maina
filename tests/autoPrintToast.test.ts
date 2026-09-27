/**
 * `getAutoPrintOfflineMessage` tests (docs/phase-165).
 *
 * Pure derivation, tested directly without mounting anything — same
 * convention as `saleCompleteToast.ts`/`fiscalNotice.ts`.
 */

import { describe, it, expect } from 'vitest'
import { getAutoPrintOfflineMessage } from '../src/renderer/src/lib/autoPrintToast.js'

describe('getAutoPrintOfflineMessage', () => {
  it('returns the offline notice when the automatic print fell back to a PDF', () => {
    expect(
      getAutoPrintOfflineMessage({
        success: true,
        data: { printed: false, mock: false, mode: 'pdf', filePath: 'C:\\Desktop\\r.pdf' }
      })
    ).toBe('Printer offline. Receipt saved; print it from Order History when the printer is back.')
  })

  it('returns null for a genuine physical print', () => {
    expect(getAutoPrintOfflineMessage({ success: true, data: { printed: true, mock: false } })).toBeNull()
  })

  it('returns null for a mock-mode print', () => {
    expect(getAutoPrintOfflineMessage({ success: true, data: { printed: true, mock: true } })).toBeNull()
  })

  it('returns null for an outright failure — never surfaces as an error toast', () => {
    expect(getAutoPrintOfflineMessage({ success: false, error: 'Printer error' })).toBeNull()
  })
})
