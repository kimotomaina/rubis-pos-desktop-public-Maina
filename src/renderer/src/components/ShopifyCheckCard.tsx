import { useShopifyReconciliationStore } from '../stores/shopifyReconciliationStore.js'
import { describeReconciliationCard } from '../lib/shopifyReconciliation.js'
import type { ReconciliationResult } from '../../../main/services/reconciliation.js'

interface ShopifyCheckCardProps {
  /**
   * check:fit-only synthetic override (docs/phase-170 commit 3) - never
   * set on a real launch. When present, the live store is never read at
   * all, matching every other synthetic check:fit screen's own
   * renderer-only, no-IPC-call contract.
   */
  resultOverride?: ReconciliationResult
}

/**
 * Admin > Needs Attention's "Shopify check" card (docs/phase-170,
 * design docs/phase-168 section 2.6): the last run time, then one
 * plain line per finding. Nothing here is interactive yet - resolving
 * a held/duplicate sale is a follow-up decision (docs/phase-168's own
 * note), so this only ever reports.
 *
 * @param {ShopifyCheckCardProps} props
 * @returns {JSX.Element}
 */
export default function ShopifyCheckCard({ resultOverride }: ShopifyCheckCardProps) {
  // The store's `init()` is called once, globally, from App.tsx — same
  // convention as `useUnfiledCountStore` — so this component only ever
  // reads.
  const stored = useShopifyReconciliationStore((state) => state.result)
  const result = resultOverride ?? stored
  const { headline, lines } = describeReconciliationCard(result)
  const failed = result !== null && !result.ok

  return (
    <div
      className={`rounded-xl border p-4 ${
        failed ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-white'
      }`}
    >
      <h4 className="text-lg font-semibold text-slate-800">{headline}</h4>
      {lines.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {lines.map((line, index) => (
            <li key={index} className="text-base text-slate-700">
              {line}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
