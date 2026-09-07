import { useEffect, useRef, useState } from 'react'
import type { ProductSummary, VariantSummary } from '../types/shopify.js'
import { formatCurrency } from '../lib/currency.js'
import {
  findVariantByBarcode,
  getAutocompleteMatches,
  resolveSingleVariant
} from '../lib/posSearch.js'

/** Debounce before the dropdown's matches recompute, per Phase 44's performance rule. */
const AUTOCOMPLETE_DEBOUNCE_MS = 100

interface PosSearchBarProps {
  products: ProductSummary[]
  /** A single-variant product (or the chosen variant of a multi-variant one) resolved to add. */
  onAddVariant: (product: ProductSummary, variant: VariantSummary) => void
  /** A multi-variant product was chosen and needs the variant picker instead of an immediate add. */
  onOpenVariantPicker: (product: ProductSummary) => void
  /** Neither an exact barcode nor any text match was found for the submitted query. */
  onNotFound: (query: string) => void
  /** Reports focus state so the caller can disable the global multi-station scanner listener while this field owns keystrokes. */
  onFocusChange?: (focused: boolean) => void
}

/**
 * Sticky catalog search/scan entry point — the single input a cashier
 * both types product names into and scans barcodes into.
 *
 * A barcode scanner behaves like a very fast keyboard ending in Enter,
 * so `resolve()` (fired on Enter) always checks for an *exact* barcode
 * match against the live `query` first, independent of the debounced
 * autocomplete list — a scan is added the instant Enter fires, never
 * waiting on the 100ms debounce. Only the fallback path (no exact
 * barcode; use the first/`highlightedIndex` autocomplete row) depends
 * on the debounced matches, since that path only fires for genuine
 * human typing where 100ms is imperceptible.
 *
 * @param {PosSearchBarProps} props
 * @returns {JSX.Element}
 */
export default function PosSearchBar({
  products,
  onAddVariant,
  onOpenVariantPicker,
  onNotFound,
  onFocusChange
}: PosSearchBarProps) {
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setDebouncedQuery(query), AUTOCOMPLETE_DEBOUNCE_MS)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query])

  const results = getAutocompleteMatches(products, debouncedQuery)

  useEffect(() => {
    setHighlightedIndex(0)
  }, [results.length, debouncedQuery])

  /** Adds a product, resolving its variant automatically when it only has one. */
  const selectProduct = (product: ProductSummary) => {
    const singleVariant = resolveSingleVariant(product)
    if (singleVariant) {
      onAddVariant(product, singleVariant)
    } else {
      onOpenVariantPicker(product)
    }
    setQuery('')
    setDebouncedQuery('')
  }

  const resolve = () => {
    const trimmed = query.trim()
    if (!trimmed) return

    const barcodeMatch = findVariantByBarcode(products, trimmed)
    if (barcodeMatch) {
      onAddVariant(barcodeMatch.product, barcodeMatch.variant)
      setQuery('')
      setDebouncedQuery('')
      return
    }

    const liveResults = getAutocompleteMatches(products, trimmed)
    const chosen = liveResults[highlightedIndex] ?? liveResults[0]
    if (chosen) {
      selectProduct(chosen)
      return
    }

    onNotFound(trimmed)
    setQuery('')
    setDebouncedQuery('')
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      resolve()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlightedIndex((prev) => Math.min(prev + 1, results.length - 1))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlightedIndex((prev) => Math.max(prev - 1, 0))
    }
  }

  const showDropdown = query.trim().length > 0 && results.length > 0

  return (
    <div className="sticky top-0 z-20 border-b border-slate-200 bg-white p-4">
      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => onFocusChange?.(true)}
          onBlur={() => onFocusChange?.(false)}
          placeholder="SCAN BARCODE OR TYPE NAME..."
          aria-label="Scan barcode or search products"
          autoComplete="off"
          className="h-14 w-full rounded-lg border border-slate-300 px-4 text-lg font-medium uppercase tracking-wide placeholder:normal-case focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
        />

        {showDropdown && (
          <ul
            role="listbox"
            className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg"
          >
            {results.map((product, index) => {
              const variant = product.variants[0]
              return (
                <li key={product.id} role="option" aria-selected={index === highlightedIndex}>
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault()
                      selectProduct(product)
                    }}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    className={`flex min-h-16 w-full items-center gap-3 px-4 py-2 text-left transition ${
                      index === highlightedIndex ? 'bg-rose-50' : 'bg-white'
                    }`}
                  >
                    <div className="h-12 w-12 shrink-0 overflow-hidden rounded bg-slate-100">
                      {product.featuredImage ? (
                        <img
                          src={product.featuredImage}
                          alt=""
                          className="h-full w-full object-contain"
                          loading="lazy"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-xs font-bold text-slate-400">
                          {product.title.slice(0, 2).toUpperCase()}
                        </div>
                      )}
                    </div>
                    <span className="min-w-0 flex-1 truncate text-lg font-semibold uppercase text-slate-900">
                      {product.title}
                    </span>
                    {variant && (
                      <span className="shrink-0 text-lg font-bold text-slate-700">
                        {formatCurrency(variant.price)}
                      </span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
