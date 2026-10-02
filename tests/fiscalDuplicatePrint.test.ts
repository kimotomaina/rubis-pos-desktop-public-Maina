/**
 * "Print ETR copy at the fiscal device" (docs/phase-196-2): the provider's
 * `printLastReceiptDuplicate`, the `printFiscalDuplicate` service behind
 * the IPC handler, and the mock provider.
 *
 * Nothing here talks to a device: the provider runs against a recording
 * fake transport, and every posted command is checked against the vendor
 * contract in `tests/fixtures/tremol-contract.json`.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AxiosInstance } from 'axios'
import { RubisDatabase } from '../src/main/services/database.js'
import { hashPin } from '../src/main/services/auth.js'
import { printFiscalDuplicate } from '../src/main/services/fiscal-duplicate-print.js'
import { RealFiscalizationProvider } from '../src/main/services/integrations/real-etims-provider.js'
import { MockFiscalizationProvider } from '../src/main/services/integrations/mock-etims-provider.js'
import { canPrintDuplicate } from '../src/main/lib/duplicatePrintGuard.js'
import type {
  DuplicatePrintDeviceState,
  DuplicatePrintGate,
  DuplicatePrintOutcome,
  FiscalizationProvider
} from '../src/main/services/integrations/etims.js'
import type { CartItem } from '../src/renderer/src/types/shopify.js'

const PASSWORD = 'test-device-password'
const TEST_DEVICE = { deviceIp: '192.168.1.50', devicePort: '8000', password: PASSWORD } as const
const ORDER_NUMBER = '0110605040001000810'
const LATER_NUMBER = '0110605040001000811'

interface ContractCommand {
  args: { name: string }[]
  response: { name: string }[]
}
const contract: { commands: Record<string, ContractCommand> } = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'tremol-contract.json'), 'utf8')
)

const readStatusXml = (open: '0' | '1'): string =>
  `<Res Code="0"><Res Name="Opened_Fiscal_Receipt" Value="${open}" Type="Status" Byte="2" Bit="1"/>` +
  '<Res Name="CU_fiscalized" Value="1" Type="Status" Byte="3" Bit="5"/>' +
  '<Res Name="Paired_with_TIMS" Value="1" Type="Status" Byte="4" Bit="0"/></Res>'

const lastReceiptXml = (number: string): string =>
  `<Res Code="0"><Res Name="LastCUInvoiceNum" Value="${number}" Type="Text"/>` +
  '<Res Name="LastReceiptNum" Value="0000042" Type="Decimal_with_format"/></Res>'

const DEVICE_ERROR_XML = (message: string): string =>
  `<Res Code="40"><Err Source="Device" Type="FPException" STE1="00" STE2="32" FPLibErrorCode="00"><Message>${message}</Message></Err></Res>`

/** Records every command posted; `responseFor` may return a promise to hold a call open. */
function makeTransport(responseFor: (command: string, nth: number) => string | Promise<string>): {
  client: AxiosInstance
  posted: string[]
} {
  const posted: string[] = []
  const counts = new Map<string, number>()
  const post = vi.fn().mockImplementation(async (_path: string, body: string) => {
    const name = /<Command\s+Name="([^"]*)"/.exec(body)?.[1] ?? ''
    posted.push(name)
    const nth = (counts.get(name) ?? 0) + 1
    counts.set(name, nth)
    return { data: await responseFor(name, nth) }
  })
  const get = vi.fn().mockResolvedValue({ data: '<Res Code="0"/>' })
  const client = { post, get, defaults: { baseURL: 'http://localhost:4444/' } } as unknown as AxiosInstance
  return { client, posted }
}

/** A healthy device whose last receipt is `last` before the send and `lastAfter` after it. */
function healthyDevice(last: string, options: { open?: '0' | '1'; lastAfter?: string } = {}) {
  return (command: string, nth: number): string => {
    if (command === 'ReadStatus') return readStatusXml(options.open ?? '0')
    if (command === 'ReadLastAndTotalReceiptNum') {
      return lastReceiptXml(nth === 1 ? last : (options.lastAfter ?? last))
    }
    return '<Res Code="0"/>'
  }
}

const allow: DuplicatePrintGate = () => ({ allowed: true, reason: 'ok' })
const deny: DuplicatePrintGate = () => ({ allowed: false, reason: 'no thanks' })

/** The real guard, as the service builds it for an order filed as {@link ORDER_NUMBER}. */
const realGuard: DuplicatePrintGate = (state) =>
  canPrintDuplicate({
    orderCuInvoiceNumber: ORDER_NUMBER,
    deviceLastCuInvoiceNumber: state.deviceLastCuInvoiceNumber,
    fiscalStatus: 'fiscalized',
    queueHasInFlight: state.queueHasInFlight,
    receiptOpen: state.receiptOpen
  })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('contract: the commands this feature sends exist and take no arguments', () => {
  it('InfoLastReceiptDuplicate has zero arguments and an empty response', () => {
    expect(contract.commands.InfoLastReceiptDuplicate).toBeDefined()
    expect(contract.commands.InfoLastReceiptDuplicate.args).toEqual([])
    expect(contract.commands.InfoLastReceiptDuplicate.response).toEqual([])
  })

  it('ReadLastAndTotalReceiptNum has zero arguments and returns LastCUInvoiceNum', () => {
    expect(contract.commands.ReadLastAndTotalReceiptNum.args).toEqual([])
    expect(contract.commands.ReadLastAndTotalReceiptNum.response.map((r) => r.name)).toContain('LastCUInvoiceNum')
  })

  it('ReadStatus returns the Opened_Fiscal_Receipt bit the provider reads', () => {
    expect(contract.commands.ReadStatus.response.map((r) => r.name)).toContain('Opened_Fiscal_Receipt')
  })
})

describe('RealFiscalizationProvider.printLastReceiptDuplicate', () => {
  it('posts InfoLastReceiptDuplicate exactly once, between the two last-receipt reads, and only contract commands', async () => {
    const { client, posted } = makeTransport(healthyDevice(ORDER_NUMBER))
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: client })

    const outcome = await provider.printLastReceiptDuplicate(allow)

    expect(outcome).toEqual({ status: 'sent', deviceLastBefore: ORDER_NUMBER, deviceLastAfter: ORDER_NUMBER })
    expect(posted.filter((name) => name === 'InfoLastReceiptDuplicate')).toHaveLength(1)
    expect(posted).toEqual([
      'ReadStatus',
      'ReadLastAndTotalReceiptNum',
      'InfoLastReceiptDuplicate',
      'ReadLastAndTotalReceiptNum'
    ])
    for (const name of posted) expect(contract.commands[name]).toBeDefined()
  })

  it('passes the gate the device last number and open-receipt bit it just read', async () => {
    const { client } = makeTransport(healthyDevice(ORDER_NUMBER, { open: '1' }))
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: client })
    const gate = vi.fn<DuplicatePrintGate>(deny)

    await provider.printLastReceiptDuplicate(gate)

    expect(gate).toHaveBeenCalledWith({
      deviceLastCuInvoiceNumber: ORDER_NUMBER,
      receiptOpen: true,
      queueHasInFlight: false
    })
  })

  it('sends nothing when the gate refuses', async () => {
    const { client, posted } = makeTransport(healthyDevice(ORDER_NUMBER))
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: client })

    const outcome = await provider.printLastReceiptDuplicate(deny)

    expect(outcome).toEqual({ status: 'refused', reason: 'no thanks', deviceLastBefore: ORDER_NUMBER })
    expect(posted).not.toContain('InfoLastReceiptDuplicate')
  })

  it('refuses, without queueing or posting anything, while another call is using the device', async () => {
    let release: (xml: string) => void = () => undefined
    const held = new Promise<string>((resolve) => {
      release = resolve
    })
    const { client, posted } = makeTransport((command) => (command === 'ReadStatus' ? held : '<Res Code="0"/>'))
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: client })
    const busyCall = provider.checkConnectivity()
    const gate = vi.fn<DuplicatePrintGate>(realGuard)

    const outcome = await provider.printLastReceiptDuplicate(gate)

    expect(outcome).toEqual({
      status: 'refused',
      reason: 'The till is still sending a sale to the fiscal device. Try again in a moment.',
      deviceLastBefore: null
    })
    expect(gate).toHaveBeenCalledWith({ deviceLastCuInvoiceNumber: '', receiptOpen: false, queueHasInFlight: true })
    expect(posted).not.toContain('InfoLastReceiptDuplicate')
    expect(posted).not.toContain('ReadLastAndTotalReceiptNum')

    release(readStatusXml('0'))
    await busyCall
  })

  it('is free again once the earlier call has finished', async () => {
    const { client, posted } = makeTransport(healthyDevice(ORDER_NUMBER))
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: client })
    await provider.checkConnectivity()

    const outcome = await provider.printLastReceiptDuplicate(allow)

    expect(outcome.status).toBe('sent')
    expect(posted.filter((name) => name === 'InfoLastReceiptDuplicate')).toHaveLength(1)
  })

  it('does not retry a device error: one post, status error, sent true', async () => {
    const { client, posted } = makeTransport((command, nth) =>
      command === 'InfoLastReceiptDuplicate'
        ? DEVICE_ERROR_XML('Illegal command')
        : healthyDevice(ORDER_NUMBER)(command, nth)
    )
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: client })

    const outcome = await provider.printLastReceiptDuplicate(allow)

    expect(outcome).toMatchObject({ status: 'error', sent: true, deviceLastBefore: ORDER_NUMBER })
    expect(posted.filter((name) => name === 'InfoLastReceiptDuplicate')).toHaveLength(1)
  })

  it('does not re-send after a Code 53 (session dropped): still exactly one post of the command', async () => {
    const { client, posted } = makeTransport((command, nth) =>
      command === 'InfoLastReceiptDuplicate'
        ? '<Res Code="53" errSource="Server"><Message>Client settings missing</Message></Res>'
        : healthyDevice(ORDER_NUMBER)(command, nth)
    )
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: client })

    const outcome = await provider.printLastReceiptDuplicate(allow)

    expect(outcome.status).toBe('error')
    expect(posted.filter((name) => name === 'InfoLastReceiptDuplicate')).toHaveLength(1)
  })

  it('does not send when the device will not say whether a receipt is open', async () => {
    const { client, posted } = makeTransport((command, nth) =>
      command === 'ReadStatus'
        ? '<Res Code="0"><Res Name="CU_fiscalized" Value="1" Type="Status" Byte="3" Bit="5"/><Res Name="Paired_with_TIMS" Value="1" Type="Status" Byte="4" Bit="0"/></Res>'
        : healthyDevice(ORDER_NUMBER)(command, nth)
    )
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: client })

    const outcome = await provider.printLastReceiptDuplicate(allow)

    expect(outcome).toMatchObject({ status: 'error', sent: false })
    expect(posted).not.toContain('InfoLastReceiptDuplicate')
  })

  it('does not send when the last receipt number cannot be read', async () => {
    const { client, posted } = makeTransport((command, nth) =>
      command === 'ReadLastAndTotalReceiptNum'
        ? DEVICE_ERROR_XML('Syntax error')
        : healthyDevice(ORDER_NUMBER)(command, nth)
    )
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: client })

    const outcome = await provider.printLastReceiptDuplicate(allow)

    expect(outcome).toMatchObject({ status: 'error', sent: false })
    expect(posted).not.toContain('InfoLastReceiptDuplicate')
  })

  it('reports a changed last number after the send and logs it as an error', async () => {
    const { client } = makeTransport(healthyDevice(ORDER_NUMBER, { lastAfter: LATER_NUMBER }))
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: client, logger })

    const outcome = await provider.printLastReceiptDuplicate(allow)

    expect(outcome).toEqual({ status: 'sent', deviceLastBefore: ORDER_NUMBER, deviceLastAfter: LATER_NUMBER })
    expect(logger.error).toHaveBeenCalledTimes(1)
  })

  it('refuses before any post when the device details are not set', async () => {
    const { client, posted } = makeTransport(healthyDevice(ORDER_NUMBER))
    const provider = new RealFiscalizationProvider({ httpClient: client })

    const outcome = await provider.printLastReceiptDuplicate(allow)

    expect(outcome).toMatchObject({ status: 'error', sent: false })
    expect(posted).toEqual([])
  })

  it('never writes the device password to any log line, even with debug logging on', async () => {
    const { client } = makeTransport(healthyDevice(ORDER_NUMBER))
    const lines: string[] = []
    const capture = (...args: unknown[]): void => {
      lines.push(args.map(String).join(' '))
    }
    const logger = { log: capture, warn: capture, error: capture, info: capture }
    vi.spyOn(console, 'log').mockImplementation(capture)
    vi.spyOn(console, 'info').mockImplementation(capture)
    vi.spyOn(console, 'warn').mockImplementation(capture)
    vi.spyOn(console, 'error').mockImplementation(capture)
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: client, logger, debugLogging: true })

    await provider.printLastReceiptDuplicate(allow)

    expect(lines.length).toBeGreaterThan(0)
    expect(lines.filter((line) => line.includes(PASSWORD))).toEqual([])
  })
})

function freshDb(): RubisDatabase {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  return db
}

const cartItem: CartItem = {
  id: 'gid://shopify/ProductVariant/201',
  productId: 'gid://shopify/Product/101',
  title: 'RUBIS Mug',
  variantTitle: 'Small',
  price: 60,
  quantity: 1,
  image: null
}

/** Seeds a manager and an order, filed as `invoiceNumber` unless `null` (left unfiled). */
function seed(db: RubisDatabase, invoiceNumber: string | null = ORDER_NUMBER): { staffId: number; localId: number } {
  const { staffId } = db.createStaff({ name: 'Mgr', pinHash: hashPin('1234'), role: 'admin' })
  const { localId } = db.queueOrder({
    items: [cartItem],
    total: 60,
    clientOrderUuid: `uuid-${invoiceNumber ?? 'unfiled'}`,
    staffId,
    staffName: 'Mgr',
    paymentMethod: 'cash',
    tenderedAmount: 60,
    changeDue: 0
  })
  if (invoiceNumber) {
    db.setOrderFiscalInfo(localId, invoiceNumber, 'qr', undefined, '2026-10-02T10:00:00.000Z', 'device', 'CU-1')
  }
  return { staffId, localId }
}

/** A provider whose device state is fixed; `outcome` overrides what the gate would decide. */
function stubProvider(
  state: Partial<DuplicatePrintDeviceState>,
  outcome?: DuplicatePrintOutcome
): FiscalizationProvider {
  return {
    submitInvoice: vi.fn(),
    getInvoiceDetails: vi.fn(),
    cancelInvoice: vi.fn(),
    printLastReceiptDuplicate: vi.fn(async (gate: DuplicatePrintGate): Promise<DuplicatePrintOutcome> => {
      if (outcome) return outcome
      const device = { deviceLastCuInvoiceNumber: ORDER_NUMBER, receiptOpen: false, queueHasInFlight: false, ...state }
      const verdict = gate(device)
      return verdict.allowed
        ? {
            status: 'sent',
            deviceLastBefore: device.deviceLastCuInvoiceNumber,
            deviceLastAfter: device.deviceLastCuInvoiceNumber
          }
        : { status: 'refused', reason: verdict.reason, deviceLastBefore: device.deviceLastCuInvoiceNumber }
    })
  }
}

/** Everything the service must never change: the order row and both queues. */
function snapshot(db: RubisDatabase, localId: number) {
  return {
    order: db.getOrder(localId),
    fiscalQueue: db.getPendingFiscalQueue(Number.MAX_SAFE_INTEGER),
    syncQueue: db.getPendingSyncQueue(Number.MAX_SAFE_INTEGER)
  }
}

describe('printFiscalDuplicate (the service behind fiscal:print-duplicate)', () => {
  it('sends for the order whose number is the device last, and records one sent row', async () => {
    const db = freshDb()
    const { staffId, localId } = seed(db)
    const provider = stubProvider({})
    const before = snapshot(db, localId)

    const result = await printFiscalDuplicate({ db, fiscalizationProvider: provider }, localId, staffId)

    expect(result).toEqual({ success: true, data: { issuedNewReceipt: false } })
    expect(provider.printLastReceiptDuplicate).toHaveBeenCalledTimes(1)
    const rows = db.listFiscalDuplicatePrints()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      order_id: localId,
      staff_id: staffId,
      device_last_cu_inv: ORDER_NUMBER,
      device_last_cu_inv_after: ORDER_NUMBER,
      result: 'sent',
      error: null
    })
    expect(snapshot(db, localId)).toEqual(before)
  })

  it('refuses an unfiled order without calling the device, and records one refused row', async () => {
    const db = freshDb()
    const { staffId, localId } = seed(db, null)
    const provider = stubProvider({})
    const before = snapshot(db, localId)

    const result = await printFiscalDuplicate({ db, fiscalizationProvider: provider }, localId, staffId)

    expect(result).toEqual({
      success: false,
      error: 'This sale has not been filed with KRA, so there is no receipt to copy.'
    })
    expect(provider.printLastReceiptDuplicate).not.toHaveBeenCalled()
    expect(db.listFiscalDuplicatePrints()).toHaveLength(1)
    expect(db.listFiscalDuplicatePrints()[0]).toMatchObject({ order_id: localId, result: 'refused' })
    expect(snapshot(db, localId)).toEqual(before)
  })

  it('refuses when the device last number differs, and records one refused row with that number', async () => {
    const db = freshDb()
    const { staffId, localId } = seed(db)
    const provider = stubProvider({ deviceLastCuInvoiceNumber: LATER_NUMBER })
    const before = snapshot(db, localId)

    const result = await printFiscalDuplicate({ db, fiscalizationProvider: provider }, localId, staffId)

    expect(result).toEqual({
      success: false,
      error:
        "The fiscal device's most recent receipt is a different one. Only the most recent receipt can be reprinted."
    })
    expect(db.listFiscalDuplicatePrints()).toHaveLength(1)
    expect(db.listFiscalDuplicatePrints()[0]).toMatchObject({
      result: 'refused',
      device_last_cu_inv: LATER_NUMBER,
      device_last_cu_inv_after: null
    })
    expect(snapshot(db, localId)).toEqual(before)
  })

  it('records one refused row for an order that does not exist', async () => {
    const db = freshDb()
    const { staffId } = seed(db)

    const result = await printFiscalDuplicate({ db, fiscalizationProvider: stubProvider({}) }, 9999, staffId)

    expect(result).toEqual({ success: false, error: 'Order 9999 not found' })
    expect(db.listFiscalDuplicatePrints()).toHaveLength(1)
    expect(db.listFiscalDuplicatePrints()[0]).toMatchObject({ order_id: 9999, result: 'refused' })
  })

  it('records one error row when the device fails', async () => {
    const db = freshDb()
    const { staffId, localId } = seed(db)
    const provider = stubProvider(
      {},
      { status: 'error', reason: 'Illegal command', deviceLastBefore: ORDER_NUMBER, sent: true }
    )

    const result = await printFiscalDuplicate({ db, fiscalizationProvider: provider }, localId, staffId)

    expect(result).toEqual({ success: false, error: 'Illegal command' })
    expect(db.listFiscalDuplicatePrints()).toHaveLength(1)
    expect(db.listFiscalDuplicatePrints()[0]).toMatchObject({ result: 'error', error: 'Illegal command' })
  })

  it('records one error row when the provider throws', async () => {
    const db = freshDb()
    const { staffId, localId } = seed(db)
    const provider = stubProvider({})
    vi.mocked(provider.printLastReceiptDuplicate).mockRejectedValue(new Error('socket exploded'))

    const result = await printFiscalDuplicate({ db, fiscalizationProvider: provider }, localId, staffId)

    expect(result).toEqual({ success: false, error: 'socket exploded' })
    expect(db.listFiscalDuplicatePrints()).toHaveLength(1)
    expect(db.listFiscalDuplicatePrints()[0].result).toBe('error')
  })

  it('flags a send after which the device last number changed', async () => {
    const db = freshDb()
    const { staffId, localId } = seed(db)
    const provider = stubProvider(
      {},
      { status: 'sent', deviceLastBefore: ORDER_NUMBER, deviceLastAfter: LATER_NUMBER }
    )

    const result = await printFiscalDuplicate({ db, fiscalizationProvider: provider }, localId, staffId)

    expect(result).toEqual({ success: true, data: { issuedNewReceipt: true } })
    expect(db.listFiscalDuplicatePrints()[0]).toMatchObject({ result: 'sent', device_last_cu_inv_after: LATER_NUMBER })
  })

  it('still reports a sent print as sent when the audit write fails', async () => {
    const db = freshDb()
    const { staffId, localId } = seed(db)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(db, 'recordFiscalDuplicatePrint').mockImplementation(() => {
      throw new Error('disk full')
    })

    const result = await printFiscalDuplicate({ db, fiscalizationProvider: stubProvider({}) }, localId, staffId)

    expect(result.success).toBe(true)
  })

  it('end to end through the real provider: one InfoLastReceiptDuplicate when numbers match, none when they differ', async () => {
    const db = freshDb()
    const { staffId, localId } = seed(db)

    const match = makeTransport(healthyDevice(ORDER_NUMBER))
    const sent = await printFiscalDuplicate(
      { db, fiscalizationProvider: new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: match.client }) },
      localId,
      staffId
    )
    const differ = makeTransport(healthyDevice(LATER_NUMBER))
    const refused = await printFiscalDuplicate(
      { db, fiscalizationProvider: new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient: differ.client }) },
      localId,
      staffId
    )

    expect(sent.success).toBe(true)
    expect(match.posted.filter((name) => name === 'InfoLastReceiptDuplicate')).toHaveLength(1)
    expect(refused.success).toBe(false)
    expect(differ.posted).not.toContain('InfoLastReceiptDuplicate')
    expect(db.listFiscalDuplicatePrints().map((row) => row.result)).toEqual(['sent', 'refused'])
  })
})

describe('MockFiscalizationProvider.printLastReceiptDuplicate', () => {
  const request = {
    clientOrderUuid: 'abcdef12-0000-0000-0000-000000000000',
    items: [{ description: 'Mug', quantity: 1, unitPrice: 60, taxRate: 0.16 }],
    total: 60,
    taxAmount: 9.6
  }

  it('logs "mock: duplicate print" and reports sent when the gate allows the last invoice it issued', async () => {
    const mock = new MockFiscalizationProvider(0)
    const issued = await mock.submitInvoice(request)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    const outcome = await mock.printLastReceiptDuplicate(allow)

    expect(issued.ok).toBe(true)
    expect(outcome.status).toBe('sent')
    expect(log).toHaveBeenCalledWith('mock: duplicate print')
  })

  it('refuses, and logs nothing, when the gate says no', async () => {
    const mock = new MockFiscalizationProvider(0)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    const outcome = await mock.printLastReceiptDuplicate(deny)

    expect(outcome.status).toBe('refused')
    expect(log).not.toHaveBeenCalled()
  })
})
