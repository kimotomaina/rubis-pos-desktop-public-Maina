interface PagerProps {
  page: number
  pageCount: number
  onChange: (page: number) => void
}

/**
 * Shared Previous/Next pager (docs/phase-166 Commit E4) — the same
 * shape `ReportsPage.tsx`'s own local `Pager` and `EndOfDayPage.tsx`'s
 * hand-rolled buttons already use, extracted here so new call sites
 * (the cart, Order History, Needs Attention, M-Pesa logs) don't each
 * duplicate it a third/fourth/fifth time. `ReportsPage.tsx`'s and
 * `EndOfDayPage.tsx`'s existing copies are deliberately left as they
 * are — out of scope for this change.
 *
 * Renders nothing when there is only one page, matching every existing
 * caller's convention: the controls appear only once paging is actually
 * possible.
 *
 * @param {PagerProps} props
 * @returns {JSX.Element | null}
 */
export default function Pager({ page, pageCount, onChange }: PagerProps) {
  if (pageCount <= 1) return null
  return (
    <div className="flex items-center justify-between gap-3">
      <button
        type="button"
        onClick={() => onChange(page - 1)}
        disabled={page <= 1}
        className="h-10 rounded-lg border border-slate-300 px-3 text-base font-medium text-slate-600 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Previous
      </button>
      <span className="text-base text-slate-500">
        Page {page} of {pageCount}
      </span>
      <button
        type="button"
        onClick={() => onChange(page + 1)}
        disabled={page >= pageCount}
        className="h-10 rounded-lg border border-slate-300 px-3 text-base font-medium text-slate-600 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Next
      </button>
    </div>
  )
}
