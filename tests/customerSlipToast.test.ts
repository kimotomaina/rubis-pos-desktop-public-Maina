/**
 * The toast for a customer slip that did not print (docs/phase-198).
 * `tests/autoPrintToast.test.ts` is unchanged; this covers the new branch.
 */

import { describe, it, expect } from 'vitest'
import {
  AUTO_PRINT_OFFLINE_MESSAGE,
  CUSTOMER_SLIP_FAILURE_MESSAGE,
  getAutoPrintOfflineMessage
} from '../src/renderer/src/lib/autoPrintToast.js'

describe('getAutoPrintOfflineMessage with the customer slip', () => {
  it('says the customer slip did not print when only that slip failed', () => {
    expect(
      getAutoPrintOfflineMessage({ success: true, data: { printed: true, mock: false, customerSlip: 'failed' } })
    ).toBe(CUSTOMER_SLIP_FAILURE_MESSAGE)
  })

  it('needs no toast when both slips printed', () => {
    expect(
      getAutoPrintOfflineMessage({ success: true, data: { printed: true, mock: false, customerSlip: 'printed' } })
    ).toBeNull()
  })

  it('gives the printer-offline message first when the fiscal slip fell back to a PDF', () => {
    expect(
      getAutoPrintOfflineMessage({
        success: true,
        data: { printed: false, mock: false, mode: 'pdf', customerSlip: 'failed' }
      })
    ).toBe(AUTO_PRINT_OFFLINE_MESSAGE)
  })

  it('tells the cashier where to reprint it from', () => {
    expect(CUSTOMER_SLIP_FAILURE_MESSAGE).toContain('Order History')
  })
})
