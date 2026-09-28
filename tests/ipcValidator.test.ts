/**
 * IPC payload validation tests.
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
  integrationsSetConfigSchema,
  printerSaveSchema,
  printerDeleteSchema,
  stockTakeOpenSchema,
  stockTakeCountSchema,
  stockTakeCommitSchema,
  stockTakeSettingsSchema,
  printerTestSchema,
  shopifySetStoreUrlSchema,
  configValidateSchema,
  configSaveSchema,
  configClearSchema,
  locationSetSchema,
  etimsConfigSaveSchema,
  etimsPasswordSetSchema,
  etimsIntegrationConfigSchema,
  mpesaIntegrationConfigSchema,
  storeIdentitySetSchema,
  correctPinAndResendSchema,
  resendFiscalizationSchema,
  endOfDayReportSchema,
  approveDayReportSchema,
  receiptPrintRequestSchema
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

describe('correctPinAndResendSchema (phase-78, Part C)', () => {
  it('accepts a positive localId with a non-blank buyerPin', () => {
    expect(validate(correctPinAndResendSchema, { localId: 7, buyerPin: 'P051234567Z' }).success).toBe(true)
  })

  it('accepts a null buyerPin (removing the PIN)', () => {
    expect(validate(correctPinAndResendSchema, { localId: 7, buyerPin: null }).success).toBe(true)
  })

  it('rejects a blank buyerPin string — remove it with null instead', () => {
    const result = validate(correctPinAndResendSchema, { localId: 7, buyerPin: '' })
    expect(result.success).toBe(false)
  })

  it('rejects a non-integer or non-positive localId', () => {
    expect(validate(correctPinAndResendSchema, { localId: 7.5, buyerPin: null }).success).toBe(false)
    expect(validate(correctPinAndResendSchema, { localId: 0, buyerPin: null }).success).toBe(false)
    expect(validate(correctPinAndResendSchema, { localId: -1, buyerPin: null }).success).toBe(false)
  })

  it('rejects a missing buyerPin field (undefined is not the same as null)', () => {
    expect(validate(correctPinAndResendSchema, { localId: 7 }).success).toBe(false)
  })

  it('rejects a completely malformed payload', () => {
    expect(validate(correctPinAndResendSchema, 'not an object').success).toBe(false)
    expect(validate(correctPinAndResendSchema, null).success).toBe(false)
  })
})

describe('resendFiscalizationSchema (phase-88, Step 4)', () => {
  it('accepts a positive localId', () => {
    expect(validate(resendFiscalizationSchema, { localId: 7 }).success).toBe(true)
  })

  it('rejects a non-integer or non-positive localId', () => {
    expect(validate(resendFiscalizationSchema, { localId: 7.5 }).success).toBe(false)
    expect(validate(resendFiscalizationSchema, { localId: 0 }).success).toBe(false)
    expect(validate(resendFiscalizationSchema, { localId: -1 }).success).toBe(false)
  })

  it('rejects a missing localId', () => {
    expect(validate(resendFiscalizationSchema, {}).success).toBe(false)
  })

  it('rejects a completely malformed payload', () => {
    expect(validate(resendFiscalizationSchema, 'not an object').success).toBe(false)
    expect(validate(resendFiscalizationSchema, null).success).toBe(false)
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

describe('staffCreateSchema', () => {
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

describe('staffResetPinSchema', () => {
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

describe('integrationsSetConfigSchema', () => {
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

describe('printerSaveSchema', () => {
  const validRequest = {
    id: 'kitchen-1',
    type: 'kitchen',
    interfaceName: 'tcp://192.168.0.52:9100',
    enabled: true,
    managerId: 1,
    managerPin: '9999'
  }

  it('accepts a well-formed request', () => {
    expect(validate(printerSaveSchema, validRequest).success).toBe(true)
  })

  it('rejects an invalid printer type', () => {
    expect(validate(printerSaveSchema, { ...validRequest, type: 'fax' }).success).toBe(false)
  })

  it('rejects a missing id or interfaceName', () => {
    expect(validate(printerSaveSchema, { ...validRequest, id: '' }).success).toBe(false)
    expect(validate(printerSaveSchema, { ...validRequest, interfaceName: '' }).success).toBe(false)
  })

  it('rejects a non-boolean enabled', () => {
    expect(validate(printerSaveSchema, { ...validRequest, enabled: 'true' }).success).toBe(false)
  })

  it('rejects a missing manager authorization', () => {
    const { managerId: _managerId, ...withoutManagerId } = validRequest
    expect(validate(printerSaveSchema, withoutManagerId).success).toBe(false)
    expect(validate(printerSaveSchema, { ...validRequest, managerPin: '' }).success).toBe(false)
  })

  it('accepts an omitted connectionType (docs/phase-174 back-compat — every printer saved before it)', () => {
    const { connectionType: _unused, ...withoutConnectionType } = { ...validRequest, connectionType: undefined }
    expect(validate(printerSaveSchema, withoutConnectionType).success).toBe(true)
  })

  it('accepts connectionType: windows, with interfaceName reused as the queue name', () => {
    expect(
      validate(printerSaveSchema, {
        ...validRequest,
        interfaceName: 'EPSON-TM-T88',
        connectionType: 'windows'
      }).success
    ).toBe(true)
  })

  it('rejects an invalid connectionType', () => {
    expect(
      validate(printerSaveSchema, { ...validRequest, connectionType: 'bluetooth' }).success
    ).toBe(false)
  })
})

describe('printerDeleteSchema', () => {
  const validRequest = { id: 'kitchen-1', managerId: 1, managerPin: '9999' }

  it('accepts a well-formed request', () => {
    expect(validate(printerDeleteSchema, validRequest).success).toBe(true)
  })

  it('rejects a missing id', () => {
    expect(validate(printerDeleteSchema, { ...validRequest, id: '' }).success).toBe(false)
  })

  it('rejects a missing manager authorization', () => {
    expect(validate(printerDeleteSchema, { ...validRequest, managerPin: '' }).success).toBe(false)
  })
})

describe('printerTestSchema', () => {
  it('accepts a well-formed request', () => {
    expect(
      validate(printerTestSchema, { interfaceName: 'tcp://192.168.0.52:9100' }).success
    ).toBe(true)
  })

  it('rejects a missing interfaceName', () => {
    expect(validate(printerTestSchema, {}).success).toBe(false)
    expect(validate(printerTestSchema, { interfaceName: '' }).success).toBe(false)
  })

  it('requires no manager authorization fields', () => {
    expect(
      validate(printerTestSchema, {
        interfaceName: 'tcp://192.168.0.52:9100',
        managerId: 1,
        managerPin: '9999'
      }).success
    ).toBe(true)
  })

  it('accepts the Windows queue-name shape (docs/phase-174)', () => {
    expect(
      validate(printerTestSchema, {
        connectionType: 'windows',
        windowsPrinterName: 'EPSON-TM-T88'
      }).success
    ).toBe(true)
  })

  it('rejects a windows request with a missing or empty queue name', () => {
    expect(validate(printerTestSchema, { connectionType: 'windows' }).success).toBe(false)
    expect(
      validate(printerTestSchema, { connectionType: 'windows', windowsPrinterName: '' }).success
    ).toBe(false)
  })

  it('rejects connectionType: windows with no windowsPrinterName and no interfaceName either', () => {
    expect(validate(printerTestSchema, { connectionType: 'windows', interfaceName: '' }).success).toBe(
      false
    )
  })
})

describe('receiptPrintRequestSchema (docs/phase-165)', () => {
  it('accepts a bare sale-receipt request', () => {
    expect(validate(receiptPrintRequestSchema, { localId: 7 }).success).toBe(true)
  })

  it('accepts the automatic end-of-sale print shape', () => {
    expect(validate(receiptPrintRequestSchema, { localId: 7, auto: true }).success).toBe(true)
  })

  it('accepts a Z-report request', () => {
    expect(validate(receiptPrintRequestSchema, { shiftId: 3, isZReport: true }).success).toBe(true)
  })

  it('accepts an explicit printerType', () => {
    expect(validate(receiptPrintRequestSchema, { localId: 7, printerType: 'kitchen' }).success).toBe(true)
  })

  it('accepts an empty request (the handler itself reports "no order specified")', () => {
    expect(validate(receiptPrintRequestSchema, {}).success).toBe(true)
  })

  it('rejects a non-positive or non-integer localId', () => {
    expect(validate(receiptPrintRequestSchema, { localId: 0 }).success).toBe(false)
    expect(validate(receiptPrintRequestSchema, { localId: -1 }).success).toBe(false)
    expect(validate(receiptPrintRequestSchema, { localId: 1.5 }).success).toBe(false)
  })

  it('rejects an unrecognized printerType', () => {
    expect(validate(receiptPrintRequestSchema, { localId: 7, printerType: 'fax' }).success).toBe(false)
  })

  it('rejects a non-boolean auto', () => {
    expect(validate(receiptPrintRequestSchema, { localId: 7, auto: 'yes' }).success).toBe(false)
  })
})

describe('shopifySetStoreUrlSchema', () => {
  const validRequest = {
    storeUrl: 'https://rubis-pos.myshopify.com',
    managerId: 1,
    managerPin: '9999'
  }

  it('accepts a well-formed request', () => {
    expect(validate(shopifySetStoreUrlSchema, validRequest).success).toBe(true)
  })

  it('rejects a non-URL storeUrl', () => {
    expect(
      validate(shopifySetStoreUrlSchema, { ...validRequest, storeUrl: 'not-a-url' }).success
    ).toBe(false)
  })

  it('rejects a missing manager authorization', () => {
    const { managerId: _managerId, ...withoutManagerId } = validRequest
    expect(validate(shopifySetStoreUrlSchema, withoutManagerId).success).toBe(false)
    expect(
      validate(shopifySetStoreUrlSchema, { ...validRequest, managerPin: '' }).success
    ).toBe(false)
  })
})

describe('configValidateSchema', () => {
  const validRequest = {
    storeUrl: 'https://rubis-pos.myshopify.com',
    token: 'shpat_test'
  }

  it('accepts a well-formed request', () => {
    expect(validate(configValidateSchema, validRequest).success).toBe(true)
  })

  it('rejects a non-URL storeUrl', () => {
    expect(validate(configValidateSchema, { ...validRequest, storeUrl: 'not-a-url' }).success).toBe(
      false
    )
  })

  it('rejects an empty token', () => {
    expect(validate(configValidateSchema, { ...validRequest, token: '' }).success).toBe(false)
  })

  it('requires no manager authorization (runs before any staff session exists)', () => {
    expect(validate(configValidateSchema, validRequest).success).toBe(true)
  })
})

describe('configSaveSchema', () => {
  const validRequest = {
    storeUrl: 'https://rubis-pos.myshopify.com',
    token: 'shpat_test',
    locationId: 'gid://shopify/Location/1',
    locationName: 'Main Store'
  }

  it('accepts a well-formed request', () => {
    expect(validate(configSaveSchema, validRequest).success).toBe(true)
  })

  it('rejects a missing locationId', () => {
    const { locationId: _locationId, ...withoutLocation } = validRequest
    expect(validate(configSaveSchema, withoutLocation).success).toBe(false)
  })

  it('rejects an empty locationId', () => {
    expect(validate(configSaveSchema, { ...validRequest, locationId: '' }).success).toBe(false)
  })

  it('rejects a missing locationName', () => {
    const { locationName: _locationName, ...withoutLocationName } = validRequest
    expect(validate(configSaveSchema, withoutLocationName).success).toBe(false)
  })

  it('rejects a non-URL storeUrl', () => {
    expect(validate(configSaveSchema, { ...validRequest, storeUrl: 'not-a-url' }).success).toBe(false)
  })
})

describe('locationSetSchema', () => {
  const validRequest = {
    locationId: 'gid://shopify/Location/1',
    locationName: 'Main Store',
    managerId: 1,
    managerPin: '1234'
  }

  it('accepts a well-formed request', () => {
    expect(validate(locationSetSchema, validRequest).success).toBe(true)
  })

  it('rejects a missing locationId', () => {
    const { locationId: _locationId, ...withoutLocation } = validRequest
    expect(validate(locationSetSchema, withoutLocation).success).toBe(false)
  })

  it('rejects a missing locationName', () => {
    const { locationName: _locationName, ...withoutLocationName } = validRequest
    expect(validate(locationSetSchema, withoutLocationName).success).toBe(false)
  })

  it('rejects a missing manager authorization', () => {
    const { managerPin: _managerPin, ...withoutPin } = validRequest
    expect(validate(locationSetSchema, withoutPin).success).toBe(false)
  })
})

describe('etimsConfigSaveSchema', () => {
  const validRequest = {
    baseUrl: 'http://localhost:4444/',
    deviceIp: '154.79.253.236',
    devicePort: '8000',
    password: 'secret'
  }

  it('accepts a well-formed request', () => {
    expect(validate(etimsConfigSaveSchema, validRequest).success).toBe(true)
  })

  it('rejects a missing baseUrl', () => {
    const { baseUrl: _baseUrl, ...withoutBaseUrl } = validRequest
    expect(validate(etimsConfigSaveSchema, withoutBaseUrl).success).toBe(false)
  })

  it('rejects an empty password', () => {
    expect(validate(etimsConfigSaveSchema, { ...validRequest, password: '' }).success).toBe(false)
  })

  it('rejects a missing deviceIp or devicePort', () => {
    const { deviceIp: _deviceIp, ...withoutDeviceIp } = validRequest
    expect(validate(etimsConfigSaveSchema, withoutDeviceIp).success).toBe(false)
    const { devicePort: _devicePort, ...withoutDevicePort } = validRequest
    expect(validate(etimsConfigSaveSchema, withoutDevicePort).success).toBe(false)
  })

  it('rejects a malformed device IP, not just a missing one', () => {
    expect(validate(etimsConfigSaveSchema, { ...validRequest, deviceIp: 'localhost' }).success).toBe(
      false
    )
    expect(
      validate(etimsConfigSaveSchema, { ...validRequest, deviceIp: '192.168.1.256' }).success
    ).toBe(false)
  })

  it('rejects a non-numeric or out-of-range port', () => {
    expect(validate(etimsConfigSaveSchema, { ...validRequest, devicePort: '80oo' }).success).toBe(
      false
    )
    expect(validate(etimsConfigSaveSchema, { ...validRequest, devicePort: '0' }).success).toBe(false)
    expect(validate(etimsConfigSaveSchema, { ...validRequest, devicePort: '65536' }).success).toBe(
      false
    )
  })

  it('reports failures in plain words, with no field keys or codes', () => {
    const result = validate(etimsConfigSaveSchema, {
      ...validRequest,
      deviceIp: 'nope',
      devicePort: 'x'
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toMatch(/does not look like an IP address/)
    expect(result.error).toMatch(/whole number between 1 and 65535/)
  })
})

describe('etimsPasswordSetSchema', () => {
  const validRequest = { password: 'device-secret', managerId: 1, managerPin: '9999' }

  it('accepts a well-formed request', () => {
    expect(validate(etimsPasswordSetSchema, validRequest).success).toBe(true)
  })

  it('rejects a blank password — the form sends nothing rather than clearing the stored one', () => {
    expect(validate(etimsPasswordSetSchema, { ...validRequest, password: '   ' }).success).toBe(
      false
    )
  })

  it('rejects a missing manager authorization', () => {
    const { managerId: _managerId, ...withoutManagerId } = validRequest
    expect(validate(etimsPasswordSetSchema, withoutManagerId).success).toBe(false)
    expect(validate(etimsPasswordSetSchema, { ...validRequest, managerPin: '' }).success).toBe(false)
  })
})

describe('etimsIntegrationConfigSchema', () => {
  const validRequest = {
    baseUrl: 'http://localhost:4444/',
    deviceIp: '192.168.1.50',
    devicePort: '8000',
    defaultVatClass: 'A'
  }

  it('accepts a well-formed request', () => {
    expect(validate(etimsIntegrationConfigSchema, validRequest).success).toBe(true)
  })

  it('accepts a request with no defaultVatClass', () => {
    const { defaultVatClass: _vatClass, ...withoutVatClass } = validRequest
    expect(validate(etimsIntegrationConfigSchema, withoutVatClass).success).toBe(true)
  })

  it('applies the same IP and port rules the setup gate enforces', () => {
    expect(
      validate(etimsIntegrationConfigSchema, { ...validRequest, deviceIp: 'device.local' }).success
    ).toBe(false)
    expect(
      validate(etimsIntegrationConfigSchema, { ...validRequest, devicePort: '99999' }).success
    ).toBe(false)
  })
})

describe('storeIdentitySetSchema', () => {
  const validRequest = {
    storeName: 'Rubis Haile Selassie',
    storeKraPin: 'P051234567X',
    managerId: 1,
    managerPin: '9999'
  }

  it('accepts a well-formed request', () => {
    expect(validate(storeIdentitySetSchema, validRequest).success).toBe(true)
  })

  it('accepts a blank KRA PIN — the receipt simply omits the line', () => {
    expect(validate(storeIdentitySetSchema, { ...validRequest, storeKraPin: '' }).success).toBe(true)
  })

  it('rejects a blank store name — every receipt has a header', () => {
    expect(validate(storeIdentitySetSchema, { ...validRequest, storeName: '  ' }).success).toBe(
      false
    )
  })

  it('rejects a malformed KRA PIN with an example of a good one', () => {
    const result = validate(storeIdentitySetSchema, { ...validRequest, storeKraPin: '12345' })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toMatch(/P051234567X/)
  })

  it('rejects a missing manager authorization', () => {
    const { managerId: _managerId, ...withoutManagerId } = validRequest
    expect(validate(storeIdentitySetSchema, withoutManagerId).success).toBe(false)
  })
})

describe('configClearSchema', () => {
  const validRequest = { managerId: 1, managerPin: '9999' }

  it('accepts a well-formed request', () => {
    expect(validate(configClearSchema, validRequest).success).toBe(true)
  })

  it('rejects a missing manager authorization', () => {
    const { managerId: _managerId, ...withoutManagerId } = validRequest
    expect(validate(configClearSchema, withoutManagerId).success).toBe(false)
    expect(validate(configClearSchema, { ...validRequest, managerPin: '' }).success).toBe(false)
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

describe('mpesaIntegrationConfigSchema', () => {
  /**
   * Applied by `integrations:set-config` the way the eTIMS one is: the
   * generic envelope accepts any record, and the main process must not
   * trust a value because a screen validated it.
   */
  it('accepts a Daraja till, which needs no inbox folder', () => {
    const result = validate(mpesaIntegrationConfigSchema, {
      consumerKey: 'key',
      shortcode: '174379',
      environment: 'production',
      confirmationMethod: 'daraja'
    })

    expect(result.success).toBe(true)
  })

  /**
   * DELIBERATE TEST CHANGE (docs/phase-148.md step 2): this used to
   * assert `success: true` for an `'sms'` row with a folder — before the
   * schema refused `'sms'` outright while its parser is a stub
   * (`MPESA_SMS_PARSER_READY`). The client's POC decision keeps SMS mode
   * in code but makes it unselectable until the parser is real, so a
   * valid folder is no longer enough on its own.
   *   Old assertion: `success: true`.
   *   New assertion: `success: false`, with the "not available" reason.
   */
  it('rejects a message-based till even with a folder, while the SMS parser is a stub', () => {
    const result = validate(mpesaIntegrationConfigSchema, {
      confirmationMethod: 'sms',
      smsInboxPath: 'C:\gammu\inbox'
    })

    expect(result.success).toBe(false)
    expect(result.success === false && result.error).toMatch(/not available on this till yet/)
  })

  it('rejects a message-based till with no folder', () => {
    // Otherwise a till selects a method it cannot perform, and the
    // symptom is payments that never appear.
    const result = validate(mpesaIntegrationConfigSchema, { confirmationMethod: 'sms' })

    expect(result.success).toBe(false)
    expect(result.success === false && result.error).toMatch(/folder where M-Pesa messages arrive/)
  })

  it('rejects a message-based till whose folder is only whitespace', () => {
    const result = validate(mpesaIntegrationConfigSchema, {
      confirmationMethod: 'sms',
      smsInboxPath: '   '
    })

    expect(result.success).toBe(false)
  })

  it('rejects a confirmation method it does not know', () => {
    const result = validate(mpesaIntegrationConfigSchema, { confirmationMethod: 'carrier-pigeon' })

    expect(result.success).toBe(false)
  })

  /**
   * DELIBERATE TEST CHANGE (docs/phase-148.md step 2): the field's
   * default flipped from implicitly meaning Daraja to explicitly
   * `'manual'` — the client's POC default.
   *   Old assertion: title said "which means Daraja"; only checked
   *     `success: true`.
   *   New assertion: title says "which now means manual"; also checks
   *     the schema actually fills in `'manual'`, not just that the
   *     payload is accepted.
   */
  it('accepts a row with no method at all, which now means manual', () => {
    const result = validate(mpesaIntegrationConfigSchema, { consumerKey: 'key' })
    expect(result.success).toBe(true)
    expect(result.success && result.data.confirmationMethod).toBe('manual')
  })

  it('accepts an explicit manual row', () => {
    const result = validate(mpesaIntegrationConfigSchema, { confirmationMethod: 'manual' })
    expect(result.success).toBe(true)
    expect(result.success && result.data.confirmationMethod).toBe('manual')
  })
})

describe('stock take schemas', () => {
  const commit = {
    sessionId: 1,
    managerId: 2,
    managerPin: '2222',
    confirm: true as const
  }

  it('accepts a well-formed commit', () => {
    expect(validate(stockTakeCommitSchema, commit).success).toBe(true)
  })

  /**
   * The strongest location guarantee is that there is no field to
   * supply — not that a supplied one would be rejected.
   */
  it('has no locationId field to spoof on any stock-take payload', () => {
    expect(Object.keys(stockTakeCommitSchema.shape)).not.toContain('locationId')
    expect(Object.keys(stockTakeOpenSchema.shape)).not.toContain('locationId')
    expect(Object.keys(stockTakeCountSchema.shape)).not.toContain('locationId')
  })

  it('refuses a commit that was not explicitly confirmed', () => {
    expect(validate(stockTakeCommitSchema, { ...commit, confirm: false }).success).toBe(false)
    const { confirm: _confirm, ...withoutConfirm } = commit
    expect(validate(stockTakeCommitSchema, withoutConfirm).success).toBe(false)
  })

  it('refuses a commit with no manager credentials', () => {
    const { managerId: _id, managerPin: _pin, ...anonymous } = commit
    expect(validate(stockTakeCommitSchema, anonymous).success).toBe(false)
  })

  it('accepts an optional second approver', () => {
    const result = validate(stockTakeCommitSchema, {
      ...commit,
      secondApproverId: 3,
      secondApproverPin: '3333'
    })
    expect(result.success).toBe(true)
  })

  it('refuses a negative or fractional counted quantity', () => {
    const base = { sessionId: 1, variantId: 'v1', variantLabel: 'Mug' }
    expect(validate(stockTakeCountSchema, { ...base, countedQty: 0 }).success).toBe(true)
    expect(validate(stockTakeCountSchema, { ...base, countedQty: -1 }).success).toBe(false)
    expect(validate(stockTakeCountSchema, { ...base, countedQty: 1.5 }).success).toBe(false)
  })

  it('takes no unit price from the caller, so a variance cannot be undervalued', () => {
    expect(Object.keys(stockTakeCountSchema.shape)).not.toContain('unitPrice')
    expect(Object.keys(stockTakeCountSchema.shape)).not.toContain('unitPriceAtCount')
  })

  it('refuses a policy with a negative threshold or a zero expiry', () => {
    const base = { managerId: 2, managerPin: '2222', allowSelfApproval: false }
    expect(
      validate(stockTakeSettingsSchema, { ...base, varianceThresholdKes: 0, expiryHours: 12 })
        .success
    ).toBe(true)
    expect(
      validate(stockTakeSettingsSchema, { ...base, varianceThresholdKes: -1, expiryHours: 12 })
        .success
    ).toBe(false)
    expect(
      validate(stockTakeSettingsSchema, { ...base, varianceThresholdKes: 0, expiryHours: 0 })
        .success
    ).toBe(false)
  })
})

/**
 * `reports:end-of-day` / `reports:approve-day` (docs/phase-150.md
 * deferred approval to this; docs/phase-151/152 design it). Approving is
 * manager-gated exactly like every other privileged handler in
 * `main/index.ts` — the PIN itself is re-verified by `requireAdminPin`,
 * whose own generic wrong-PIN / non-admin / unknown-id refusals are
 * already covered by `tests/requireAdminPin.test.ts`; what belongs here
 * is the wire contract this endpoint adds on top of that shared gate.
 */
describe('endOfDayReportSchema', () => {
  it('accepts an empty payload — localDay defaults to today server-side', () => {
    expect(validate(endOfDayReportSchema, {}).success).toBe(true)
  })

  it('accepts a well-formed localDay', () => {
    expect(validate(endOfDayReportSchema, { localDay: '2026-09-10' }).success).toBe(true)
  })

  it('refuses a malformed localDay', () => {
    expect(validate(endOfDayReportSchema, { localDay: '10-09-2026' }).success).toBe(false)
    expect(validate(endOfDayReportSchema, { localDay: 'today' }).success).toBe(false)
  })
})

/**
 * `approveDayReportSchema` (docs/phase-153): rewritten from a single
 * `paymentIds` array to `approvedIds`/`excluded`, so a manager can leave
 * individual entries out of a review with a reason instead of an
 * all-or-nothing approval.
 *   Old assertions (phase-152): a well-formed `{ paymentIds: [...] }`
 *     payload was accepted; an empty `paymentIds` was refused
 *     unconditionally.
 *   New assertions: a well-formed `{ approvedIds, excluded }` payload is
 *     accepted; either array may be empty on its own (docs/phase-153
 *     decision 4 — a manager may leave every entry out), but not both;
 *     no id may appear in both lists or twice within one list.
 *   Decision that required it: docs/phase-153, "STEP 4 FOLLOW-UP (Part
 *     A2): let the manager leave individual entries out of an approval."
 */
describe('approveDayReportSchema', () => {
  const review = {
    managerId: 2,
    managerPin: '2222',
    localDay: '2026-09-10',
    approvedIds: [1, 2],
    excluded: [{ paymentId: 3, reason: 'not on statement' }]
  }

  it('accepts a well-formed review with both approved and excluded entries', () => {
    expect(validate(approveDayReportSchema, review).success).toBe(true)
  })

  it('accepts approvedIds with no excluded entries (the phase-152 all-approved case)', () => {
    expect(
      validate(approveDayReportSchema, { ...review, approvedIds: [1, 2, 3], excluded: [] }).success
    ).toBe(true)
  })

  it('accepts an empty approvedIds when every entry is excluded (docs/phase-153 decision 4)', () => {
    expect(
      validate(approveDayReportSchema, {
        ...review,
        approvedIds: [],
        excluded: [{ paymentId: 1 }, { paymentId: 2 }, { paymentId: 3 }]
      }).success
    ).toBe(true)
  })

  it('an excluded entry needs no reason — it is optional', () => {
    expect(
      validate(approveDayReportSchema, { ...review, excluded: [{ paymentId: 3 }] }).success
    ).toBe(true)
  })

  it('refuses a payload with no manager credentials, exactly like every other privileged action', () => {
    const { managerId: _id, managerPin: _pin, ...anonymous } = review
    expect(validate(approveDayReportSchema, anonymous).success).toBe(false)
  })

  it('refuses when both approvedIds and excluded are empty — nothing to record', () => {
    expect(
      validate(approveDayReportSchema, { ...review, approvedIds: [], excluded: [] }).success
    ).toBe(false)
  })

  it('refuses an id present in both approvedIds and excluded', () => {
    expect(
      validate(approveDayReportSchema, {
        ...review,
        approvedIds: [1, 3],
        excluded: [{ paymentId: 3, reason: 'not on statement' }]
      }).success
    ).toBe(false)
  })

  it('refuses the same id given twice within approvedIds', () => {
    expect(
      validate(approveDayReportSchema, { ...review, approvedIds: [1, 1, 2] }).success
    ).toBe(false)
  })

  it('refuses the same id given twice within excluded', () => {
    expect(
      validate(approveDayReportSchema, {
        ...review,
        excluded: [{ paymentId: 3 }, { paymentId: 3, reason: 'again' }]
      }).success
    ).toBe(false)
  })

  it('refuses a non-integer or non-positive id in either list', () => {
    expect(validate(approveDayReportSchema, { ...review, approvedIds: [1.5] }).success).toBe(false)
    expect(validate(approveDayReportSchema, { ...review, approvedIds: [0] }).success).toBe(false)
    expect(
      validate(approveDayReportSchema, { ...review, excluded: [{ paymentId: -1 }] }).success
    ).toBe(false)
  })

  it('refuses a malformed localDay', () => {
    expect(validate(approveDayReportSchema, { ...review, localDay: '2026/09/10' }).success).toBe(
      false
    )
  })

  it('caps an exclusion reason at 200 characters', () => {
    expect(
      validate(approveDayReportSchema, { ...review, excluded: [{ paymentId: 3, reason: 'x'.repeat(200) }] })
        .success
    ).toBe(true)
    expect(
      validate(approveDayReportSchema, { ...review, excluded: [{ paymentId: 3, reason: 'x'.repeat(201) }] })
        .success
    ).toBe(false)
  })

  it('accepts an optional note, capped at 500 characters', () => {
    expect(validate(approveDayReportSchema, { ...review, note: 'checked' }).success).toBe(true)
    expect(validate(approveDayReportSchema, { ...review, note: 'x'.repeat(501) }).success).toBe(false)
  })
})
