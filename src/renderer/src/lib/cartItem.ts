import type { CartItem, ProductSummary, VariantSummary } from '../types/shopify.js'

/**
 * Converts a product + variant pair into the cart-line shape expected
 * by `useCartStore.addItem`.
 *
 * The product's tax classification (docs/phase-194) is carried only when
 * the variant has one, so a product without the `rubis` metafields becomes
 * exactly the cart line it always was and is sold as class A.
 *
 * @param {ProductSummary} product
 * @param {VariantSummary} variant
 * @returns {Omit<CartItem, 'quantity'>}
 */
export function buildCartItem(
  product: ProductSummary,
  variant: VariantSummary
): Omit<CartItem, 'quantity'> {
  return {
    id: variant.id,
    productId: variant.productId,
    title: product.title,
    variantTitle: variant.title,
    price: variant.price,
    image: variant.image ?? product.featuredImage,
    ...(variant.vatClass ? { vatClass: variant.vatClass } : {}),
    ...(variant.hsCode ? { hsCode: variant.hsCode } : {}),
    ...(variant.hsName ? { hsName: variant.hsName } : {})
  }
}
