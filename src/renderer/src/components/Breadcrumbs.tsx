export interface BreadcrumbItem {
  label: string
  /** Where tapping this crumb goes. The last crumb is the current page and is never a button. */
  onClick?: () => void
}

interface BreadcrumbsProps {
  items: BreadcrumbItem[]
}

/**
 * The Admin screen's trail back up the card grids, on one row
 * (`Admin › Integrations › Fiscal Device`), replacing a stack of
 * "Back to ..." buttons one above the other. Each ancestor is a large touch
 * target; the last item is plain text marked as the current page. An
 * ancestor reads "Back to <label>" to a screen reader, as the buttons it
 * replaces did, while showing only its name.
 *
 * @param {BreadcrumbsProps} props
 * @returns {JSX.Element}
 */
export default function Breadcrumbs({ items }: BreadcrumbsProps) {
  return (
    <nav aria-label="Breadcrumb" className="mb-4">
      <ol className="flex flex-wrap items-center gap-1">
        {items.map((item, index) => {
          const isCurrent = index === items.length - 1
          return (
            <li key={item.label} className="flex items-center gap-1">
              {index > 0 && (
                <span aria-hidden="true" className="text-xl text-slate-400">
                  ›
                </span>
              )}
              {isCurrent || !item.onClick ? (
                <span aria-current="page" className="px-3 text-lg font-semibold text-slate-700">
                  {item.label}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={item.onClick}
                  className="flex h-14 items-center rounded-lg px-3 text-lg font-semibold text-rose-600 transition hover:bg-rose-50 active:scale-95"
                >
                  <span className="sr-only">Back to </span>
                  {item.label}
                </button>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
