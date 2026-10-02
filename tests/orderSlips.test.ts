/**
 * Printing a sale's slips as separate jobs (docs/phase-198): the fiscal-side
 * slip, cut, then the Enjoy customer slip, cut, each failing on its own with
 * no retry; the KRA line the customer slip carries; the mock provider's test
 * banner on the fiscal slip only.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  printOrderSlips,
  kraNoteFor,
  attachCustomerSlipResult,
  physicallyPrintedSlips,
  buildPrinterRegistry
} from '../src/main/services/printer.js'
import type {
  PrinterSettings,
  ReceiptLineItem,
  ReceiptOrder,
  ReceiptPrintResult,
  ThermalPrinterLike
} from '../src/main/services/printer.js'
import type { ServiceResult } from '../src/main/services/shopify-types.js'
import { MockFiscalizationProvider, MOCK_SLIP_BANNER } from '../src/main/services/integrations/mock-etims-provider.js'

interface Job {
  lines: string[]
  cuts: number
  quads: string[]
  /** True when the job's last call was the cut. */
  endsWithCut: boolean
}

/** A factory whose every client is one job; `fail` decides, per job number (1-based), how that job goes wrong. */
function recordingFactory(fail: (job: number) => 'offline' | 'error' | null = () => null) {
  const jobs: Job[] = []
  let connects = 0
  const factory = (): ThermalPrinterLike => {
    const number = jobs.length + 1
    const job: Job = { lines: [], cuts: 0, quads: [], endsWithCut: false }
    jobs.push(job)
    let quad = false
    const note = (): void => {
      job.endsWithCut = false
    }
    return {
      isPrinterConnected: async () => {
        connects++
        return fail(number) !== 'offline'
      },
      alignCenter: note,
      alignLeft: note,
      alignRight: note,
      bold: note,
      setTextNormal: () => {
        quad = false
        note()
      },
      setTextQuadArea: () => {
        quad = true
        note()
      },
      println: (text: string) => {
        job.lines.push(text)
        if (quad) job.quads.push(text)
        note()
      },
      drawLine: note,
      printQR: (text: string) => {
        job.lines.push(`[QR ${text}]`)
        note()
      },
      cut: () => {
        job.cuts++
        job.endsWithCut = true
      },
      execute: async () => {
        if (fail(number) === 'error') throw new Error('paper jam')
        return undefined
      }
    }
  }
  return { factory, jobs, connects: () => connects }
}

const SETTINGS: PrinterSettings = {
  interfaceName: 'tcp://192.168.0.100:9100',
  storeName: 'ENJOY',
  address: 'Waiyaki Way, Nairobi',
  locationName: 'Enjoy Westlands',
  taxRate: 0.16
}

const ITEMS: ReceiptLineItem[] = [{ title: 'RUBIS Mug', variantTitle: 'Small', quantity: 2, unitPrice: 60 }]

const FILED: ReceiptOrder = {
  localId: 42,
  createdAt: new Date(2026, 8, 27, 18, 58, 0).toISOString(),
  cashierName: 'Mary Wanjiku',
  paymentMethod: 'cash',
  tenderedAmount: 200,
  changeDue: 80,
  fiscalInvoiceNumber: '0123456789012345678',
  traderInvNum: 'INV-000000042',
  fiscalQrCode: 'https://itax.kra.go.ke/verify/abc123',
  fiscalizedAt: '27-09-2026 18:58:41',
  fiscalizedAtSource: 'device',
  cuSerial: 'KRAMW0XXXXXXXXXX',
  vatGroups: { A: '103.45' },
  total: 120
}

const PENDING: ReceiptOrder = {
  ...FILED,
  fiscalInvoiceNumber: undefined,
  fiscalQrCode: undefined,
  fiscalizedAt: undefined,
  cuSerial: undefined,
  vatGroups: undefined,
  fiscalPending: true
}

const BOTH = { fiscal: true, customer: true }
const registry = buildPrinterRegistry([])
const pdf = vi.fn(async () => 'C:/Users/x/Desktop/RUBIS_Receipt_Order_42.pdf')

const print = (order: ReceiptOrder, factory: () => ThermalPrinterLike, slips = BOTH, settings = SETTINGS) =>
  printOrderSlips(order, ITEMS, registry, settings, slips, 'receipt', factory, pdf)

describe('printOrderSlips', () => {
  it('prints the fiscal-side slip, cut, then the Enjoy slip, cut: two separate jobs, in that order', async () => {
    const { factory, jobs } = recordingFactory()

    const result = await print(FILED, factory)

    expect(result.fiscal?.success).toBe(true)
    expect(result.customer?.success).toBe(true)
    expect(jobs).toHaveLength(2)
    expect(jobs[0].lines).toContain('FISCAL RECEIPT')
    expect(jobs[1].lines[0]).toBe('E N J O Y')
    expect(jobs.map((j) => j.cuts)).toEqual([1, 1])
    expect(jobs.map((j) => j.endsWithCut)).toEqual([true, true])
  })

  it('puts the shop location and address under the Enjoy heading, and no fiscal numbers on it', async () => {
    const { factory, jobs } = recordingFactory()

    await print(FILED, factory)

    const customer = jobs[1].lines.join('\n')
    expect(customer).toContain('Enjoy Westlands')
    expect(customer).toContain('Waiyaki Way, Nairobi')
    expect(customer).toContain('Receipt INV-000000042')
    expect(customer).not.toContain(FILED.fiscalInvoiceNumber as string)
    expect(customer).not.toContain(FILED.cuSerial as string)
    expect(customer).not.toContain('[QR')
    expect(jobs[0].lines.join('\n')).toContain(FILED.fiscalInvoiceNumber as string)
  })

  it('still prints the customer slip when the fiscal slip fails, and does not retry either', async () => {
    const { factory, jobs, connects } = recordingFactory((job) => (job === 1 ? 'error' : null))

    const result = await print(FILED, factory)

    expect(result.fiscal?.success).toBe(false)
    expect(result.customer?.success).toBe(true)
    expect(jobs).toHaveLength(2)
    expect(connects()).toBe(2)
  })

  it('reports a failed customer slip without touching the fiscal slip, and does not retry', async () => {
    const { factory, jobs, connects } = recordingFactory((job) => (job === 2 ? 'error' : null))

    const result = await print(FILED, factory)

    expect(result.fiscal?.success).toBe(true)
    expect(result.customer?.success).toBe(false)
    expect(jobs).toHaveLength(2)
    expect(connects()).toBe(2)
  })

  it('falls back to a PDF for the fiscal slip when the printer is out, and the customer slip fails on its own', async () => {
    const { factory } = recordingFactory(() => 'offline')

    const result = await print(FILED, factory)

    expect(result.fiscal?.success && result.fiscal.data?.mode).toBe('pdf')
    expect(result.customer?.success).toBe(false)
  })

  it('prints only the fiscal slip, or only the customer slip, when only one is asked for', async () => {
    const fiscalOnly = recordingFactory()
    const customerOnly = recordingFactory()

    const a = await print(FILED, fiscalOnly.factory, { fiscal: true, customer: false })
    const b = await print(FILED, customerOnly.factory, { fiscal: false, customer: true })

    expect(a.customer).toBeNull()
    expect(fiscalOnly.jobs).toHaveLength(1)
    expect(b.fiscal).toBeNull()
    expect(customerOnly.jobs).toHaveLength(1)
    expect(customerOnly.jobs[0].lines[0]).toBe('E N J O Y')
  })

  it('sends the two slips to a Windows queue as two separate jobs', async () => {
    const sender = vi.fn(async () => undefined)
    const windows: PrinterSettings = { ...SETTINGS, connectionType: 'windows', interfaceName: 'POS-80' }

    await printOrderSlips(FILED, ITEMS, registry, windows, BOTH, 'receipt', undefined, pdf, sender)

    expect(sender).toHaveBeenCalledTimes(2)
    expect(sender.mock.calls.map((call) => (call as unknown[])[0])).toEqual(['POS-80', 'POS-80'])
  })

  it('stamps both slips DUPLICATE on a reprint, each by its own flag', async () => {
    const { factory, jobs } = recordingFactory()

    await print({ ...FILED, isDuplicate: true, customerSlipIsDuplicate: true }, factory)

    expect(jobs[0].lines[0]).toBe('*** DUPLICATE ***')
    expect(jobs[1].lines[0]).toBe('*** DUPLICATE ***')
  })

  it('stamps the customer slip on a manual reprint of a sale whose fiscal slip was never on paper', async () => {
    const { factory, jobs } = recordingFactory()

    await print({ ...PENDING, isDuplicate: false, customerSlipIsDuplicate: true }, factory)

    expect(jobs[0].lines).toContain('SALE RECORD')
    expect(jobs[0].lines.some((l) => l.includes('DUPLICATE'))).toBe(false)
    expect(jobs[1].lines[0]).toBe('*** DUPLICATE ***')
  })
})

describe('the KRA line on the customer slip follows what happened', () => {
  const ok: ServiceResult<ReceiptPrintResult> = { success: true, data: { printed: true, mock: false } }
  const viaPdf: ServiceResult<ReceiptPrintResult> = { success: true, data: { printed: false, mock: false, mode: 'pdf' } }
  const failed: ServiceResult<ReceiptPrintResult> = { success: false, error: 'Printer error' }

  it.each([
    ['filed, fiscal slip on paper', FILED, ok, 'printed'],
    ['filed, fiscal slip only a PDF', FILED, viaPdf, 'none'],
    ['filed, fiscal slip failed', FILED, failed, 'none'],
    ['filed, fiscal slip not printed in this call', FILED, null, 'none'],
    ['not filed, on the real provider', PENDING, ok, 'pending'],
    ['not filed, not the real provider', { ...PENDING, fiscalPending: false }, ok, 'none']
  ] as const)('%s: %s', (_name, order, fiscal, expected) => {
    expect(kraNoteFor(order, fiscal)).toBe(expected)
  })

  it('prints "printed separately" only when the fiscal slip reached paper', async () => {
    const good = recordingFactory()
    const bad = recordingFactory((job) => (job === 1 ? 'error' : null))

    await print(FILED, good.factory)
    await print(FILED, bad.factory)

    expect(good.jobs[1].lines).toContain('Your KRA tax invoice is printed separately.')
    expect(bad.jobs[1].lines).not.toContain('Your KRA tax invoice is printed separately.')
  })

  it('prints "will follow" for a sale not yet filed', async () => {
    const { factory, jobs } = recordingFactory()

    await print(PENDING, factory)

    expect(jobs[1].lines).toContain('Your KRA tax invoice will follow.')
    expect(jobs[1].lines).toContain('Please keep this receipt.')
  })
})

describe('attachCustomerSlipResult and physicallyPrintedSlips', () => {
  const ok: ServiceResult<ReceiptPrintResult> = { success: true, data: { printed: true, mock: false } }
  const viaPdf: ServiceResult<ReceiptPrintResult> = { success: true, data: { printed: false, mock: false, mode: 'pdf' } }
  const failed: ServiceResult<ReceiptPrintResult> = { success: false, error: 'Printer error' }

  it('marks the customer slip printed or failed on a successful fiscal result', () => {
    expect(attachCustomerSlipResult(ok, ok)).toMatchObject({ success: true, data: { customerSlip: 'printed' } })
    expect(attachCustomerSlipResult(ok, failed)).toMatchObject({
      success: true,
      data: { customerSlip: 'failed', customerSlipError: 'Printer error' }
    })
  })

  it('leaves the result alone when there is no customer slip, and returns a failed fiscal result as it is', () => {
    expect(attachCustomerSlipResult(ok, null)).toBe(ok)
    expect(attachCustomerSlipResult(failed, ok)).toBe(failed)
  })

  it('counts only a slip that reached paper', () => {
    expect(physicallyPrintedSlips({ fiscal: ok, customer: ok })).toEqual(['fiscal', 'enjoy'])
    expect(physicallyPrintedSlips({ fiscal: viaPdf, customer: failed })).toEqual([])
    expect(physicallyPrintedSlips({ fiscal: failed, customer: ok })).toEqual(['enjoy'])
    expect(physicallyPrintedSlips({ fiscal: ok, customer: null })).toEqual(['fiscal'])
  })
})

describe('the mock provider marks its fiscal slip as a test', () => {
  const mock = new MockFiscalizationProvider(0)
  const banner = (width: 48 | 42 | 32): SettingsWithDecorator => ({
    ...SETTINGS,
    width,
    decorateFiscalSlip: (entries, options) => mock.decorateFiscalSlip(entries, options)
  })
  type SettingsWithDecorator = PrinterSettings

  it('puts asterisks, the banner in double width on one line, and asterisks at the top and the bottom', async () => {
    const { factory, jobs } = recordingFactory()

    await print(FILED, factory, { fiscal: true, customer: false }, banner(48))

    const lines = jobs[0].lines
    const stars = '*'.repeat(48)
    expect(lines.slice(0, 3)).toEqual([stars, MOCK_SLIP_BANNER, stars])
    expect(lines.slice(-3)).toEqual([stars, MOCK_SLIP_BANNER, stars])
    expect(jobs[0].quads.filter((l) => l === MOCK_SLIP_BANNER)).toHaveLength(2)
    expect(MOCK_SLIP_BANNER.length * 2).toBeLessThanOrEqual(48)
  })

  it.each([42, 32] as const)('prints the banner bold on one line when double width would not fit (%d characters)', async (width) => {
    const { factory, jobs } = recordingFactory()

    await print(FILED, factory, { fiscal: true, customer: false }, banner(width))

    expect(jobs[0].lines.filter((l) => l === MOCK_SLIP_BANNER)).toHaveLength(2)
    expect(jobs[0].quads).not.toContain(MOCK_SLIP_BANNER)
  })

  it('is not on the Enjoy slip', async () => {
    const { factory, jobs } = recordingFactory()

    await print(FILED, factory, BOTH, banner(48))

    expect(jobs[1].lines.join('\n')).not.toContain(MOCK_SLIP_BANNER)
    expect(jobs[1].lines.some((l) => l.startsWith('*'))).toBe(false)
  })

  it('is on a not-yet-filed slip too, and never on a slip printed without the decorator', async () => {
    const marked = recordingFactory()
    const plain = recordingFactory()

    await print(PENDING, marked.factory, { fiscal: true, customer: false }, banner(48))
    await print(FILED, plain.factory, { fiscal: true, customer: false })

    expect(marked.jobs[0].lines[1]).toBe(MOCK_SLIP_BANNER)
    expect(plain.jobs[0].lines.join('\n')).not.toContain(MOCK_SLIP_BANNER)
  })

  it('gives the mock sale a serial number for the slip to show', async () => {
    const outcome = await mock.submitInvoice({
      clientOrderUuid: '11111111-2222-3333-4444-555555555555',
      items: [{ description: 'Bread', quantity: 1, unitPrice: 60, taxRate: 0.16 }],
      total: 60,
      taxAmount: 8.28
    } as never)

    expect(outcome.ok && outcome.data.cuSerialNumber).toBeTruthy()
  })
})
