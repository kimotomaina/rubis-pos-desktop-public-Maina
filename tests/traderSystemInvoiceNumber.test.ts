/**
 * Conformance test for `traderSystemInvoiceNumber.ts`'s deliberate
 * duplicate of `RealFiscalizationProvider.buildTraderSystemInvNum`
 * (docs/phase-158 — that method is private, and this phase's hard rules
 * forbid changing `real-etims-provider.ts`, so the format is
 * reimplemented here rather than imported; see that file's own doc
 * comment for the full reasoning).
 *
 * The expected values below are taken directly from
 * `tests/realEtimsProvider.test.ts`'s own assertions against the real
 * method (`'uses a zero-padded INV-<localId>...'`, `'falls back to a
 * truncated clientOrderUuid...'`) — if the real provider's format ever
 * changes, those tests fail first, and this file's own fixtures should
 * be updated to match, keeping the two in lock-step by inspection rather
 * than by import.
 */

import { describe, it, expect } from 'vitest'
import {
  buildTraderSystemInvNum,
  MAX_TRADER_SYSTEM_INV_NUM_LENGTH
} from '../src/main/lib/traderSystemInvoiceNumber.js'

describe('buildTraderSystemInvNum', () => {
  it('zero-pads a localId to INV-<9 digits>, matching realEtimsProvider.test.ts localId=42 case', () => {
    expect(buildTraderSystemInvNum(42, 'unused')).toBe('INV-000000042')
  })

  it('matches realEtimsProvider.test.ts’s localId=7 case (same TraderSystemInvNum across a retry)', () => {
    expect(buildTraderSystemInvNum(7, 'unused')).toBe('INV-000000007')
  })

  it('never exceeds MAX_TRADER_SYSTEM_INV_NUM_LENGTH characters', () => {
    expect(buildTraderSystemInvNum(42, 'unused').length).toBeLessThanOrEqual(
      MAX_TRADER_SYSTEM_INV_NUM_LENGTH
    )
    expect(MAX_TRADER_SYSTEM_INV_NUM_LENGTH).toBe(15)
  })

  it('falls back to a dash-stripped, truncated clientOrderUuid when localId is undefined, matching realEtimsProvider.test.ts', () => {
    expect(buildTraderSystemInvNum(undefined, '11111111-2222-3333-4444-555555555555')).toBe(
      '111111112222333'
    )
  })

  it('produces different numbers for different orders', () => {
    expect(buildTraderSystemInvNum(1, '')).not.toBe(buildTraderSystemInvNum(2, ''))
  })
})
