// @vitest-environment node
/**
 * End-to-end happy path: the REAL provider driving real wire against the
 * mock ZFPLabServer, over real HTTP on a real socket.
 *
 * Runs under the `node` environment, not the suite's default `jsdom`:
 * axios selects its XHR adapter under jsdom, which cannot reach a real
 * socket. Everything else in this file is the production code path.
 *
 * This is the validation tool the go-live work must keep working — it is
 * the only test that proves `RealFiscalizationProvider` can complete a
 * sale against a server speaking the captured wire fixtures, rather than
 * against a hand-stubbed axios client. The mock *provider* is not
 * involved and must never be: it short-circuits the wire entirely.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  createMockZfpLabServer,
  type MockZfpLabServerHandle
} from '../mock-zfplab-server/engine.js'
import { RealFiscalizationProvider } from '../src/main/services/integrations/real-etims-provider.js'
import type { FiscalInvoiceRequest } from '../src/main/services/integrations/etims.js'

/** `InvoiceNum` carried by `tests/fixtures/wire/closereceipt-ok.xml`. */
const FIXTURE_INVOICE_NUMBER = '0000000000000000042'

/** A single-line class-A sale, the shape checkout builds. */
const SALE: FiscalInvoiceRequest = {
  clientOrderUuid: '7f3c1a90-0000-4000-8000-000000000001',
  localId: 42,
  items: [
    {
      description: 'Bottled Water 500ml',
      quantity: 2,
      unitPrice: 60,
      taxRate: 0.16,
      vatClass: 'A',
      measureUnit: 'pcs',
      hsCode: '2201.10.00',
      hsName: 'Mineral waters'
    }
  ],
  total: 120,
  taxAmount: 16.55,
  paymentMethod: 'cash',
  amountTendered: 200
}

let server: MockZfpLabServerHandle

beforeAll(async () => {
  server = await createMockZfpLabServer({ port: 0 })
})

afterAll(async () => {
  await server.close()
})

describe('real provider against the mock ZFPLabServer', () => {
  it('fiscalizes a sale end-to-end over real HTTP', async () => {
    const provider = new RealFiscalizationProvider({
      baseUrl: server.baseUrl,
      deviceIp: '192.168.1.50',
      devicePort: '8000',
      password: 'test-device-password'
    })

    const outcome = await provider.submitInvoice(SALE)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data.invoiceNumber).toBe(FIXTURE_INVOICE_NUMBER)
    expect(outcome.data.qrCode).toMatch(/^MOCK-QR-/)
    expect(outcome.data.fiscalizedAt).toBeTruthy()
  })

  it('sends the documented command sequence, opening the session once', async () => {
    server.clearRequests()
    const provider = new RealFiscalizationProvider({
      baseUrl: server.baseUrl,
      deviceIp: '192.168.1.50',
      devicePort: '8000',
      password: 'test-device-password'
    })

    await provider.submitInvoice(SALE)
    await provider.submitInvoice({
      ...SALE,
      clientOrderUuid: '7f3c1a90-0000-4000-8000-000000000002',
      localId: 43
    })

    const settingsCalls = server.requests.filter((entry) => entry.pseudoCommand === 'settings')
    expect(settingsCalls).toHaveLength(1)

    const commands = server.requests
      .filter((entry) => entry.commandName !== undefined)
      .map((entry) => entry.commandName)
    expect(commands).toContain('OpenInvoiceWithFreeCustomerData')
    expect(commands).toContain('CloseReceipt')
  })

  it('never mints a synthetic invoice number of its own', async () => {
    const provider = new RealFiscalizationProvider({
      baseUrl: server.baseUrl,
      deviceIp: '192.168.1.50',
      devicePort: '8000',
      password: 'test-device-password'
    })

    const outcome = await provider.submitInvoice(SALE)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // The real provider only ever reports what the device returned.
    expect(outcome.data.invoiceNumber).not.toMatch(/MOCK/i)
  })
})
