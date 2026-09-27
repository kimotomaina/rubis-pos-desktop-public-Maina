/**
 * Plain-language rendering of the Shopify sales-safety check's result
 * (docs/phase-170, wording per docs/phase-168 section 2.6). Kept
 * dependency-free (no React, no store) so it can be unit tested
 * directly.
 */

import type { ReconciliationFinding, ReconciliationResult } from '../../../main/services/reconciliation.js'

/**
 * One finding, as a single plain sentence for the Admin "Shopify
 * check" card. Uses the Shopify order NAME (e.g. `#1043`) when known,
 * falling back to the raw id only if Shopify never returned a name.
 *
 * @param {ReconciliationFinding} finding
 * @returns {string}
 */
export function describeFinding(finding: ReconciliationFinding): string {
  switch (finding.kind) {
    case 'linked':
      return `Sale #${finding.localId} was already in Shopify as order ${finding.shopifyName ?? finding.shopifyOrderId}. It has been linked and will not be sent again.`
    case 'duplicate': {
      const names = finding.shopifyNames.map((name, i) => name ?? finding.shopifyIds[i]).join(', ')
      return `Sale #${finding.localId} is in Shopify more than once (${names}). Nothing was changed. It will not be sent again until a manager checks it.`
    }
    case 'held-cancelled':
      return `Sale #${finding.localId} matched a cancelled Shopify order (${finding.shopifyId}). Nothing was changed. It will not be sent again until a manager checks it.`
    case 'missing':
      return `Sale #${finding.localId} is marked as sent, but Shopify has no order ${finding.shopifyOrderId}. Nothing was changed.`
  }
}

/**
 * Whether a finding needs a person to look at it - everything except
 * an automatic link, which needed no one's attention at all.
 *
 * @param {ReconciliationFinding} finding
 * @returns {boolean}
 */
export function isActionableFinding(finding: ReconciliationFinding): boolean {
  return finding.kind !== 'linked'
}

/**
 * How many of this result's findings need a person - added to the
 * Needs Attention badge (docs/phase-170 commit 3's own instruction).
 * `null` result (never run, or check:fit mode) counts as zero.
 *
 * @param {ReconciliationResult | null} result
 * @returns {number}
 */
export function countActionableFindings(result: ReconciliationResult | null): number {
  if (!result) return 0
  return result.findings.filter(isActionableFinding).length
}

/** The Admin card's content, already split into a headline and a plain line per finding. */
export interface ShopifyCheckCardContent {
  headline: string
  lines: string[]
}

/**
 * Builds the Admin "Shopify check" card's content from the latest
 * result - one plain line per finding, then the "other tills" line
 * last, since it is informational rather than something to act on.
 *
 * @param {ReconciliationResult | null} result
 * @returns {ShopifyCheckCardContent}
 */
export function describeReconciliationCard(result: ReconciliationResult | null): ShopifyCheckCardContent {
  if (!result) {
    return { headline: 'Shopify check: not yet run.', lines: [] }
  }

  const when = new Date(result.checkedAt).toLocaleString()

  if (!result.ok) {
    return {
      headline: `Shopify check: could not finish (last tried ${when}).`,
      lines: [result.failureReason ?? 'Unknown problem.']
    }
  }

  const lines = result.findings.map(describeFinding)
  if (result.otherTillsCount !== null) {
    lines.push(`Other tills and channels: about ${result.otherTillsCount} order(s) in the last 7 days (not checked).`)
  }
  if (lines.length === 0) {
    lines.push('Nothing needs attention.')
  }

  return { headline: `Shopify check: last run ${when}.`, lines }
}

/** The one cashier-facing line shown only when a person must act (docs/phase-170 commit 3's own wording). */
export const CASHIER_NOTICE_MESSAGE =
  'Some sales need a manager to check them in Shopify. See Admin > Needs Attention.'
