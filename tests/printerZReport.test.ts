/**
 * Phase 228: the Z report prints on the receipt printer, found the way a receipt finds it; the status dot reports
 * that same printer; and a failed print names the printer it tried.
 *
 * Written fresh from the approach of the parked patch (C:\Users\paulc\parked\printer-z-registry-2026-10-05.patch).
 */

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildPrinterRegistry,
  checkReceiptPrinter,
  describePrinter,
  printReceiptToType,
  printTestPage,
  printWindowsTestPage,
  printZReport,
  printZReportToType,
  resolvePrinterSettings
} from '../src/main/services/printer.js'
import type { PrinterSettings, ReceiptOrder, ThermalPrinterLike } from '../src/main/services/printer.js'
import type { PrinterConfig } from '../src/main/services/database.js'
import type { ZReport } from '../src/main/services/reports.js'
import type { ConnectivityCheckResult } from '../src/main/services/connectivityMonitor.js'

function createFakePrinter(options?: { connected?: boolean; executeError?: unknown }) {
  const client: ThermalPrinterLike = {
    isPrinterConnected: vi.fn(async () => options?.connected ?? true),
    alignCenter: vi.fn(),
    alignLeft: vi.fn(),
    alignRight: vi.fn(),
    bold: vi.fn(),
    setTextNormal: vi.fn(),
    setTextQuadArea: vi.fn(),
    println: vi.fn(),
    drawLine: vi.fn(),
    cut: vi.fn(),
    execute: vi.fn(async () => {
      if (options?.executeError) throw options.executeError
      return undefined
    })
  }
  return client
}

/** The address the till was built with: what the Z report used to go to, whatever the printer list said. */
const DEFAULT_ADDRESS = 'tcp://192.168.0.100:9100'

const defaultSettings: PrinterSettings = { interfaceName: DEFAULT_ADDRESS, storeName: 'RUBIS', taxRate: 0.16 }

const networkReceiptPrinter: PrinterConfig = {
  id: 'till-1',
  type: 'receipt',
  interfaceName: 'tcp://192.168.1.50:9100',
  enabled: true
}

const windowsReceiptPrinter: PrinterConfig = {
  id: 'till-2',
  type: 'receipt',
  interfaceName: 'EPSON TM-T88V',
  enabled: true,
  connectionType: 'windows'
}

const report: ZReport = {
  shiftId: 1,
  staffName: 'Admin',
  openedAt: '2026-10-05T14:43:21.000Z',
  closedAt: '2026-10-05T14:43:36.000Z',
  status: 'closed',
  startingCash: 0,
  totalsByMethod: { cash: 0, mpesa: 0, card: 0 },
  mpesaByMode: { manual: 0, daraja: 0 },
  orderCount: 0,
  totalRevenue: 0,
  vatIncluded: 0,
  vatRate: 0.16,
  expectedCash: 0,
  endingCash: 3790,
  discrepancy: 3790
}

const order: ReceiptOrder = {
  localId: 7,
  createdAt: '2026-10-05T10:00:00.000Z',
  cashierName: 'Alex',
  paymentMethod: 'cash',
  tenderedAmount: 10,
  changeDue: 0,
  total: 10
}

describe('the Z report prints on the receipt printer (phase 228)', () => {
  it('goes to the registered network printer, never the default address', async () => {
    const factory = vi.fn((_interfaceName: string) => createFakePrinter())
    const registry = buildPrinterRegistry([networkReceiptPrinter])

    const result = await printZReportToType(report, registry, defaultSettings, 'receipt', factory)

    expect(result).toEqual({ success: true, data: { printed: true, mock: false } })
    expect(factory).toHaveBeenCalledTimes(1)
    expect(factory).toHaveBeenCalledWith('tcp://192.168.1.50:9100')
    expect(factory).not.toHaveBeenCalledWith(DEFAULT_ADDRESS)
  })

  it('goes to the registered Windows queue, sending the bytes there and never touching the network', async () => {
    const factory = vi.fn((_interfaceName: string) => createFakePrinter({ connected: false }))
    const windowsSender = vi.fn(async () => undefined)
    const registry = buildPrinterRegistry([windowsReceiptPrinter])

    const result = await printZReportToType(report, registry, defaultSettings, 'receipt', factory, windowsSender)

    expect(result).toEqual({ success: true, data: { printed: true, mock: false } })
    expect(windowsSender).toHaveBeenCalledWith('EPSON TM-T88V', expect.any(Buffer))
    expect(factory).not.toHaveBeenCalled()
  })

  it('falls back to the default settings exactly as a receipt does when the list has no receipt printer', async () => {
    const factory = vi.fn((_interfaceName: string) => createFakePrinter())

    await printZReportToType(report, buildPrinterRegistry([]), defaultSettings, 'receipt', factory)
    await printReceiptToType(order, [], buildPrinterRegistry([]), defaultSettings, 'receipt', factory)

    expect(factory.mock.calls.map((call) => call[0])).toEqual([DEFAULT_ADDRESS, DEFAULT_ADDRESS])
  })

  it('ignores a disabled receipt printer, as a receipt does', async () => {
    const factory = vi.fn((_interfaceName: string) => createFakePrinter())
    const registry = buildPrinterRegistry([{ ...networkReceiptPrinter, enabled: false }])

    await printZReportToType(report, registry, defaultSettings, 'receipt', factory)

    expect(factory).toHaveBeenCalledWith(DEFAULT_ADDRESS)
  })

  it('finds its printer by the same function a receipt does, and gets the same answer', () => {
    for (const config of [networkReceiptPrinter, windowsReceiptPrinter]) {
      const registry = buildPrinterRegistry([config])
      const found = resolvePrinterSettings(registry, 'receipt', defaultSettings)

      expect(found.interfaceName).toBe(config.interfaceName)
      expect(found.connectionType).toBe(config.connectionType)
    }
  })

  it('has no PDF fallback: an unreachable printer is a failure, and nothing is saved', async () => {
    const factory = vi.fn((_interfaceName: string) => createFakePrinter({ connected: false }))
    const registry = buildPrinterRegistry([networkReceiptPrinter])

    const result = await printZReportToType(report, registry, defaultSettings, 'receipt', factory)

    expect(result.success).toBe(false)
    expect(result.data).toBeUndefined()
  })

  it('is sent from the Z handler through the printer list, and from nowhere else', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8')

    expect(source).toContain('printZReportToType(report, printerRegistry, printerSettings)')
    expect(source).not.toMatch(/printZReport\(report, printerSettings\)/)
  })
})

describe('a failed print names the printer it tried', () => {
  it('names a network printer by its type and address when it is offline', async () => {
    const registry = buildPrinterRegistry([networkReceiptPrinter])

    const result = await printZReportToType(report, registry, defaultSettings, 'receipt', () =>
      createFakePrinter({ connected: false })
    )

    expect(result).toEqual({
      success: false,
      error: 'Printer "Receipt" (tcp://192.168.1.50:9100) is offline or unreachable. Check it is switched on and connected.'
    })
  })

  it('names the default printer by its address too', async () => {
    const result = await printZReport(report, defaultSettings, () => createFakePrinter({ connected: false }))

    expect(result.error).toBe(
      `Printer "Receipt" (${DEFAULT_ADDRESS}) is offline or unreachable. Check it is switched on and connected.`
    )
  })

  it('names a Windows queue by its name alone, with no address', async () => {
    const registry = buildPrinterRegistry([windowsReceiptPrinter])
    const windowsSender = vi.fn(async () => {
      throw new Error('spooler stopped')
    })

    const result = await printZReportToType(report, registry, defaultSettings, 'receipt', undefined, windowsSender)

    expect(result.success).toBe(false)
    expect(result.error).toBe('Printer "EPSON TM-T88V" error: spooler stopped')
    expect(result.error).not.toContain('tcp://')
  })

  it('names the printer for a refused connection, a timeout and a paper fault', async () => {
    const registry = buildPrinterRegistry([networkReceiptPrinter])
    const label = 'Printer "Receipt" (tcp://192.168.1.50:9100)'
    const failWith = (error: unknown) => () => createFakePrinter({ executeError: error })

    const refused = await printZReportToType(report, registry, defaultSettings, 'receipt', failWith(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })))
    const timedOut = await printZReportToType(report, registry, defaultSettings, 'receipt', failWith(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })))
    const paper = await printZReportToType(report, registry, defaultSettings, 'receipt', failWith(new Error('Out of paper')))

    expect(refused.error).toBe(`${label} is unreachable. Check the network connection and that it is switched on.`)
    expect(timedOut.error).toBe(`${label} connection timed out.`)
    expect(paper.error).toBe(`${label} reports a problem. Check the paper and try again.`)
  })

  it('names the printer on the Test button too, network and Windows', async () => {
    const offline = await printTestPage('tcp://192.168.1.77:9100', () => createFakePrinter({ connected: false }))
    const windows = await printWindowsTestPage('Back Office', 'RUBIS', async () => {
      throw new Error('no such queue')
    })

    expect(offline.error).toContain('(tcp://192.168.1.77:9100)')
    expect(windows.error).toContain('"Back Office"')
  })

  it('describes a printer in one place: a network printer by type and address, a Windows queue by name', () => {
    expect(describePrinter({ interfaceName: 'tcp://1.2.3.4:9100' })).toBe('Printer "Receipt" (tcp://1.2.3.4:9100)')
    expect(describePrinter({ interfaceName: 'tcp://1.2.3.4:9100', printerLabel: 'Kitchen' })).toBe('Printer "Kitchen" (tcp://1.2.3.4:9100)')
    expect(describePrinter({ interfaceName: 'EPSON', connectionType: 'windows' })).toBe('Printer "EPSON"')
  })

  it('says nothing technical beyond the name and the cause: no code, no stack', async () => {
    const registry = buildPrinterRegistry([networkReceiptPrinter])
    const error = Object.assign(new Error('connect ECONNREFUSED 192.168.1.50:9100'), { code: 'ECONNREFUSED' })

    const result = await printZReportToType(report, registry, defaultSettings, 'receipt', () => createFakePrinter({ executeError: error }))

    expect(result.error).not.toContain('ECONNREFUSED')
    expect(result.error).not.toMatch(/\n\s+at /)
  })
})

describe('the status dot reports the printer receipts use', () => {
  const tcpCheck = (connected: boolean) =>
    vi.fn(async (interfaceName: string): Promise<ConnectivityCheckResult> => ({
      connected,
      lastCheckedAt: '2026-10-05T16:00:00.000Z',
      ...(connected ? { latencyMs: 4 } : { error: `Timed out connecting to ${interfaceName}` })
    }))

  it('probes the registered network printer, never the default address', async () => {
    const check = tcpCheck(true)
    const registry = buildPrinterRegistry([networkReceiptPrinter])

    const result = await checkReceiptPrinter(registry, defaultSettings, check)

    expect(check).toHaveBeenCalledTimes(1)
    expect(check).toHaveBeenCalledWith('tcp://192.168.1.50:9100')
    expect(result.connected).toBe(true)
  })

  it('falls back to the default address exactly as a receipt does when the list is empty', async () => {
    const check = tcpCheck(false)

    const result = await checkReceiptPrinter(buildPrinterRegistry([]), defaultSettings, check)

    expect(check).toHaveBeenCalledWith(DEFAULT_ADDRESS)
    expect(result.connected).toBe(false)
  })

  it('never shows a Windows queue as connected: its status is unknown, and not probed', async () => {
    const check = tcpCheck(true)
    const registry = buildPrinterRegistry([windowsReceiptPrinter])

    const result = await checkReceiptPrinter(registry, defaultSettings, check)

    expect(check).not.toHaveBeenCalled()
    expect(result.connected).toBe(false)
    expect(result.notApplicable).toBe(true)
    expect(result.error).toContain('"EPSON TM-T88V"')
    expect(result.error).toContain('cannot be read')
  })

  it('reads a mock printer as connected, with nothing probed', async () => {
    const check = tcpCheck(false)

    const result = await checkReceiptPrinter(buildPrinterRegistry([networkReceiptPrinter]), { ...defaultSettings, mock: true }, check)

    expect(check).not.toHaveBeenCalled()
    expect(result.connected).toBe(true)
  })

  it('is what the connectivity monitor calls, with the live printer list', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8')

    expect(source).toContain('checkPrinter: () => checkReceiptPrinter(printerRegistry, printerSettings, checkTcpReachable)')
    expect(source).not.toContain('checkTcpReachable(printerSettings.interfaceName)')
  })
})
