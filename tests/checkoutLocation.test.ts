/**
 * docs/phase-210: a sale carries the location it was taken at, from the sale to the Shopify push.
 *
 * Drives the real `runCheckout` against a real in-memory `RubisDatabase`.
 */

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RubisDatabase } from '../src/main/services/database.js'
import type { CheckoutRequest } from '../src/main/services/database.js'
import { hashPin } from '../src/main/services/auth.js'
import { runCheckout } from '../src/main/services/checkout.js'
import type { RunCheckoutDeps } from '../src/main/services/checkout.js'
import { buildOrderInput } from '../src/main/services/orders.js'
import type { FiscalSubmitOutcome } from '../src/main/services/integrations/etims.js'
import type { CartItem } from '../src/renderer/src/types/shopify.js'

const cartItem: CartItem = {
  id: 'gid://shopify/ProductVariant/50346858741863',
  productId: 'gid://shopify/Product/1',
  title: 'test',
  variantTitle: 'Default Title',
  price: 1,
  quantity: 1,
  image: null
}

const FILED: FiscalSubmitOutcome = {
  ok: true,
  data: { invoiceNumber: '0110605040001000810', qrCode: 'qr', fiscalizedAt: '2026-10-03T00:00:00.000Z' }
}

function setup(): { db: RubisDatabase; staffId: number; deps: RunCheckoutDeps } {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  const staffId = db.createStaff({ name: 'Alex', pinHash: hashPin('1234'), role: 'cashier' }).staffId
  const deps: RunCheckoutDeps = {
    db,
    mpesaProvider: { verifyTransactionCode: vi.fn() },
    fiscalizationProvider: { submitInvoice: vi.fn().mockResolvedValue(FILED) },
    fiscalEngine: { onCheckoutMade: vi.fn(), claim: vi.fn(), release: vi.fn() },
    monitor: { isOnline: () => false },
    engineTick: vi.fn().mockResolvedValue(undefined),
    idGen: () => 'uuid-location-1',
    taxRate: 0.16,
    verifyReferenceNumbers: false,
    claimsStoredPayments: false,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
    debugLogging: false
  }
  return { db, staffId, deps }
}

function request(staffId: number, extra: Partial<CheckoutRequest> = {}): CheckoutRequest {
  return { items: [cartItem], total: 1, staffId, paymentMethod: 'cash', tenderedAmount: 1, changeDue: 0, ...extra }
}

describe('runCheckout stores the sale\'s location in the order payload', () => {
  it('writes locationId and locationName into the queued Shopify payload and the order row', async () => {
    const { db, staffId, deps } = setup()

    const result = await runCheckout(
      deps,
      request(staffId, { locationId: 'gid://shopify/Location/77557989479', locationName: 'Rubis Kisumu' })
    )

    expect(result.success).toBe(true)
    const queued = db.getPendingSyncQueue(Number.MAX_SAFE_INTEGER)
    expect(queued).toHaveLength(1)
    expect(queued[0].payload.locationId).toBe('gid://shopify/Location/77557989479')
    expect(queued[0].payload.locationName).toBe('Rubis Kisumu')
    const order = db.getOrder(queued[0].entity_id)!
    expect(JSON.parse(order.payload_json)).toMatchObject({ locationName: 'Rubis Kisumu' })
  })

  it('the stored payload builds an order for that location with no fallback', async () => {
    const { db, staffId, deps } = setup()
    await runCheckout(deps, request(staffId, { locationId: 'gid://shopify/Location/77557989479', locationName: 'Rubis Kisumu' }))

    const payload = db.getPendingSyncQueue(Number.MAX_SAFE_INTEGER)[0].payload
    const { order } = buildOrderInput(payload)

    expect(order.fulfillment).toEqual({ locationId: 'gid://shopify/Location/77557989479', notifyCustomer: false })
    expect(order.tags).toEqual(['location:rubis-kisumu'])
  })
})

describe('the orders:checkout handler refuses a sale with no location', () => {
  // A source pin: the handler is not unit-testable without Electron, and `resolveCheckoutLocation`
  // itself is tested in locationSlug.test.ts. This fails if the refusal is removed or moved after runCheckout.
  const source = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8')

  it('resolves the location, refuses with NO_LOCATION_MESSAGE, and only then calls runCheckout', () => {
    const resolve = source.indexOf('resolveCheckoutLocation(locationId, locationName)', source.indexOf("'orders:checkout'"))
    const refuse = source.indexOf('error: NO_LOCATION_MESSAGE', resolve)
    const run = source.indexOf('return runCheckout(', resolve)

    expect(resolve).toBeGreaterThan(-1)
    expect(refuse).toBeGreaterThan(resolve)
    expect(run).toBeGreaterThan(refuse)
  })

  it('passes the sale\'s location into runCheckout from the till\'s own settings, not the renderer', () => {
    expect(source).toContain('locationId: saleLocation.id')
    expect(source).toContain('locationName: saleLocation.name')
  })
})
