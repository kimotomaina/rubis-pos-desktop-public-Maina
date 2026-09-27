import { useState } from 'react'
import type { ProductSummary, VariantSummary } from '../types/shopify.js'
import { formatCurrency } from '../lib/currency.js'
import { CloseIcon, PackageIcon } from './icons.js'
import { paginate } from '../lib/paginate.js'
import Pager from './Pager.js'

/** Variants per page (docs/phase-167 Part B item 2) — a 6-variant product measured 15-66px over the design box at the tightest sizes with the old plain scrolling list. */
const VARIANTS_PER_PAGE = 4

interface VariantModalProps {
  product: ProductSummary
  onSelectVariant: (variant: VariantSummary) => void
  onClose: () => void
}

/**
 * Touch-friendly variant picker modal.
 *
 * Displays a product's variants with their prices, allowing the
 * cashier to select a specific variant before adding it to the cart.
 *
 * Paginated at {@link VARIANTS_PER_PAGE} (docs/phase-167 Part B item 2,
 * replacing the list's old internal scroll — Phase E's no-scroll rule):
 * `check:fit`'s synthetic 6-variant measurement found the plain list
 * genuinely overflowing the design box, worse at the tightest sizes.
 *
 * @param {VariantModalProps} props
 * @returns {JSX.Element}
 */
export default function VariantModal({
  product,
  onSelectVariant,
  onClose
}: VariantModalProps) {
  const [page, setPage] = useState(1)
  const pageResult = paginate(product.variants, page, VARIANTS_PER_PAGE)

  const initials = product.title
    .split(' ')
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] min-h-[75vh] w-full min-w-[75vw] max-w-3xl flex-col rounded-2xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-slate-200 p-4">
          <h3 className="text-xl font-semibold text-slate-900">
            Select Variant
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            aria-label="Close"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        {/* Product info */}
        <div className="flex shrink-0 items-center gap-3 border-b border-slate-100 p-4">
          <div className="h-16 w-16 flex-shrink-0 overflow-hidden rounded-lg bg-slate-100">
            {product.featuredImage ? (
              <img
                src={product.featuredImage}
                alt={product.title}
                className="h-full w-full object-cover"
                loading="lazy"
              />
            ) : initials ? (
              <div className="flex h-full w-full items-center justify-center">
                <span className="text-xl font-bold text-slate-400">{initials}</span>
              </div>
            ) : (
              <div className="flex h-full w-full items-center justify-center">
                <PackageIcon className="h-8 w-8 text-slate-300" />
              </div>
            )}
          </div>
          <div>
            <h4 className="text-lg font-medium text-slate-900">{product.title}</h4>
            <p className="text-base text-slate-500">
              {product.variants.length} variants available
            </p>
          </div>
        </div>

        {/* Variant list */}
        <div className="flex-1 p-4">
          <div className="space-y-2">
            {pageResult.items.map((variant) => (
              <button
                key={variant.id}
                type="button"
                onClick={() => onSelectVariant(variant)}
                disabled={!variant.availableForSale}
                className="flex w-full items-center justify-between rounded-xl border border-slate-200 p-4 text-left transition-colors hover:border-rose-300 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-slate-200 disabled:hover:bg-transparent"
              >
                <div className="flex items-center gap-3">
                  {variant.image ? (
                    <img
                      src={variant.image}
                      alt={variant.title}
                      className="h-10 w-10 rounded-lg object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100">
                      <span className="text-sm font-medium text-slate-400">
                        {variant.title.slice(0, 2).toUpperCase()}
                      </span>
                    </div>
                  )}
                  <div>
                    <p className="text-lg font-medium text-slate-900">
                      {variant.title}
                    </p>
                    <p className="text-base text-slate-500">
                      {variant.availableForSale
                        ? `${variant.inventoryQuantity} in stock`
                        : 'Out of stock'}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-lg font-semibold text-slate-900">
                    {formatCurrency(variant.price)}
                  </p>
                  {variant.availableForSale && (
                    <p className="text-sm text-rose-600">Add to cart</p>
                  )}
                </div>
              </button>
            ))}
          </div>
          <div className="mt-3">
            <Pager page={pageResult.page} pageCount={pageResult.pageCount} onChange={setPage} />
          </div>
        </div>
      </div>
    </div>
  )
}
