/**
 * Pure helper tests for the Admin "Shopify check" card (docs/phase-170
 * commit 3). Matches `needsAttention.test.ts`'s convention: tested
 * directly, no component mounted, no Shopify call.
 */

import { describe, it, expect } from 'vitest'
import {
  describeFinding,
  isActionableFinding,
  countActionableFindings,
  describeReconciliationCard,
  CASHIER_NOTICE_MESSAGE
} from '../src/renderer/src/lib/shopifyReconciliation.js'
import type { ReconciliationFinding, ReconciliationResult } from '../src/main/services/reconciliation.js'

describe('describeFinding', () => {
  it('linked - uses the Shopify order name', () => {
    const finding: ReconciliationFinding = {
      kind: 'linked',
      localId: 12,
      shopifyOrderId: 'gid://shopify/Order/1',
      shopifyName: '#1043'
    }
    expect(describeFinding(finding)).toBe(
      'Sale #12 was already in Shopify as order #1043. It has been linked and will not be sent again.'
    )
  })

  it('linked - falls back to the raw id when Shopify gave no name', () => {
    const finding: ReconciliationFinding = {
      kind: 'linked',
      localId: 12,
      shopifyOrderId: 'gid://shopify/Order/1',
      shopifyName: null
    }
    expect(describeFinding(finding)).toContain('as order gid://shopify/Order/1.')
  })

  it('duplicate - lists every matching order by name', () => {
    const finding: ReconciliationFinding = {
      kind: 'duplicate',
      localId: 15,
      shopifyIds: ['gid://shopify/Order/1', 'gid://shopify/Order/2'],
      shopifyNames: ['#1050', '#1051']
    }
    expect(describeFinding(finding)).toBe(
      'Sale #15 is in Shopify more than once (#1050, #1051). Nothing was changed. It will not be sent again until a manager checks it.'
    )
  })

  it('held-cancelled', () => {
    const finding: ReconciliationFinding = { kind: 'held-cancelled', localId: 18, shopifyId: 'gid://shopify/Order/9' }
    expect(describeFinding(finding)).toBe(
      'Sale #18 matched a cancelled Shopify order (gid://shopify/Order/9). Nothing was changed. It will not be sent again until a manager checks it.'
    )
  })

  it('missing', () => {
    const finding: ReconciliationFinding = { kind: 'missing', localId: 20, shopifyOrderId: 'gid://shopify/Order/60' }
    expect(describeFinding(finding)).toBe(
      'Sale #20 is marked as sent, but Shopify has no order gid://shopify/Order/60. Nothing was changed.'
    )
  })
})

describe('isActionableFinding / countActionableFindings', () => {
  const linked: ReconciliationFinding = { kind: 'linked', localId: 1, shopifyOrderId: 'x', shopifyName: null }
  const missing: ReconciliationFinding = { kind: 'missing', localId: 2, shopifyOrderId: 'x' }
  const held: ReconciliationFinding = { kind: 'held-cancelled', localId: 3, shopifyId: 'x' }
  const duplicate: ReconciliationFinding = { kind: 'duplicate', localId: 4, shopifyIds: ['x'], shopifyNames: [null] }

  it('an automatic link needs no one\'s attention', () => {
    expect(isActionableFinding(linked)).toBe(false)
  })

  it('missing, held-cancelled and duplicate all need attention', () => {
    expect(isActionableFinding(missing)).toBe(true)
    expect(isActionableFinding(held)).toBe(true)
    expect(isActionableFinding(duplicate)).toBe(true)
  })

  it('counts only the actionable findings', () => {
    const result: ReconciliationResult = {
      checkedAt: 0,
      ok: true,
      findings: [linked, missing, held, duplicate],
      otherTillsCount: 0
    }
    expect(countActionableFindings(result)).toBe(3)
  })

  it('a null result (never run, or check:fit mode) counts as zero', () => {
    expect(countActionableFindings(null)).toBe(0)
  })
})

describe('describeReconciliationCard', () => {
  it('never run: a plain headline, no lines', () => {
    expect(describeReconciliationCard(null)).toEqual({ headline: 'Shopify check: not yet run.', lines: [] })
  })

  it('failed: the failure reason as the one line', () => {
    const result: ReconciliationResult = {
      checkedAt: new Date('2026-09-27T10:00:00Z').getTime(),
      ok: false,
      failureReason: 'This till is not allowed to read Shopify orders.',
      findings: [],
      otherTillsCount: null
    }
    const card = describeReconciliationCard(result)
    expect(card.headline).toMatch(/could not finish/i)
    expect(card.lines).toEqual(['This till is not allowed to read Shopify orders.'])
  })

  it('ok with findings: one line per finding, plus the other-tills line last', () => {
    const result: ReconciliationResult = {
      checkedAt: new Date('2026-09-27T10:00:00Z').getTime(),
      ok: true,
      findings: [{ kind: 'missing', localId: 20, shopifyOrderId: 'gid://shopify/Order/60' }],
      otherTillsCount: 340
    }
    const card = describeReconciliationCard(result)
    expect(card.headline).toMatch(/last run/i)
    expect(card.lines).toHaveLength(2)
    expect(card.lines[0]).toContain('Sale #20')
    expect(card.lines[1]).toBe('Other tills and channels: about 340 order(s) in the last 7 days (not checked).')
  })

  it('ok with nothing to report: a plain "nothing needs attention" line', () => {
    const result: ReconciliationResult = {
      checkedAt: new Date('2026-09-27T10:00:00Z').getTime(),
      ok: true,
      findings: [],
      otherTillsCount: null
    }
    expect(describeReconciliationCard(result).lines).toEqual(['Nothing needs attention.'])
  })
})

describe('CASHIER_NOTICE_MESSAGE', () => {
  it('is the exact plain line the brief specifies', () => {
    expect(CASHIER_NOTICE_MESSAGE).toBe('Some sales need a manager to check them in Shopify. See Admin > Needs Attention.')
  })
})
