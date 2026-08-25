/**
 * IPC payload validation tests (Phase 12, Task 5).
 *
 * Exercises the `zod` schemas and the `validate()` wrapper directly —
 * these are the same schemas `main/index.ts` runs every
 * `orders:checkout` / `orders:void` / `auth:login` payload through
 * before it reaches any business logic or database call.
 */

import { describe, it, expect } from 'vitest'
import {
  validate,
  checkoutRequestSchema,
  voidOrderSchema,
  loginRequestSchema,
  staffCreateSchema,
  staffResetPinSchema,
  integrationsSetConfigSchema
} from '../src/main/lib/ipcValidator.js'

const validItem = {
  id: 'variant-1',
  productId: 'product-1',
  title: 'RUBIS Mug',
  variantTitle: 'Small',
  price: 100,
  quantity: 2,
  image: null
}

const validCheckoutRequest = {
  items: [validItem],
  total: 200,
  staffId: 1,
  paymentMethod: 'cash',
  tenderedAmount: 200,
  changeDue: 0
}

describe('checkoutRequestSchema', () => {
  it('accepts a well-formed request', () => {
    const result = validate(checkoutRequestSchema, validCheckoutRequest)
    expect(result.success).toBe(true)
  })

  it('accepts optional fields (referenceNumber, shiftId, discounts)', () => {
    const result = validate(checkoutRequestSchema, {
      ...validCheckoutRequest,
      referenceNumber: 'QDF73H',
      shiftId: 5,
      cartDiscount: { type: 'percent', value: 10 },
      items: [{ ...validItem, discount: { type: 'fixed', value: 5 }, basePrice: 100 }]
    })
    expect(result.success).toBe(true)
  })

  it('rejects an empty cart', () => {
    const result = validate(checkoutRequestSchema, { ...validCheckoutRequest, items: [] })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toMatch(/cart is empty/i)
  })

  it('rejects a missing items field entirely', () => {
    const { items: _items, ...withoutItems } = validCheckoutRequest
    const result = validate(checkoutRequestSchema, withoutItems)
    expect(result.success).toBe(false)
  })

  it('rejects a negative line-item price', () => {
    const result = validate(checkoutRequestSchema, {
      ...validCheckoutRequest,
      items: [{ ...validItem, price: -50 }]
    })
    expect(result.success).toBe(false)
  })

  it('rejects a zero or negative quantity', () => {
    expect(validate(checkoutRequestSchema, {
      ...validCheckoutRequest,
      items: [{ ...validItem, quantity: 0 }]
    }).success).toBe(false)
    expect(validate(checkoutRequestSchema, {
      ...validCheckoutRequest,
      items: [{ ...validItem, quantity: -1 }]
    }).success).toBe(false)
  })

  it('rejects a non-finite total', () => {
    expect(validate(checkoutRequestSchema, { ...validCheckoutRequest, total: Infinity }).success).toBe(false)
    expect(validate(checkoutRequestSchema, { ...validCheckoutRequest, total: NaN }).success).toBe(false)
  })

  it('rejects an invalid payment method', () => {
    const result = validate(checkoutRequestSchema, {
      ...validCheckoutRequest,
      paymentMethod: 'bitcoin'
    })
    expect(result.success).toBe(false)
  })

  it('rejects a non-integer or non-positive staffId', () => {
    expect(validate(checkoutRequestSchema, { ...validCheckoutRequest, staffId: 1.5 }).success).toBe(false)
    expect(validate(checkoutRequestSchema, { ...validCheckoutRequest, staffId: 0 }).success).toBe(false)
    expect(validate(checkoutRequestSchema, { ...validCheckoutRequest, staffId: -1 }).success).toBe(false)
  })

  it('rejects a completely malformed payload (string instead of object)', () => {
    expect(validate(checkoutRequestSchema, 'not an object').success).toBe(false)
  })

  it('rejects null and undefined payloads', () => {
    expect(validate(checkoutRequestSchema, null).success).toBe(false)
    expect(validate(checkoutRequestSchema, undefined).success).toBe(false)
  })
})

describe('voidOrderSchema', () => {
  it('accepts a positive integer local id', () => {
    expect(validate(voidOrderSchema, 7).success).toBe(true)
  })

  it('rejects a non-integer, zero, or negative id', () => {
    expect(validate(voidOrderSchema, 7.5).success).toBe(false)
    expect(validate(voidOrderSchema, 0).success).toBe(false)
    expect(validate(voidOrderSchema, -7).success).toBe(false)
  })

  it('rejects a non-numeric payload', () => {
    expect(validate(voidOrderSchema, '7').success).toBe(false)
    expect(validate(voidOrderSchema, { localId: 7 }).success).toBe(false)
  })
})

describe('loginRequestSchema', () => {
  it('accepts a well-formed login request', () => {
    expect(validate(loginRequestSchema, { staffId: 1, pin: '1234' }).success).toBe(true)
  })

  it('rejects a missing or empty pin', () => {
    expect(validate(loginRequestSchema, { staffId: 1, pin: '' }).success).toBe(false)
    expect(validate(loginRequestSchema, { staffId: 1 }).success).toBe(false)
  })

  it('rejects a missing or invalid staffId', () => {
    expect(validate(loginRequestSchema, { pin: '1234' }).success).toBe(false)
    expect(validate(loginRequestSchema, { staffId: -1, pin: '1234' }).success).toBe(false)
  })
})

describe('staffCreateSchema (Phase 14)', () => {
  const validRequest = {
    name: 'New Cashier',
    pin: '1234',
    role: 'cashier',
    managerId: 1,
    managerPin: '9999'
  }

  it('accepts a well-formed request', () => {
    expect(validate(staffCreateSchema, validRequest).success).toBe(true)
  })

  it('rejects an invalid role', () => {
    expect(
      validate(staffCreateSchema, { ...validRequest, role: 'superadmin' }).success
    ).toBe(false)
  })

  it('rejects a missing name or pin', () => {
    const { name: _name, ...withoutName } = validRequest
    expect(validate(staffCreateSchema, withoutName).success).toBe(false)
    expect(validate(staffCreateSchema, { ...validRequest, pin: '' }).success).toBe(false)
  })

  it('rejects a missing or non-positive managerId', () => {
    const { managerId: _managerId, ...withoutManagerId } = validRequest
    expect(validate(staffCreateSchema, withoutManagerId).success).toBe(false)
    expect(validate(staffCreateSchema, { ...validRequest, managerId: 0 }).success).toBe(false)
    expect(validate(staffCreateSchema, { ...validRequest, managerId: -1 }).success).toBe(false)
  })

  it('rejects a missing or empty managerPin', () => {
    const { managerPin: _managerPin, ...withoutManagerPin } = validRequest
    expect(validate(staffCreateSchema, withoutManagerPin).success).toBe(false)
    expect(validate(staffCreateSchema, { ...validRequest, managerPin: '' }).success).toBe(false)
  })
})

describe('staffResetPinSchema (Phase 14)', () => {
  const validRequest = { staffId: 3, pin: '4321', managerId: 1, managerPin: '9999' }

  it('accepts a well-formed request', () => {
    expect(validate(staffResetPinSchema, validRequest).success).toBe(true)
  })

  it('rejects a missing or non-positive staffId', () => {
    expect(validate(staffResetPinSchema, { ...validRequest, staffId: 0 }).success).toBe(false)
    expect(validate(staffResetPinSchema, { ...validRequest, staffId: -1 }).success).toBe(false)
  })

  it('rejects a missing or empty pin', () => {
    expect(validate(staffResetPinSchema, { ...validRequest, pin: '' }).success).toBe(false)
  })

  it('rejects a missing manager authorization', () => {
    expect(
      validate(staffResetPinSchema, { ...validRequest, managerId: undefined }).success
    ).toBe(false)
    expect(validate(staffResetPinSchema, { ...validRequest, managerPin: '' }).success).toBe(false)
  })
})

describe('integrationsSetConfigSchema (Phase 14)', () => {
  const validRequest = {
    provider: 'mpesa',
    config: { paybill: '123456', till: '654321' },
    managerId: 1,
    managerPin: '9999'
  }

  it('accepts a well-formed request', () => {
    expect(validate(integrationsSetConfigSchema, validRequest).success).toBe(true)
  })

  it('accepts the etims provider with a different config shape', () => {
    expect(
      validate(integrationsSetConfigSchema, {
        ...validRequest,
        provider: 'etims',
        config: { middlewareUrl: 'http://localhost:9000' }
      }).success
    ).toBe(true)
  })

  it('rejects an unknown provider', () => {
    expect(
      validate(integrationsSetConfigSchema, { ...validRequest, provider: 'paypal' }).success
    ).toBe(false)
  })

  it('rejects a missing manager authorization', () => {
    const { managerId: _managerId, ...withoutManagerId } = validRequest
    expect(validate(integrationsSetConfigSchema, withoutManagerId).success).toBe(false)
    expect(
      validate(integrationsSetConfigSchema, { ...validRequest, managerPin: '' }).success
    ).toBe(false)
  })
})

describe('validate()', () => {
  it('collapses multiple issues into one semicolon-joined message', () => {
    const result = validate(loginRequestSchema, { staffId: -1, pin: '' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('staffId')
      expect(result.error).toContain('pin')
      expect(result.error).toContain(';')
    }
  })
})
