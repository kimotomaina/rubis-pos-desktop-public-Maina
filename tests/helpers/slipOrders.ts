/**
 * Seeds orders for the two-slip tests (docs/phase-198): a real in-memory
 * database, a manager, and one queued cash sale.
 */

import { RubisDatabase } from '../../src/main/services/database.js'
import { hashPin } from '../../src/main/services/auth.js'
import type { CartItem } from '../../src/renderer/src/types/shopify.js'

const mug: CartItem = {
  id: 'gid://shopify/ProductVariant/201',
  productId: 'gid://shopify/Product/101',
  title: 'RUBIS Mug',
  variantTitle: 'Small',
  price: 60,
  quantity: 1,
  image: null
}

/** A fresh in-memory database. */
export function freshDb(): RubisDatabase {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  return db
}

/** Seeds a cashier and one queued cash sale; returns both ids. */
export function seedSale(db: RubisDatabase): { staffId: number; localId: number } {
  const { staffId } = db.createStaff({ name: 'Mary Wanjiku', pinHash: hashPin('1234'), role: 'cashier' })
  const { localId } = db.queueOrder({
    items: [mug],
    total: 60,
    clientOrderUuid: `uuid-${Math.random()}`,
    staffId,
    staffName: 'Mary Wanjiku',
    paymentMethod: 'cash',
    tenderedAmount: 100,
    changeDue: 40
  })
  return { staffId, localId }
}
