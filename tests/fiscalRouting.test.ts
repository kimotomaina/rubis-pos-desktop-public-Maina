/**
 * Fiscal routing tests (phase-71, Step 1 of the failed-sales-handling
 * feature) — `routeFiscalOutcome`/`classifyThrownFiscalError` are pure
 * functions, extracted from `main/index.ts`'s checkout handler
 * specifically so the classification-to-status/queue mapping is
 * unit-testable without mocking Electron IPC, the database, or the
 * fiscal engine.
 */

import { describe, it, expect } from 'vitest'
import {
  routeFiscalOutcome,
  classifyThrownFiscalError
} from '../src/main/services/fiscal-routing.js'
import type { FiscalSubmitOutcome } from '../src/main/services/integrations/etims.js'

describe('routeFiscalOutcome', () => {
  it('routes success to fiscalized, never enqueued', () => {
    const outcome: FiscalSubmitOutcome = {
      ok: true,
      data: { invoiceNumber: 'KRA-0001', qrCode: 'base64qr', fiscalizedAt: '2026-01-01T00:00:00.000Z' }
    }

    expect(routeFiscalOutcome(outcome)).toEqual({ status: 'fiscalized', enqueue: false })
  })

  it('routes a transient/technical failure (e.g. device unreachable) to waiting, enqueued', () => {
    const outcome: FiscalSubmitOutcome = {
      ok: false,
      reason: 'ZFPLabServer cannot reach the fiscal device',
      kind: 'technical',
      retryable: true
    }

    expect(routeFiscalOutcome(outcome)).toEqual({ status: 'waiting', enqueue: true })
  })

  it('routes a business rejection of the sale\'s data (e.g. wrong PIN) to needs_fixing, NOT enqueued', () => {
    const outcome: FiscalSubmitOutcome = {
      ok: false,
      reason: 'Wrong client PIN',
      kind: 'data',
      retryable: false
    }

    expect(routeFiscalOutcome(outcome)).toEqual({ status: 'needs_fixing', enqueue: false })
  })

  it('routes a malformed-request/system failure (Code 63) to needs_fixing, NOT enqueued', () => {
    const outcome: FiscalSubmitOutcome = {
      ok: false,
      reason: 'ZFPLabServer rejected the request format',
      kind: 'system',
      retryable: false
    }

    expect(routeFiscalOutcome(outcome)).toEqual({ status: 'needs_fixing', enqueue: false })
  })

  it('routes purely off `retryable`, independent of the message text', () => {
    const retryable: FiscalSubmitOutcome = {
      ok: false,
      reason: 'anything at all',
      kind: 'technical',
      retryable: true
    }
    const notRetryable: FiscalSubmitOutcome = {
      ok: false,
      reason: 'anything at all',
      kind: 'data',
      retryable: false
    }

    expect(routeFiscalOutcome(retryable).enqueue).toBe(true)
    expect(routeFiscalOutcome(notRetryable).enqueue).toBe(false)
  })

  it('never routes a failure to fiscalized, and never routes success to waiting/needs_fixing', () => {
    const failure: FiscalSubmitOutcome = {
      ok: false,
      reason: 'x',
      kind: 'technical',
      retryable: true
    }
    const success: FiscalSubmitOutcome = {
      ok: true,
      data: { invoiceNumber: 'KRA-0002', qrCode: '', fiscalizedAt: '2026-01-01T00:00:00.000Z' }
    }

    expect(routeFiscalOutcome(failure).status).not.toBe('fiscalized')
    expect(routeFiscalOutcome(success).status).toBe('fiscalized')
  })
})

describe('classifyThrownFiscalError', () => {
  it('extracts the message from an Error instance, classified technical', () => {
    expect(classifyThrownFiscalError(new Error('boom'))).toEqual({
      reason: 'boom',
      kind: 'technical'
    })
  })

  it('stringifies a non-Error throw', () => {
    expect(classifyThrownFiscalError('a raw string throw')).toEqual({
      reason: 'a raw string throw',
      kind: 'technical'
    })
    expect(classifyThrownFiscalError(42)).toEqual({ reason: '42', kind: 'technical' })
  })
})
