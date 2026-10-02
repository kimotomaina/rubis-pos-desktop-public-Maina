/**
 * `resendFiscalization` tests (phase-76, Part C).
 *
 * The manual resend entry point Steps 3/4's UI will call. Runs against
 * a real in-memory `RubisDatabase`, proving it reads the sale's STORED
 * fiscal request (`fiscal_request_json`, phase-76 Part C's addition to
 * `orders`) rather than reconstructing one — notably, this function's
 * signature is just `(deps, localId)`: it has no parameter through
 * which fresh cart/checkout data could flow in even if it wanted to.
 */

import { describe, it, expect, vi } from 'vitest'
import type { AxiosInstance } from 'axios'
import { RubisDatabase } from '../src/main/services/database.js'
import { hashPin } from '../src/main/services/auth.js'
import { resendFiscalization, correctPinAndResend, buildFiscalResendResult } from '../src/main/services/fiscal-retry.js'
import { RealFiscalizationProvider, UNVERIFIABLE_RETRY_REASON } from '../src/main/services/integrations/real-etims-provider.js'
import type { FiscalInvoiceRequest } from '../src/main/services/integrations/etims.js'
import type { CartItem } from '../src/renderer/src/types/shopify.js'

/**
 * Device details every construction here supplies.
 *
 * `RealFiscalizationProvider` has no defaults for ip/port/password by
 * design (a guessed password reads as a device fault on the wire — see
 * `docs/phase-89.md` section 5), and without them `submitInvoice`
 * short-circuits with "not set up yet" before sending anything. Tests
 * that want the not-configured path assert it explicitly in
 * `tests/fiscalNotConfigured.test.ts`.
 */
const TEST_DEVICE = {
  deviceIp: '192.168.1.50',
  devicePort: '8000',
  password: 'test-device-password'
} as const

function freshDb(): RubisDatabase {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  return db
}

function seedStaff(db: RubisDatabase): number {
  const { staffId } = db.createStaff({ name: 'Alex', pinHash: hashPin('1234'), role: 'cashier' })
  return staffId
}

const cartItem: CartItem = {
  id: 'gid://shopify/ProductVariant/201',
  productId: 'gid://shopify/Product/101',
  title: 'RUBIS Mug',
  variantTitle: 'Small',
  price: 60,
  quantity: 2,
  image: null
}

/** Queues an order and stores a fiscal request against it, mirroring what `runCheckout` would have done on the original attempt. */
function seedOrderWithStoredRequest(
  db: RubisDatabase,
  staffId: number,
  overrides: Partial<FiscalInvoiceRequest> = {}
): { localId: number; storedRequest: FiscalInvoiceRequest } {
  const clientOrderUuid = overrides.clientOrderUuid ?? 'uuid-resend'
  const { localId } = db.queueOrder({
    items: [cartItem],
    total: 139.2,
    clientOrderUuid,
    staffId,
    staffName: 'Alex',
    paymentMethod: 'cash',
    tenderedAmount: 150,
    changeDue: 10.8
  })
  const storedRequest: FiscalInvoiceRequest = {
    clientOrderUuid,
    localId,
    items: [{ description: 'RUBIS Mug', quantity: 2, unitPrice: 60, taxRate: 0.16, pluCode: cartItem.id }],
    total: 139.2,
    taxAmount: 22.272,
    paymentMethod: 'cash',
    amountTendered: 150,
    ...overrides
  }
  db.setOrderFiscalRequest(localId, storedRequest)
  return { localId, storedRequest }
}

describe('resendFiscalization', () => {
  it('resend of a needs_fixing order re-attempts using the STORED request and can succeed', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const { localId, storedRequest } = seedOrderWithStoredRequest(db, staffId, {
      clientOrderUuid: 'uuid-needs-fixing',
      buyerPin: 'P051234567Z'
    })
    db.setOrderFiscalFailure(localId, 'needs_fixing', 'Wrong client PIN', 'data')

    const submitInvoice = vi.fn().mockResolvedValue({
      ok: true,
      data: { invoiceNumber: 'KRA-RESEND', qrCode: 'base64qr', fiscalizedAt: '2026-01-01T00:00:00.000Z' }
    })

    const outcome = await resendFiscalization({ db, fiscalizationProvider: { submitInvoice } }, localId)

    expect(outcome.ok).toBe(true)
    // The exact stored fields, plus isRetry:true — nothing rebuilt or substituted.
    expect(submitInvoice).toHaveBeenCalledWith({ ...storedRequest, isRetry: true })
    const order = db.getOrder(localId)
    expect(order?.fiscal_status).toBe('fiscalized')
    expect(order?.fiscal_invoice_number).toBe('KRA-RESEND')
    expect(order?.fiscal_error_reason).toBeNull()
    expect(order?.fiscal_error_kind).toBeNull()
  })

  /** docs/phase-163, Commit 1 — the manual-resend path also forwards vatGroups to storage. */
  it('a successful resend stores the VAT-group amounts from that attempt', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const { localId } = seedOrderWithStoredRequest(db, staffId, { clientOrderUuid: 'uuid-resend-vatgroups' })
    db.setOrderFiscalFailure(localId, 'needs_fixing', 'some prior rejection', 'data')

    const submitInvoice = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        invoiceNumber: 'KRA-RESEND-VG',
        qrCode: 'base64qr',
        fiscalizedAt: '2026-01-01T00:00:00.000Z',
        vatGroups: { A: '60.00', B: '40.00' }
      }
    })

    await resendFiscalization({ db, fiscalizationProvider: { submitInvoice } }, localId)

    const stored = db.getOrder(localId)?.fiscal_vat_groups_json
    expect(stored).not.toBeNull()
    expect(JSON.parse(stored as string)).toEqual({ A: '60.00', B: '40.00' })
  })

  /** docs/phase-164 — the manual-resend path also forwards the control unit's date/time and serial. */
  it('a successful resend stores fiscalizedAt, fiscalizedAtSource and cuSerial from that attempt', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const { localId } = seedOrderWithStoredRequest(db, staffId, { clientOrderUuid: 'uuid-resend-cu-fields' })
    db.setOrderFiscalFailure(localId, 'needs_fixing', 'some prior rejection', 'data')

    const submitInvoice = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        invoiceNumber: 'KRA-RESEND-CU',
        qrCode: 'base64qr',
        fiscalizedAt: '27-08-2026 09:30:00',
        fiscalizedAtSource: 'device',
        cuSerialNumber: 'CU-SERIAL-RESEND'
      }
    })

    await resendFiscalization({ db, fiscalizationProvider: { submitInvoice } }, localId)

    const order = db.getOrder(localId)
    expect(order?.fiscal_fiscalized_at).toBe('27-08-2026 09:30:00')
    expect(order?.fiscal_fiscalized_at_source).toBe('device')
    expect(order?.fiscal_cu_serial).toBe('CU-SERIAL-RESEND')
  })

  it('reuses the stored TraderSystemInvNum — proven against the REAL provider, not a mock', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const { localId, storedRequest } = seedOrderWithStoredRequest(db, staffId, {
      clientOrderUuid: 'uuid-tradersysteminvnum'
    })
    db.setOrderFiscalFailure(localId, 'needs_fixing', 'some prior rejection', 'data')

    const post = vi.fn().mockImplementation((_path: string, body: string) => {
      const command = /<Command Name="([^"]+)"/.exec(body)?.[1] ?? ''
      switch (command) {
        case 'ReadStatus':
          return Promise.resolve({ data: '<Res Code="0"><CU_fiscalized>1</CU_fiscalized><Paired_with_TIMS>1</Paired_with_TIMS></Res>' })
        case 'ReadCurrentReceiptInfo':
          return Promise.resolve({
            data: '<Res Code="0"><OptionIsReceiptOpened>1</OptionIsReceiptOpened><SubtotalAmountVATGA>139.20</SubtotalAmountVATGA></Res>'
          })
        case 'CloseReceipt':
          return Promise.resolve({ data: '<Res Code="0"><InvoiceNum>KRA-0055</InvoiceNum><QRcode>base64qr</QRcode></Res>' })
        case 'ReadDateTime':
          return Promise.resolve({ data: '<Res Code="0"><DateTime>01-01-2026 09:30</DateTime></Res>' })
        default:
          return Promise.resolve({ data: '<Res Code="0"/>' })
      }
    })
    const httpClient = {
      post,
      get: vi.fn().mockResolvedValue({ data: '<Res Code="0"/>' }),
      defaults: { baseURL: 'http://localhost:4444/' }
    } as unknown as AxiosInstance
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient })

    await resendFiscalization({ db, fiscalizationProvider: provider }, localId)

    const openCall = post.mock.calls.find((c) => String(c[1]).includes('OpenInvoiceWithFreeCustomerData'))
    expect(openCall).toBeDefined()
    // Pure function of localId (phase-74, Part A) — identical to what
    // the original attempt would have posted for the same sale.
    expect(String(openCall![1])).toContain(`TraderSystemInvNum" Value="INV-${String(storedRequest.localId).padStart(9, '0')}"`)
  })

  it('resend of an already-fiscalized order is a no-op: no device call, returns the stored result', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const { localId } = seedOrderWithStoredRequest(db, staffId, { clientOrderUuid: 'uuid-already-fiscalized' })
    db.setOrderFiscalInfo(localId, 'KRA-ALREADY', 'base64qr')

    const submitInvoice = vi.fn()

    const outcome = await resendFiscalization({ db, fiscalizationProvider: { submitInvoice } }, localId)

    expect(submitInvoice).not.toHaveBeenCalled()
    expect(outcome.ok).toBe(true)
    expect(outcome.ok && outcome.data.invoiceNumber).toBe('KRA-ALREADY')
  })

  /**
   * REWRITTEN (docs/phase-208).
   * OLD: a resent sale whose OpenInvoice was refused asked ReadCUinvoiceNumber and, when the
   * device named a number, was recorded as fiscalized with that number and no second filing.
   * NEW: ReadCUinvoiceNumber is never sent (it names no sale, so its answer can be another
   * till's, or the zero counter); the refusal is final, so the sale is flagged for a person,
   * nothing is recorded as filed, and no SellPLU or CloseReceipt is sent.
   */
  it('resend never recovers from ReadCUinvoiceNumber: a final OpenInvoice refusal is flagged, not recorded as filed', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const { localId } = seedOrderWithStoredRequest(db, staffId, { clientOrderUuid: 'uuid-resend-recovery' })
    db.setOrderFiscalFailure(localId, 'waiting', 'device unreachable', 'technical')

    const post = vi.fn().mockImplementation((_path: string, body: string) => {
      const command = /<Command Name="([^"]+)"/.exec(body)?.[1] ?? ''
      if (command === 'OpenInvoiceWithFreeCustomerData') {
        return Promise.resolve({
          data: '<Res Code="40"><Err Source="Device" Type="FPException" STE1="00" STE2="39" FPLibErrorCode="00"><Message>Conflict in tax group</Message></Err></Res>'
        })
      }
      if (command === 'ReadCUinvoiceNumber') {
        return Promise.resolve({ data: '<Res Code="0"><CU_InvoiceNumber>0000000005555555</CU_InvoiceNumber></Res>' })
      }
      switch (command) {
        case 'ReadStatus':
          return Promise.resolve({ data: '<Res Code="0"><CU_fiscalized>1</CU_fiscalized><Paired_with_TIMS>1</Paired_with_TIMS></Res>' })
        default:
          return Promise.resolve({ data: '<Res Code="0"/>' })
      }
    })
    const httpClient = {
      post,
      get: vi.fn().mockResolvedValue({ data: '<Res Code="0"/>' }),
      defaults: { baseURL: 'http://localhost:4444/' }
    } as unknown as AxiosInstance
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient })

    const outcome = await resendFiscalization({ db, fiscalizationProvider: provider }, localId)

    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.reason).toBe(UNVERIFIABLE_RETRY_REASON)
    const commandsSent = post.mock.calls.map((c) => /<Command Name="([^"]+)"/.exec(String(c[1]))?.[1])
    expect(commandsSent).not.toContain('ReadCUinvoiceNumber')
    expect(commandsSent).not.toContain('SellPLUfromExtDB')
    expect(commandsSent).not.toContain('CloseReceipt')
    const order = db.getOrder(localId)
    expect(order?.fiscal_status).toBe('needs_fixing')
    expect(order?.fiscal_invoice_number).toBeNull()
  })

  it('resend of a still-failing (retryable/technical) order re-queues it rather than losing it (Rule 3)', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const { localId } = seedOrderWithStoredRequest(db, staffId, { clientOrderUuid: 'uuid-resend-still-technical' })
    db.setOrderFiscalFailure(localId, 'waiting', 'device unreachable', 'technical')

    const submitInvoice = vi.fn().mockResolvedValue({
      ok: false,
      reason: 'device unreachable',
      kind: 'technical',
      retryable: true
    })

    await resendFiscalization({ db, fiscalizationProvider: { submitInvoice } }, localId)

    expect(db.getOrder(localId)?.fiscal_status).toBe('waiting')
    expect(db.getPendingFiscalQueue(Date.now())).toHaveLength(1)
  })

  it('resend of a still-failing (data) order stays needs_fixing and is NOT queued', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const { localId } = seedOrderWithStoredRequest(db, staffId, { clientOrderUuid: 'uuid-resend-still-data' })
    db.setOrderFiscalFailure(localId, 'needs_fixing', 'Wrong client PIN', 'data')

    const submitInvoice = vi.fn().mockResolvedValue({
      ok: false,
      reason: 'Wrong client PIN',
      kind: 'data',
      retryable: false
    })

    const outcome = await resendFiscalization({ db, fiscalizationProvider: { submitInvoice } }, localId)

    expect(outcome.ok).toBe(false)
    expect(db.getOrder(localId)?.fiscal_status).toBe('needs_fixing')
    expect(db.getPendingFiscalQueue(Date.now())).toHaveLength(0)
  })

  it('reports a clean failure for an order id that does not exist', async () => {
    const db = freshDb()
    const submitInvoice = vi.fn()

    const outcome = await resendFiscalization({ db, fiscalizationProvider: { submitInvoice } }, 999)

    expect(outcome.ok).toBe(false)
    expect(submitInvoice).not.toHaveBeenCalled()
  })

  it('reports a clean failure when the order has no stored fiscal request yet (fiscalization never attempted)', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const { localId } = db.queueOrder({
      items: [cartItem],
      total: 139.2,
      clientOrderUuid: 'uuid-never-attempted',
      staffId,
      staffName: 'Alex',
      paymentMethod: 'cash',
      tenderedAmount: 150,
      changeDue: 10.8
    })
    const submitInvoice = vi.fn()

    const outcome = await resendFiscalization({ db, fiscalizationProvider: { submitInvoice } }, localId)

    expect(outcome.ok).toBe(false)
    expect(submitInvoice).not.toHaveBeenCalled()
  })
})

describe('correctPinAndResend (phase-78, Part C)', () => {
  it('correcting the PIN updates ONLY buyerPin on the stored request, then resends and can succeed', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const { localId, storedRequest } = seedOrderWithStoredRequest(db, staffId, {
      clientOrderUuid: 'uuid-correct-pin',
      buyerPin: 'P059999999Z',
      companyName: 'Acme Traders Ltd'
    })
    db.setOrderFiscalFailure(localId, 'needs_fixing', 'Wrong client PIN', 'data')

    const submitInvoice = vi.fn().mockResolvedValue({
      ok: true,
      data: { invoiceNumber: 'KRA-FIXED', qrCode: 'base64qr', fiscalizedAt: '2026-01-01T00:00:00.000Z' }
    })

    const outcome = await correctPinAndResend(
      { db, fiscalizationProvider: { submitInvoice } },
      localId,
      'P051234567Z'
    )

    expect(outcome.ok).toBe(true)
    // Everything except buyerPin matches the original stored request exactly.
    expect(submitInvoice).toHaveBeenCalledWith({
      ...storedRequest,
      buyerPin: 'P051234567Z',
      isRetry: true
    })
    const order = db.getOrder(localId)
    expect(order?.fiscal_status).toBe('fiscalized')
    expect(order?.fiscal_invoice_number).toBe('KRA-FIXED')
    // The stored request itself is updated too, not just what got sent.
    const updatedStored = JSON.parse(order!.fiscal_request_json!) as FiscalInvoiceRequest
    expect(updatedStored.buyerPin).toBe('P051234567Z')
    expect(updatedStored.companyName).toBe('Acme Traders Ltd')
    expect(updatedStored.items).toEqual(storedRequest.items)
    expect(updatedStored.total).toBe(storedRequest.total)
  })

  it('removing the PIN (buyerPin: undefined) clears it from the stored request and resends', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const { localId } = seedOrderWithStoredRequest(db, staffId, {
      clientOrderUuid: 'uuid-remove-pin',
      buyerPin: 'P059999999Z'
    })
    db.setOrderFiscalFailure(localId, 'needs_fixing', 'Wrong client PIN', 'data')

    const submitInvoice = vi.fn().mockResolvedValue({
      ok: true,
      data: { invoiceNumber: 'KRA-B2C', qrCode: '', fiscalizedAt: '2026-01-01T00:00:00.000Z' }
    })

    await correctPinAndResend({ db, fiscalizationProvider: { submitInvoice } }, localId, undefined)

    // JSON round-tripping the stored request drops an `undefined`
    // buyerPin entirely (not stored as a literal `undefined` value) —
    // confirming the PIN is genuinely gone, not just blanked.
    expect(submitInvoice.mock.calls[0][0].buyerPin).toBeUndefined()
    expect('buyerPin' in submitInvoice.mock.calls[0][0]).toBe(false)
    const order = db.getOrder(localId)
    const updatedStored = JSON.parse(order!.fiscal_request_json!) as FiscalInvoiceRequest
    expect(updatedStored.buyerPin).toBeUndefined()
    expect(order?.fiscal_status).toBe('fiscalized')
  })

  it('a resend that still fails (still a wrong PIN) stays needs_fixing/data, not falsely fiscalized', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const { localId } = seedOrderWithStoredRequest(db, staffId, {
      clientOrderUuid: 'uuid-still-wrong',
      buyerPin: 'P059999999Z'
    })
    db.setOrderFiscalFailure(localId, 'needs_fixing', 'Wrong client PIN', 'data')

    const submitInvoice = vi.fn().mockResolvedValue({
      ok: false,
      reason: 'Wrong client PIN',
      kind: 'data',
      retryable: false,
      dataIssue: 'wrong-pin'
    })

    const outcome = await correctPinAndResend(
      { db, fiscalizationProvider: { submitInvoice } },
      localId,
      'P058888888Z'
    )

    expect(outcome.ok).toBe(false)
    const order = db.getOrder(localId)
    expect(order?.fiscal_status).toBe('needs_fixing')
    expect(order?.fiscal_error_kind).toBe('data')
    // Not queued — a data rejection is never auto-retried.
    expect(db.getPendingFiscalQueue(Date.now())).toHaveLength(0)
  })

  it('goes through the existing guarded path — cannot file twice even if called on an already-fiscalized order', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const { localId } = seedOrderWithStoredRequest(db, staffId, { clientOrderUuid: 'uuid-already-done' })
    db.setOrderFiscalInfo(localId, 'KRA-ALREADY', 'base64qr')

    const submitInvoice = vi.fn()

    const outcome = await correctPinAndResend(
      { db, fiscalizationProvider: { submitInvoice } },
      localId,
      'P051234567Z'
    )

    expect(submitInvoice).not.toHaveBeenCalled()
    expect(outcome.ok).toBe(true)
    expect(outcome.ok && outcome.data.invoiceNumber).toBe('KRA-ALREADY')
  })

  it('reports a clean failure when there is no stored request to correct', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const { localId } = db.queueOrder({
      items: [cartItem],
      total: 139.2,
      clientOrderUuid: 'uuid-nothing-stored',
      staffId,
      staffName: 'Alex',
      paymentMethod: 'cash',
      tenderedAmount: 150,
      changeDue: 10.8
    })
    const submitInvoice = vi.fn()

    const outcome = await correctPinAndResend(
      { db, fiscalizationProvider: { submitInvoice } },
      localId,
      'P051234567Z'
    )

    expect(outcome.ok).toBe(false)
    expect(submitInvoice).not.toHaveBeenCalled()
  })
})

describe('buildFiscalResendResult (phase-78, Part C)', () => {
  it('builds a fiscalized result with the invoice/QR after a successful resend', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const { localId } = seedOrderWithStoredRequest(db, staffId, { clientOrderUuid: 'uuid-result-ok' })
    db.setOrderFiscalFailure(localId, 'needs_fixing', 'Wrong client PIN', 'data')

    const submitInvoice = vi.fn().mockResolvedValue({
      ok: true,
      data: { invoiceNumber: 'KRA-9999', qrCode: 'base64qr', fiscalizedAt: '2026-01-01T00:00:00.000Z' }
    })
    const outcome = await correctPinAndResend(
      { db, fiscalizationProvider: { submitInvoice } },
      localId,
      'P051234567Z'
    )

    const result = buildFiscalResendResult(db, localId, outcome)

    expect(result).toEqual({
      localId,
      fiscal: { invoiceNumber: 'KRA-9999', qrCode: 'base64qr' },
      fiscalStatus: 'fiscalized',
      fiscalErrorReason: null,
      fiscalErrorKind: null,
      fiscalDataIssue: null
    })
  })

  it('builds a needs_fixing/wrong-pin result when the resend still fails the same way', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const { localId } = seedOrderWithStoredRequest(db, staffId, { clientOrderUuid: 'uuid-result-still-wrong' })
    db.setOrderFiscalFailure(localId, 'needs_fixing', 'Wrong client PIN', 'data')

    const submitInvoice = vi.fn().mockResolvedValue({
      ok: false,
      reason: 'Wrong client PIN',
      kind: 'data',
      retryable: false,
      dataIssue: 'wrong-pin'
    })
    const outcome = await correctPinAndResend(
      { db, fiscalizationProvider: { submitInvoice } },
      localId,
      'P058888888Z'
    )

    const result = buildFiscalResendResult(db, localId, outcome)

    expect(result).toEqual({
      localId,
      fiscal: undefined,
      fiscalStatus: 'needs_fixing',
      fiscalErrorReason: 'Wrong client PIN',
      fiscalErrorKind: 'data',
      fiscalDataIssue: 'wrong-pin'
    })
  })
})
