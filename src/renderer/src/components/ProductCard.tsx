import type { ProductSummary, VariantSummary } from '../types/shopify'
import { formatCurrency } from '../lib/currency'
import { PackageIcon } from './icons'

interface ProductCardProps {
  product: ProductSummary
  onAddToCart: (variant: VariantSummary) => void
  onSelectProduct: (product: ProductSummary) => void
}

/**
 * Touch-friendly product card rendered inside the POS grid.
 *
 * Shows the featured image (or an initials placeholder), the product
 * title, and the price of the first available variant.
 *
 * For single-variant products, clicking adds directly to cart.
 * For multi-variant products, clicking opens the variant picker modal.
 *
 * @param {ProductCardProps} props
 * @returns {JSX.Element}
 */
export default function ProductCard({
  product,
  onAddToCart,
  onSelectProduct
}: ProductCardProps) {
  const primaryVariant = product.variants[0]
  const price = primaryVariant ? primaryVariant.price : 0
  const initials = product.title
    .split(' ')
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)

  const handleClick = () => {
    if (product.variants.length === 1 && primaryVariant) {
      onAddToCart(primaryVariant)
    } else {
      onSelectProduct(product)
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className="flex h-80 flex-col rounded-lg border border-slate-200 bg-white p-5 text-left shadow-sm transition-transform active:scale-95"
    >
      <div className="relative h-44 w-full shrink-0 rounded bg-slate-50 p-3">
        {product.featuredImage ? (
          <img
            src={product.featuredImage}
            alt={product.title}
            className="h-full w-full object-contain"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            {initials ? (
              <span className="flex h-full items-center justify-center text-5xl font-bold text-slate-400">
                {initials}
              </span>
            ) : (
              <PackageIcon className="h-14 w-14 text-slate-300" />
            )}
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col justify-between pt-3">
        <div className="flex flex-col items-start">
          <h3 className="line-clamp-2 min-h-10 text-lg font-semibold text-slate-900">
            {product.title}
          </h3>
          {product.variants.length > 1 && (
            <span className="mt-2 self-start rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-600">
              {product.variants.length} variants
            </span>
          )}
        </div>

        <p className="mt-auto text-xl font-bold text-slate-900">
          {price > 0 ? formatCurrency(price) : 'Price on request'}
        </p>
      </div>
    </button>
  )
}
