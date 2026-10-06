/**
 * The checkout key survives a crash restore (docs/phase-249-1). The cart's draft is saved with its checkout key and put
 * back with it, so a cart restored after its sale was written is the same checkout: resubmitted, it is answered with
 * that sale and nothing is filed again. A draft saved before the phase has no key and restores as before.
 *
 * The round trip uses the real pieces: the draft saver, `cart:save-draft`'s schema, the `cart_drafts` table, the draft
 * restore, the cart store, `orders:checkout`'s schema and `runCheckout` on a real `:memory:` SQLite.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RubisDatabase } from '../src/main/services/database.js'
import { hashPin } from '../src/main/services/auth.js'
import { runCheckout } from '../src/main/services/checkout.js'
import type { RunCheckoutDeps } from '../src/main/services/checkout.js'
import type { FiscalSubmitOutcome } from '../src/main/services/integrations/etims.js'
import { checkoutRequestSchema, saveCartDraftSchema, validate } from '../src/main/lib/ipcValidator.js'
import { createCartDraftSaver, restoreCartDraft } from '../src/renderer/src/lib/cartDraft.js'
import { useCartStore } from '../src/renderer/src/stores/cartStore.js'
import type { CartItem, ProductSummary } from '../src/renderer/src/types/shopify.js'

const KEY = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'
const filed: FiscalSubmitOutcome = { ok: true, data: { invoiceNumber: 'KRA-0001', qrCode: 'qr', fiscalizedAt: '2026-10-06T10:00:00.000Z' } }

const catalogue: ProductSummary[] = [
  {
    id: 'p1',
    title: 'Mug',
    handle: 'mug',
    featuredImage: null,
    variants: [{ id: 'v1', productId: 'p1', title: 'Small', price: 60, availableForSale: true, inventoryQuantity: 5, image: null, barcode: null, vatClass: 'A' }]
  }
]
const line: CartItem = { id: 'v1', productId: 'p1', title: 'Mug', variantTitle: 'Small', price: 60, basePrice: 60, quantity: 2, image: null }
const params = { staffId: 0, paymentMethod: 'cash' as const, tenderedAmount: 200, changeDue: 80 }

/** The till: a real database, `runCheckout` behind `orders:checkout`'s schema, the draft table behind `cart:save-draft`'s. */
function till(): { db: RubisDatabase; deps: RunCheckoutDeps; staffId: number } {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  const { staffId } = db.createStaff({ name: 'Alex', pinHash: hashPin('1234'), role: 'cashier' })
  let n = 0
  const deps: RunCheckoutDeps = {
    db,
    mpesaProvider: { verifyTransactionCode: vi.fn() },
    fiscalizationProvider: { submitInvoice: vi.fn().mockResolvedValue(filed) },
    fiscalEngine: { onCheckoutMade: vi.fn(), claim: vi.fn(), release: vi.fn() },
    monitor: { isOnline: () => false },
    engineTick: vi.fn().mockResolvedValue(undefined),
    idGen: () => `uuid-${++n}`,
    taxRate: 0.16,
    verifyReferenceNumbers: false,
    claimsStoredPayments: false,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
    debugLogging: false
  }
  window.api = {
    checkout: vi.fn(async (request: unknown) => {
      const valid = validate(checkoutRequestSchema, request)
      return valid.success ? runCheckout(deps, valid.data) : { success: false, error: valid.error }
    }),
    printReceipt: vi.fn().mockResolvedValue({ success: true })
  } as unknown as typeof window.api
  return { db, deps, staffId }
}

/** Saves the draft the way the screen and `cart:save-draft` do, then reads it back the way a restart does. */
async function saveThenRestart(db: RubisDatabase, snapshot: { items: CartItem[]; cartToken: string; checkoutKey?: string | null }): Promise<void> {
  const saver = createCartDraftSaver({
    save: async (draft) => {
      const valid = validate(saveCartDraftSchema, draft)
      if (!valid.success) throw new Error(valid.error)
      db.saveCartDraft(JSON.stringify(valid.data))
    },
    clear: async () => db.clearCartDraft()
  })
  saver.update(snapshot)
  await saver.flush()
  useCartStore.setState({ items: [], cartToken: null, checkoutKey: null, checkoutStatus: 'idle', lastReceipt: null, checkoutError: null })
  const restored = restoreCartDraft(db.getCartDraft()!.payload_json, catalogue)!
  useCartStore.getState().restoreCart(restored.items, restored.cartToken, restored.checkoutKey)
}

const count = (db: RubisDatabase, table: string): number =>
  ((db as unknown as { conn: { prepare: (sql: string) => { get: () => { n: number } } } }).conn.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n

beforeEach(() => {
  useCartStore.setState({ items: [], cartToken: null, checkoutKey: null, cartDiscount: null, checkoutStatus: 'idle', lastReceipt: null, checkoutError: null })
})

describe('a cart restored after its sale was written', () => {
  it('is the same checkout: submitted again, it returns the first order and files nothing', async () => {
    const { db, deps, staffId } = till()
    // The first submit wrote the sale (and, in the sale's own transaction, deleted the draft)...
    const first = await runCheckout(deps, { items: [line], total: 120, ...params, staffId, checkoutKey: KEY, cartToken: 'token-1' })
    expect(first.success).toBe(true)
    // ...but the screen was told it failed, kept the cart and saved its draft again; then the till stopped.
    await saveThenRestart(db, { items: [line], cartToken: 'token-1', checkoutKey: KEY })

    expect(useCartStore.getState().checkoutKey).toBe(KEY)
    await useCartStore.getState().checkout({ ...params, staffId })

    expect(useCartStore.getState().lastReceipt?.localId).toBe(1)
    expect(count(db, 'orders')).toBe(1)
    expect(deps.fiscalizationProvider.submitInvoice).toHaveBeenCalledTimes(1)
  })
})

describe('a draft saved with no key', () => {
  it('restores with no key, as before, and its sale is made with a new key', async () => {
    const { db, deps, staffId } = till()
    db.saveCartDraft(JSON.stringify({ cartToken: 'token-old', items: [line] }))
    const restored = restoreCartDraft(db.getCartDraft()!.payload_json, catalogue)!
    useCartStore.getState().restoreCart(restored.items, restored.cartToken, restored.checkoutKey)

    expect(restored.checkoutKey).toBeNull()
    expect(useCartStore.getState().checkoutKey).toBeNull()
    await useCartStore.getState().checkout({ ...params, staffId })

    expect(useCartStore.getState().checkoutStatus).toBe('queued-offline')
    expect(count(db, 'orders')).toBe(1)
    expect(deps.fiscalizationProvider.submitInvoice).toHaveBeenCalledTimes(1)
    const sentKey = (vi.mocked(window.api.checkout).mock.calls[0][0] as { checkoutKey: string }).checkoutKey
    expect(sentKey).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('is saved without a key field while the cart has no key, exactly as before', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const saver = createCartDraftSaver({ save, clear: vi.fn() })

    saver.update({ items: [line], cartToken: 't', checkoutKey: null })
    await saver.flush()
    saver.update({ items: [line], cartToken: 't', checkoutKey: KEY })
    await saver.flush()

    expect(save.mock.calls.map(([draft]) => draft)).toEqual([
      { items: [line], cartToken: 't' },
      { items: [line], cartToken: 't', checkoutKey: KEY }
    ])
  })
})

describe('the channel and the wiring', () => {
  it('cart:save-draft takes a key shaped like the screen makes it, or none', () => {
    const draft = { cartToken: 't', items: [line] }

    expect(validate(saveCartDraftSchema, draft).success).toBe(true)
    expect(validate(saveCartDraftSchema, { ...draft, checkoutKey: KEY }).success).toBe(true)
    expect(validate(saveCartDraftSchema, { ...draft, checkoutKey: 'abc' }).success).toBe(false)
  })

  it('the screen saves the key with the cart, saves again when the key changes, and puts it back on restore', () => {
    const app = readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'App.tsx'), 'utf8')

    expect(app).toContain('state.checkoutKey === previous.checkoutKey')
    expect(app).toContain('saver.update({ items: state.items, cartToken: state.cartToken, checkoutKey: state.checkoutKey })')
    expect(app).toContain('restoreCart(restored.items, restored.cartToken, restored.checkoutKey)')
  })
})
