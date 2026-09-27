import { useState, type ReactNode } from 'react'
import { paginate } from '../lib/paginate.js'
import Pager from './Pager.js'

/** One tile in a `SectionCardGrid` — icon and title only, per the brief (no helper text). */
export interface SectionCard<K extends string> {
  key: K
  label: string
  icon: ReactNode
  /** A count badge, top-right — omitted (or `0`) shows no badge at all. */
  badge?: number
}

interface SectionCardGridProps<K extends string> {
  sections: SectionCard<K>[]
  onSelect: (key: K) => void
}

/** Cards per page — a 3x3 grid, the same shape `LocationPicker`'s card grid already uses. */
const CARDS_PER_PAGE = 9

/**
 * A 3x3 grid of large card buttons, one per section (phase-167) —
 * replaces a tab strip at every level of Admin (the top level itself,
 * Integrations' five sections, Reports' six views). Paginated at
 * {@link CARDS_PER_PAGE} the same way `LocationPicker` already
 * paginates its own card grid, so a future section list longer than 9
 * degrades to paging rather than an unbounded, scrolling grid.
 *
 * @param {SectionCardGridProps<K>} props
 * @returns {JSX.Element}
 */
export default function SectionCardGrid<K extends string>({
  sections,
  onSelect
}: SectionCardGridProps<K>) {
  const [page, setPage] = useState(1)
  const pageResult = paginate(sections, page, CARDS_PER_PAGE)

  return (
    <div>
      <div className="grid grid-cols-3 gap-3">
        {pageResult.items.map((section) => (
          <button
            key={section.key}
            type="button"
            onClick={() => onSelect(section.key)}
            className="relative flex h-24 flex-col items-center justify-center gap-1.5 rounded-2xl border-2 border-slate-200 bg-white text-base font-semibold text-slate-800 transition hover:border-rose-300 hover:bg-rose-50 active:scale-95"
          >
            {!!section.badge && (
              <span className="absolute right-2 top-2 flex h-6 min-w-6 items-center justify-center rounded-full bg-rose-600 px-1.5 text-sm font-bold text-white">
                {section.badge}
              </span>
            )}
            {section.icon}
            {section.label}
          </button>
        ))}
      </div>
      {pageResult.pageCount > 1 && (
        <div className="mt-3">
          <Pager page={pageResult.page} pageCount={pageResult.pageCount} onChange={setPage} />
        </div>
      )}
    </div>
  )
}
