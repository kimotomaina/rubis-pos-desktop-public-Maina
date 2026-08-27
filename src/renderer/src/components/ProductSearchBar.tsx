interface ProductSearchBarProps {
  value: string
  onChange: (query: string) => void
  onFocus: () => void
  onBlur: () => void
}

/**
 * Catalog search box — filters the product grid by typed text (product/
 * variant title) or by a typed/scanned barcode.
 *
 * Deliberately a plain `<input>` with no surrounding `<form>` so Enter
 * has no default action; filtering happens on every keystroke via
 * `onChange` rather than on submit.
 *
 * @param {ProductSearchBarProps} props
 * @returns {JSX.Element}
 */
export default function ProductSearchBar({
  value,
  onChange,
  onFocus,
  onBlur
}: ProductSearchBarProps) {
  return (
    <div className="relative w-full flex-1">
      <svg
        className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z"
        />
      </svg>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={onFocus}
        onBlur={onBlur}
        placeholder="Search products or scan barcode…"
        className="h-12 w-full rounded-lg border border-slate-300 pl-11 pr-10 text-lg focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          aria-label="Clear search"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      )}
    </div>
  )
}
