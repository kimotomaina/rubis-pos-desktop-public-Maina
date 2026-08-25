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
    <div className="relative w-full max-w-xs">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
        🔍
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={onFocus}
        onBlur={onBlur}
        placeholder="Search products or scan barcode…"
        className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-8 text-sm focus:border-rose-400 focus:outline-none"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          aria-label="Clear search"
        >
          ✕
        </button>
      )}
    </div>
  )
}
