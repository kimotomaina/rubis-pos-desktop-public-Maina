/**
 * `getAutoPrintOfflineMessage` tests (docs/phase-165, docs/phase-166
 * Commit 0).
 *
 * Pure derivation, tested directly without mounting anything — same
 * convention as `saleCompleteToast.ts`/`fiscalNotice.ts`.
 */

import { describe, it, expect } from 'vitest'
import {
  AUTO_PRINT_FAILURE_MESSAGE,
  AUTO_PRINT_OFFLINE_MESSAGE,
  getAutoPrintOfflineMessage
} from '../src/renderer/src/lib/autoPrintToast.js'

describe('getAutoPrintOfflineMessage', () => {
  it('returns the offline notice when the automatic print fell back to a PDF', () => {
    expect(
      getAutoPrintOfflineMessage({
        success: true,
        data: { printed: false, mock: false, mode: 'pdf', filePath: 'C:\\Desktop\\r.pdf' }
      })
    ).toBe(AUTO_PRINT_OFFLINE_MESSAGE)
  })

  it('returns null for a genuine physical print', () => {
    expect(getAutoPrintOfflineMessage({ success: true, data: { printed: true, mock: false } })).toBeNull()
  })

  it('returns null for a mock-mode print', () => {
    expect(getAutoPrintOfflineMessage({ success: true, data: { printed: true, mock: true } })).toBeNull()
  })

  it('returns the failure notice for an outright failure (docs/phase-166 Commit 0)', () => {
    expect(getAutoPrintOfflineMessage({ success: false, error: 'Printer error' })).toBe(
      AUTO_PRINT_FAILURE_MESSAGE
    )
  })
})
