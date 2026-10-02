/**
 * The guarded cart actions (docs/phase-197): a manager is asked before a
 * line is removed, reduced or cleared, the approval is recorded only after
 * the PIN succeeds, and the cart changes only after the record is made.
 */

import { describe, it, expect, vi } from 'vitest'
import { createGuardedCartActions, type GuardedCartDeps } from '../src/renderer/src/lib/guardedCartActions.js'
import type { CartItem } from '../src/renderer/src/types/shopify.js'

const line = (id: string, quantity: number): CartItem => ({
  id,
  productId: 'p',
  title: `Item ${id}`,
  variantTitle: '',
  price: 10,
  quantity,
  image: null
})

/** A cart of two lines with a PIN prompt the test controls. */
function setup(overrides: Partial<GuardedCartDeps> = {}) {
  const items = [line('a', 3), line('b', 1)]
  let authorize: ((managerId: number, managerPin: string) => void) | null = null
  const requestManagerPin = vi.fn((_title: string, onAuthorized: (id: number, pin: string) => void) => {
    authorize = onAuthorized
  })
  const recordRemovals = vi.fn().mockResolvedValue({ success: true })
  const apply = { setQuantity: vi.fn(), remove: vi.fn(), clear: vi.fn() }
  const notify = vi.fn()
  const actions = createGuardedCartActions({
    getItems: () => items,
    getCartToken: () => 'cart-1',
    getStaffId: () => 7,
    requestManagerPin,
    recordRemovals,
    apply,
    notify,
    ...overrides
  })
  return { actions, requestManagerPin, recordRemovals, apply, notify, approve: () => authorize?.(2, '1234') }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('increasing a quantity', () => {
  it('applies at once, with no PIN and no record', () => {
    const { actions, requestManagerPin, recordRemovals, apply } = setup()

    actions.updateQuantity('a', 4)

    expect(apply.setQuantity).toHaveBeenCalledWith('a', 4)
    expect(requestManagerPin).not.toHaveBeenCalled()
    expect(recordRemovals).not.toHaveBeenCalled()
  })
})

describe('reducing a quantity', () => {
  it('asks for a manager and changes nothing until the PIN is given', () => {
    const { actions, requestManagerPin, recordRemovals, apply } = setup()

    actions.updateQuantity('a', 2)

    expect(requestManagerPin).toHaveBeenCalledTimes(1)
    expect(recordRemovals).not.toHaveBeenCalled()
    expect(apply.setQuantity).not.toHaveBeenCalled()
  })

  it('records the approval with the manager, cashier and cart, then applies the change', async () => {
    const { actions, recordRemovals, apply, approve } = setup()
    actions.updateQuantity('a', 2)

    approve()
    await settle()

    expect(recordRemovals).toHaveBeenCalledWith({
      cartToken: 'cart-1',
      staffId: 7,
      managerId: 2,
      managerPin: '1234',
      changes: [{ variantId: 'a', qtyBefore: 3, qtyAfter: 2 }]
    })
    expect(apply.setQuantity).toHaveBeenCalledWith('a', 2)
  })

  it('records a minus on the last unit as a removal to zero', async () => {
    const { actions, recordRemovals, apply, approve } = setup()
    actions.updateQuantity('b', 0)

    approve()
    await settle()

    expect(recordRemovals).toHaveBeenCalledWith(
      expect.objectContaining({ changes: [{ variantId: 'b', qtyBefore: 1, qtyAfter: 0 }] })
    )
    expect(apply.setQuantity).toHaveBeenCalledWith('b', 0)
  })

  it('leaves the cart unchanged and records nothing when the PIN prompt is cancelled', async () => {
    const { actions, recordRemovals, apply } = setup()

    actions.updateQuantity('a', 2)
    await settle()

    expect(recordRemovals).not.toHaveBeenCalled()
    expect(apply.setQuantity).not.toHaveBeenCalled()
  })

  it('does not change the cart, and says so, when the approval cannot be recorded', async () => {
    const recordRemovals = vi.fn().mockResolvedValue({ success: false, error: 'Manager PIN required for this action' })
    const { actions, apply, notify, approve } = setup({ recordRemovals })
    actions.updateQuantity('a', 2)

    approve()
    await settle()

    expect(apply.setQuantity).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith('Manager PIN required for this action')
  })

  it('does not change the cart when recording throws', async () => {
    const recordRemovals = vi.fn().mockRejectedValue(new Error('bridge down'))
    const { actions, apply, notify, approve } = setup({ recordRemovals })
    actions.updateQuantity('a', 2)

    approve()
    await settle()

    expect(apply.setQuantity).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('ignores a line that is no longer in the cart', () => {
    const { actions, requestManagerPin, apply } = setup()

    actions.updateQuantity('gone', 1)

    expect(requestManagerPin).not.toHaveBeenCalled()
    expect(apply.setQuantity).not.toHaveBeenCalled()
  })
})

describe('removing a line', () => {
  it('asks for a manager, records the whole quantity going to zero, then removes', async () => {
    const { actions, requestManagerPin, recordRemovals, apply, approve } = setup()

    actions.remove('a')
    expect(requestManagerPin).toHaveBeenCalledTimes(1)
    expect(apply.remove).not.toHaveBeenCalled()
    approve()
    await settle()

    expect(recordRemovals).toHaveBeenCalledWith(
      expect.objectContaining({ changes: [{ variantId: 'a', qtyBefore: 3, qtyAfter: 0 }] })
    )
    expect(apply.remove).toHaveBeenCalledWith('a')
  })

  it('leaves the line in place when the prompt is cancelled', async () => {
    const { actions, recordRemovals, apply } = setup()

    actions.remove('a')
    await settle()

    expect(recordRemovals).not.toHaveBeenCalled()
    expect(apply.remove).not.toHaveBeenCalled()
  })
})

describe('clearing the cart', () => {
  it('records every line going to zero with one approval, then clears', async () => {
    const { actions, requestManagerPin, recordRemovals, apply, approve } = setup()

    actions.clear()
    expect(requestManagerPin).toHaveBeenCalledTimes(1)
    expect(apply.clear).not.toHaveBeenCalled()
    approve()
    await settle()

    expect(recordRemovals).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: [
          { variantId: 'a', qtyBefore: 3, qtyAfter: 0 },
          { variantId: 'b', qtyBefore: 1, qtyAfter: 0 }
        ]
      })
    )
    expect(apply.clear).toHaveBeenCalledTimes(1)
  })

  it('does nothing on an empty cart', () => {
    const { actions, requestManagerPin } = setup({ getItems: () => [] })

    actions.clear()

    expect(requestManagerPin).not.toHaveBeenCalled()
  })
})

describe('when nobody is signed in or the cart has no token', () => {
  it('refuses to record or change anything', async () => {
    const { actions, recordRemovals, apply, notify, approve } = setup({ getStaffId: () => null })
    actions.remove('a')

    approve()
    await settle()

    expect(recordRemovals).not.toHaveBeenCalled()
    expect(apply.remove).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledTimes(1)
  })
})
