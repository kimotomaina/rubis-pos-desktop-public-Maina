/**
 * Demo Mode dummy catalog.
 *
 * When `VITE_DEMO_MODE=true`, the app seeds this hardcoded catalog
 * into the local `products` cache instead of calling the live Shopify
 * API on startup — so a trial/demo terminal looks fully populated and
 * is scannable even with the store's internet completely dead, no
 * Shopify credentials configured, or a store that simply isn't set up
 * in Shopify yet.
 *
 * Ten realistic Kenyan convenience-store items with round, easy-to-read
 * barcodes (`111111`, `222222`, …) so a cashier can test barcode
 * scanning without needing physical labels.
 */

import type { ProductSummary } from '../../renderer/src/types/shopify.js'

/**
 * Builds one single-variant demo product ("Default Title", matching
 * how Shopify represents a product with no real variant options).
 *
 * @param {object} input
 * @returns {ProductSummary}
 */
function demoProduct(input: {
  id: string
  title: string
  price: number
  barcode: string
  inventoryQuantity?: number
}): ProductSummary {
  return {
    id: input.id,
    title: input.title,
    handle: input.id,
    featuredImage: null,
    variants: [
      {
        id: `${input.id}-variant`,
        productId: input.id,
        title: 'Default Title',
        price: input.price,
        availableForSale: true,
        inventoryQuantity: input.inventoryQuantity ?? 50,
        image: null,
        barcode: input.barcode
      }
    ]
  }
}

/** Ten realistic Kenyan convenience-store items for Demo Mode. */
export const DEMO_PRODUCTS: ProductSummary[] = [
  demoProduct({ id: 'demo-kabras-milk-500ml', title: 'Kabras Milk 500ml', price: 65, barcode: '111111' }),
  demoProduct({ id: 'demo-bread-loaf', title: 'Bread Loaf', price: 65, barcode: '222222' }),
  demoProduct({ id: 'demo-coca-cola-300ml', title: 'Coca-Cola 300ml', price: 60, barcode: '333333' }),
  demoProduct({ id: 'demo-airtime-50', title: 'Airtime 50 Ksh', price: 50, barcode: '444444' }),
  demoProduct({ id: 'demo-fresh-fri-1l', title: 'Fresh Fri Cooking Oil 1L', price: 350, barcode: '555555' }),
  demoProduct({ id: 'demo-jogoo-maize-flour-2kg', title: 'Jogoo Maize Flour 2kg', price: 180, barcode: '666666' }),
  demoProduct({ id: 'demo-pishori-rice-1kg', title: 'Pishori Rice 1kg', price: 150, barcode: '777777' }),
  demoProduct({ id: 'demo-geisha-soap', title: 'Geisha Bar Soap', price: 55, barcode: '888888' }),
  demoProduct({ id: 'demo-matchbox', title: 'Matchbox', price: 10, barcode: '999999' }),
  demoProduct({ id: 'demo-keringet-water-500ml', title: 'Keringet Water 500ml', price: 50, barcode: '101010' })
]
