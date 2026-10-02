/**
 * Shared harness for the phase-194 VAT class tests: a real
 * `RealFiscalizationProvider` over a recording mock HTTP client, and the
 * three class-A sales whose wire traffic was captured before the change
 * (`tests/fixtures/vat-class-a-golden.json`).
 */

import type { AxiosInstance } from 'axios'
import { RealFiscalizationProvider } from '../../src/main/services/integrations/real-etims-provider.js'
import { RubisDatabase } from '../../src/main/services/database.js'
import { hashPin } from '../../src/main/services/auth.js'
import { runCheckout } from '../../src/main/services/checkout.js'
import type { CheckoutRequest } from '../../src/main/services/database.js'
import type { RunCheckoutDeps } from '../../src/main/services/checkout.js'

export const commandName = (body: string): string => /<Command Name="([^"]+)"/.exec(body)?.[1] ?? ''

const xmlRes = (fields: Record<string, string> = {}): string =>
  `<Res Code="0">${Object.entries(fields)
    .map(([key, value]) => `<${key}>${value}</${key}>`)
    .join('')}</Res>`

/** What `ReadCurrentReceiptInfo` answers: the five group subtotal strings. */
export type DeviceGroups = Partial<Record<'A' | 'B' | 'C' | 'D' | 'E', string>>

export interface RecordingProvider {
  provider: RealFiscalizationProvider
  /** Every posted body, in order. */
  sent: string[]
  /** Posted command names, in order. */
  commands: () => string[]
}

/**
 * @param {DeviceGroups} groups what the device reports for the receipt's groups
 * @returns {RecordingProvider}
 */
export function makeRecordingProvider(groups: DeviceGroups): RecordingProvider {
  const sent: string[] = []
  const post = async (_path: string, body: string): Promise<{ data: string }> => {
    sent.push(body)
    switch (commandName(body)) {
      case 'ReadStatus':
        return { data: xmlRes({ CU_fiscalized: '1', Paired_with_TIMS: '1' }) }
      case 'ReadCurrentReceiptInfo':
        return {
          data: xmlRes({
            OptionIsReceiptOpened: '1',
            SalesNumber: '1',
            ...Object.fromEntries(
              Object.entries(groups).map(([letter, amount]) => [`SubtotalAmountVATG${letter}`, amount as string])
            )
          })
        }
      case 'CloseReceipt':
        return { data: xmlRes({ InvoiceNum: 'KRA-1', QRcode: 'q' }) }
      case 'ReadDateTime':
        return { data: xmlRes({ DateTime: '01-01-2026 09:30' }) }
      case 'ReadCUnumbers':
        return { data: xmlRes({ SerialNumber: 'S', PINnumber: 'P' }) }
      default:
        return { data: xmlRes() }
    }
  }
  const get = async (): Promise<{ data: string }> => ({
    data: '<Res Code="0"><settings><defVer></defVer></settings></Res>'
  })
  const client = { post, get, defaults: { baseURL: 'http://localhost:4444/' } } as unknown as AxiosInstance
  const provider = new RealFiscalizationProvider({
    deviceIp: '1.2.3.4',
    devicePort: '8000',
    password: 'x',
    httpClient: client
  })
  return { provider, sent, commands: () => sent.map(commandName) }
}

export interface GoldenSale {
  name: string
  total: number
  items: CheckoutRequest['items']
  extra?: Partial<CheckoutRequest>
}

/** The sales `golden194.ts` filed on the pre-change build. */
export const GOLDEN_SALES: GoldenSale[] = [
  {
    name: 'one-ksh',
    total: 1,
    items: [
      { id: 'gid://shopify/ProductVariant/2', productId: 'gid://shopify/Product/1', title: 'Maize', variantTitle: 'D', price: 1, quantity: 1, image: null }
    ]
  },
  {
    name: 'two-lines',
    total: 530.5,
    items: [
      { id: 'gid://shopify/ProductVariant/3', productId: 'gid://shopify/Product/2', title: 'Café Latte (500ml)', variantTitle: 'Default Title', price: 150, quantity: 3, image: null },
      { id: 'gid://shopify/ProductVariant/4', productId: 'gid://shopify/Product/3', title: 'Bread', variantTitle: 'Small', price: 80.5, quantity: 1, image: null }
    ]
  },
  {
    name: 'buyer-pin',
    total: 99.99,
    extra: { customerPin: 'P051234567Z', companyName: 'Acme Ltd' },
    items: [
      { id: 'gid://shopify/ProductVariant/5', productId: 'gid://shopify/Product/4', title: 'Mug', variantTitle: 'Large', price: 33.33, quantity: 3, image: null }
    ]
  }
]

export interface CheckoutHarness {
  db: RubisDatabase
  staffId: number
  deps: RunCheckoutDeps
  rec: RecordingProvider
}

/**
 * A real in-memory database and `runCheckout` dependencies around a
 * recording provider.
 *
 * @param {DeviceGroups} groups
 * @returns {CheckoutHarness}
 */
export function makeCheckoutHarness(groups: DeviceGroups): CheckoutHarness {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  const { staffId } = db.createStaff({ name: 'A', pinHash: hashPin('1234'), role: 'cashier' })
  const rec = makeRecordingProvider(groups)
  const deps = {
    db,
    mpesaProvider: { verifyTransactionCode: async () => ({ success: true }) },
    fiscalizationProvider: rec.provider,
    fiscalEngine: { onCheckoutMade() {}, claim() {}, release() {} },
    monitor: { isOnline: () => false },
    engineTick: async () => {},
    idGen: () => 'uuid-golden-1',
    taxRate: 0.16,
    verifyReferenceNumbers: false,
    claimsStoredPayments: false,
    logger: { log() {}, warn() {}, error() {} },
    debugLogging: false
  } as unknown as RunCheckoutDeps
  return { db, staffId, deps, rec }
}

/**
 * Runs one cash sale through `runCheckout`.
 *
 * @param {CheckoutHarness} harness
 * @param {CheckoutRequest['items']} items
 * @param {number} total
 * @param {Partial<CheckoutRequest>} [extra]
 */
export async function sellCash(
  harness: CheckoutHarness,
  items: CheckoutRequest['items'],
  total: number,
  extra: Partial<CheckoutRequest> = {}
): ReturnType<typeof runCheckout> {
  return runCheckout(harness.deps, {
    items,
    total,
    staffId: harness.staffId,
    paymentMethod: 'cash',
    tenderedAmount: total,
    changeDue: 0,
    ...extra
  })
}
