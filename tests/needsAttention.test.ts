/**
 * Pure helper tests for the "needs attention" list (phase-94).
 *
 * Matches `fiscalNotice.test.ts`'s convention: tested directly, no
 * component mounted.
 */

import { describe, it, expect } from 'vitest'
import {
  describeNeedsAttentionStatus,
  resendClearsRow,
  applyResendResult
} from '../src/renderer/src/lib/needsAttention.js'
import type { NeedsAttentionRow, FiscalResendResult } from '../src/main/services/database.js'

const WAITING_ROW: NeedsAttentionRow = {
  local_id: 1,
  created_at: '2026-09-07T05:00:00.000Z',
  total: 139.2,
  staff_name: 'Alex',
  fiscal_status: 'waiting',
  fiscal_error_reason: 'Fiscal server error (Code 30): ZFPLabServer cannot reach the fiscal device',
  fiscal_error_kind: 'technical',
  fiscal_data_issue: null
}

const WRONG_PIN_ROW: NeedsAttentionRow = {
  local_id: 2,
  created_at: '2026-09-07T05:10:00.000Z',
  total: 250,
  staff_name: 'Alex',
  fiscal_status: 'needs_fixing',
  fiscal_error_reason: 'Fiscal device error (Code 40): Wrong client PIN',
  fiscal_error_kind: 'data',
  fiscal_data_issue: 'wrong-pin'
}

describe('describeNeedsAttentionStatus', () => {
  it('labels a waiting row as stuck, not "needs fixing"', () => {
    expect(describeNeedsAttentionStatus('waiting')).toBe('Stuck — retrying automatically')
  })

  it('labels a needs_fixing row plainly', () => {
    expect(describeNeedsAttentionStatus('needs_fixing')).toBe('Needs fixing')
  })
})

describe('resendClearsRow', () => {
  it('is true once the sale is fiscalized', () => {
    const result: FiscalResendResult = {
      localId: 1,
      fiscal: { invoiceNumber: '0000000000000000042', qrCode: 'QR' },
      fiscalStatus: 'fiscalized',
      fiscalErrorReason: null,
      fiscalErrorKind: null,
      fiscalDataIssue: null
    }
    expect(resendClearsRow(result)).toBe(true)
  })

  it('is false while still waiting or needing fixing', () => {
    const result: FiscalResendResult = {
      localId: 1,
      fiscal: undefined,
      fiscalStatus: 'needs_fixing',
      fiscalErrorReason: 'Fiscal server error (Code 63): ZFPLabServer rejected the request format',
      fiscalErrorKind: 'system',
      fiscalDataIssue: null
    }
    expect(resendClearsRow(result)).toBe(false)
  })
})

describe('applyResendResult', () => {
  it('drops the row once it fiscalizes', () => {
    const result: FiscalResendResult = {
      localId: 1,
      fiscal: { invoiceNumber: '0000000000000000777', qrCode: 'QR' },
      fiscalStatus: 'fiscalized',
      fiscalErrorReason: null,
      fiscalErrorKind: null,
      fiscalDataIssue: null
    }
    const next = applyResendResult([WAITING_ROW, WRONG_PIN_ROW], result)
    expect(next.map((r) => r.local_id)).toEqual([2])
  })

  it('keeps a still-failing row but updates its reason and reclassifies its status', () => {
    const result: FiscalResendResult = {
      localId: 1,
      fiscal: undefined,
      fiscalStatus: 'needs_fixing',
      fiscalErrorReason: 'Fiscal device error (Code 40): Wrong client PIN',
      fiscalErrorKind: 'data',
      fiscalDataIssue: 'wrong-pin'
    }
    const next = applyResendResult([WAITING_ROW, WRONG_PIN_ROW], result)
    const updated = next.find((r) => r.local_id === 1)
    expect(updated?.fiscal_status).toBe('needs_fixing')
    expect(updated?.fiscal_error_reason).toBe('Fiscal device error (Code 40): Wrong client PIN')
    expect(updated?.fiscal_data_issue).toBe('wrong-pin')
  })

  it('leaves other rows untouched', () => {
    const result: FiscalResendResult = {
      localId: 1,
      fiscal: undefined,
      fiscalStatus: 'waiting',
      fiscalErrorReason: 'Fiscal server error (Code 30): ZFPLabServer cannot reach the fiscal device',
      fiscalErrorKind: 'technical',
      fiscalDataIssue: null
    }
    const next = applyResendResult([WAITING_ROW, WRONG_PIN_ROW], result)
    expect(next.find((r) => r.local_id === 2)).toEqual(WRONG_PIN_ROW)
  })
})
