import type { ProductSummary, VariantSummary } from '../types/shopify'
import { formatCurrency } from '../lib/currency'

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
      className="group flex min-h-[160px] flex-col rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition-transform active:scale-95"
    >
      <div className="relative mb-3 aspect-square w-full overflow-hidden rounded-lg bg-slate-100">
        {product.featuredImage ? (
          <img
            src={product.featuredImage}
            alt={product.title}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center ">
            <span className="text-3xl font-bold text-slate-400">
              {initials || '📦'}
            </span>
          </div>
        )}
        {product.variants.length > 1 && (
          <span className="absolute bottom-2 right-2 rounded-full bg-white/90 px-2 py-1 text-xs font-medium text-slate-700 shadow-sm">
            {product.variants.length} variants
          </span>
        )}
      </div>

      <h3 className="mb-1 text-sm font-medium text-slate-900 line-clamp-1">
        {product.title}
      </h3>

      <p className="mb-3 text-xs text-slate-500">
        {price > 0 ? formatCurrency(price) : 'Price on request'}
      </p>

      <span className="mt-auto rounded-lg bg-rose-600 px-4 py-2 text-center text-sm font-semibold text-white opacity-0 transition-opacity group-hover:opacity-100">
        {product.variants.length === 1 ? '+ Add to cart' : 'Select variant'}
      </span>
    </button>
  )
}
