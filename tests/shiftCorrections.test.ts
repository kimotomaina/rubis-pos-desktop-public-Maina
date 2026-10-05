/**
 * Corrections of a closed shift's typed-in figures (docs/phase-224): an append-only table, the arithmetic, the
 * refusals, the Z report that shows original and correction together, the request schema, and the screens.
 *
 * `better-sqlite3` is mocked with a recording fake, as in `tests/shifts.test.ts`; the triggers that make the table
 * append-only are SQLite's own and were checked against a real database (see docs/phase-224.md).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import BetterSqlite3 from 'better-sqlite3'
import { RubisDatabase } from '../src/main/services/database.js'
import type { OrderRow, ShiftCorrectionRow, ShiftRow, StaffRow } from '../src/main/services/database.js'
import { sameEnteredFigures, workShiftFigures } from '../src/main/lib/shiftFigures.js'
import { generateZReport } from '../src/main/services/reports.js'
import type { ZReport } from '../src/main/services/reports.js'
import { renderZReport } from '../src/main/services/printer.js'
import type { PrinterSettings, ThermalPrinterLike } from '../src/main/services/printer.js'
import { shiftCorrectionSchema } from '../src/main/lib/ipcValidator.js'
import { zReportCorrectionBlocks } from '../src/main/lib/zReportCorrections.js'
import { zReportCorrectionBlocks as rendererBlocks } from '../src/renderer/src/lib/zReportCorrections.js'
import ZReportModal from '../src/renderer/src/components/ZReportModal.js'
import { useKeyboardStore } from '../src/renderer/src/stores/keyboardStore.js'

vi.mock('better-sqlite3', () => ({ default: vi.fn() }))
vi.mock('../src/renderer/src/components/ManagerPinModal.js', () => ({
  default: ({ onAuthorized, onCancel }: { onAuthorized: (id: number, pin: string) => void; onCancel: () => void }) =>
    createElement(
      'div',
      { 'data-testid': 'pin' },
      createElement('button', { onClick: () => onAuthorized(2, '1234') }, 'Authorize as manager'),
      createElement('button', { onClick: onCancel }, 'Cancel PIN')
    )
}))

const MockedDatabaseCtor = vi.mocked(BetterSqlite3)

interface RecordedCall {
  sql: string
  kind: 'run' | 'get' | 'all'
  params: unknown[]
}

function createFakeConnection() {
  const calls: RecordedCall[] = []
  const allResults = new Map<string, unknown[]>()
  const getResults = new Map<string, unknown[]>()
  const runResults = new Map<string, Array<{ lastInsertRowid: number; changes: number }>>()
  const find = <T>(store: Map<string, T>, sql: string): T | undefined => {
    for (const [match, value] of store) if (sql.includes(match)) return value
    return undefined
  }
  const connection = {
    pragma: vi.fn(),
    exec: vi.fn(),
    close: vi.fn(),
    transaction: vi.fn((fn: (...args: unknown[]) => unknown) => {
      const run = (...args: unknown[]): unknown => fn(...args)
      return Object.assign(run, { immediate: run })
    }),
    prepare: vi.fn((sql: string) => ({
      run: (...params: unknown[]) => {
        calls.push({ sql, kind: 'run', params })
        const queued = find(runResults, sql)
        if (queued && queued.length > 0) return queued.shift()
        return { changes: 1, lastInsertRowid: 0 }
      },
      get: (...params: unknown[]) => {
        calls.push({ sql, kind: 'get', params })
        const queued = find(getResults, sql)
        if (queued && queued.length > 0) return queued.shift()
        // ADDED (docs/phase-231): a record's time is after the shift's newest record; an aggregate always answers one row.
        if (sql.includes('MAX(at)')) return { latest: null }
        return undefined
      },
      all: (...params: unknown[]) => {
        calls.push({ sql, kind: 'all', params })
        return find(allResults, sql) ?? []
      }
    }))
  }
  return {
    connection,
    setAllResult: (match: string, rows: unknown[]) => allResults.set(match, rows),
    queueGetResult: (match: string, row: unknown) => {
      const list = getResults.get(match) ?? []
      list.push(row)
      getResults.set(match, list)
    },
    queueRunResult: (match: string, outcome: Partial<{ lastInsertRowid: number; changes: number }>) => {
      const list = runResults.get(match) ?? []
      list.push({ lastInsertRowid: 0, changes: 1, ...outcome })
      runResults.set(match, list)
    },
    callsFor: (kind: RecordedCall['kind'], match: string) =>
      calls.filter((c) => c.kind === kind && c.sql.includes(match))
  }
}

const freshDb = () => {
  const fake = createFakeConnection()
  MockedDatabaseCtor.mockImplementation(() => fake.connection as unknown as InstanceType<typeof BetterSqlite3>)
  const db = new RubisDatabase({ dbPath: '/tmp/rubis-test.db' })
  db.init()
  return { fake, db }
}

const NOW = Date.parse('2026-10-06T09:00:00.000Z')

const closedShift: ShiftRow = {
  id: 1,
  staff_id: 1,
  clock_in: '2026-10-05T06:00:00.000Z',
  clock_out: '2026-10-05T14:00:00.000Z',
  starting_cash: 1000,
  expected_cash: 1500,
  ending_cash: 1480,
  discrepancy: -20,
  status: 'closed',
  mpesa_opening_balance: 1000,
  mpesa_closing_balance: 1280,
  mpesa_expected: 1500,
  mpesa_difference: -220
}

const order = (total: number, method: 'cash' | 'mpesa' | 'card', status = 'synced'): OrderRow =>
  ({ local_id: 1, total, status, payment_method: method, shift_id: 1, created_at: '2026-10-05T07:00:00.000Z' }) as unknown as OrderRow

const correctionRow = (overrides: Partial<ShiftCorrectionRow> = {}): ShiftCorrectionRow => ({
  id: 1,
  shift_id: 1,
  corrected_by_staff_id: 2,
  corrected_at: '2026-10-06T08:00:00.000Z',
  reason: 'Counted cash was mistyped',
  starting_cash: 1000,
  ending_cash: 1500,
  expected_cash: 1500,
  discrepancy: 0,
  mpesa_opening_balance: 1000,
  mpesa_closing_balance: 1500,
  mpesa_expected: 1500,
  mpesa_difference: 0,
  ...overrides
})

const input = (overrides: Record<string, unknown> = {}) => ({
  shiftId: 1,
  managerId: 2,
  reason: 'Counted cash was mistyped',
  startingCash: 1000,
  endingCash: 1500,
  mpesaOpeningBalance: 1000 as number | null,
  mpesaClosingBalance: 1500 as number | null,
  ...overrides
})

/** A database holding the closed shift above, with cash 500, M-Pesa 300 + 200 and a voided M-Pesa 999. */
function dbWith(shift: ShiftRow | null = closedShift, corrections: ShiftCorrectionRow[] = []) {
  const { fake, db } = freshDb()
  if (shift) fake.queueGetResult('FROM shifts WHERE id', shift)
  fake.setAllResult('FROM shift_corrections WHERE shift_id', corrections)
  fake.setAllResult('FROM orders WHERE shift_id', [
    order(500, 'cash'),
    order(300, 'mpesa'),
    order(200, 'mpesa'),
    order(999, 'mpesa', 'voided'),
    order(75, 'card')
  ])
  fake.queueRunResult('INSERT INTO shift_corrections', { lastInsertRowid: 7 })
  return { fake, db }
}

describe('workShiftFigures', () => {
  const entered = { startingCash: 1000, endingCash: 1480, mpesaOpeningBalance: 1000, mpesaClosingBalance: 1280 }

  it('works expected and difference out as a close does', () => {
    expect(workShiftFigures(entered, 500, 500)).toEqual({
      expectedCash: 1500,
      discrepancy: -20,
      mpesaExpected: 1500,
      mpesaDifference: -220
    })
  })

  it('keeps M-Pesa expected and difference only when both balances were given', () => {
    expect(workShiftFigures({ ...entered, mpesaClosingBalance: null }, 500, 500)).toMatchObject({
      mpesaExpected: null,
      mpesaDifference: null
    })
    expect(workShiftFigures({ ...entered, mpesaOpeningBalance: null }, 500, 500)).toMatchObject({
      mpesaExpected: null,
      mpesaDifference: null
    })
  })

  it('tells a changed figure from an unchanged one, and a 0 from "not recorded"', () => {
    expect(sameEnteredFigures(entered, { ...entered })).toBe(true)
    expect(sameEnteredFigures(entered, { ...entered, endingCash: 1481 })).toBe(false)
    expect(sameEnteredFigures(entered, { ...entered, mpesaClosingBalance: null })).toBe(false)
    expect(sameEnteredFigures({ ...entered, mpesaClosingBalance: 0 }, { ...entered, mpesaClosingBalance: null })).toBe(false)
  })
})

describe('the shift_corrections table', () => {
  it('is created at start-up with an index and two triggers that refuse UPDATE and DELETE', () => {
    const { fake } = freshDb()
    const sql = fake.connection.exec.mock.calls.map((c) => String(c[0]))

    expect(sql.some((s) => s.includes('CREATE TABLE IF NOT EXISTS shift_corrections'))).toBe(true)
    expect(sql.some((s) => s.includes('idx_shift_corrections_shift'))).toBe(true)
    const triggers = sql.filter((s) => s.includes('CREATE TRIGGER IF NOT EXISTS shift_corrections_'))
    expect(triggers).toHaveLength(2)
    expect(triggers.some((s) => s.includes('BEFORE UPDATE ON shift_corrections') && s.includes('RAISE(ABORT'))).toBe(true)
    expect(triggers.some((s) => s.includes('BEFORE DELETE ON shift_corrections') && s.includes('RAISE(ABORT'))).toBe(true)
  })
})

describe('addShiftCorrection', () => {
  it('appends one row with the figures, who, when and why, and the expected and difference worked out now', () => {
    const { fake, db } = dbWith()

    const row = db.addShiftCorrection(input(), NOW)

    // cash: 1000 + 500 = 1500, counted 1500: 0. M-Pesa: 1000 + 300 + 200 (the voided 999 and card do not count).
    expect(row).toEqual({
      id: 7,
      shift_id: 1,
      corrected_by_staff_id: 2,
      corrected_at: new Date(NOW).toISOString(),
      reason: 'Counted cash was mistyped',
      starting_cash: 1000,
      ending_cash: 1500,
      expected_cash: 1500,
      discrepancy: 0,
      mpesa_opening_balance: 1000,
      mpesa_closing_balance: 1500,
      mpesa_expected: 1500,
      mpesa_difference: 0
    })
    const [insert] = fake.callsFor('run', 'INSERT INTO shift_corrections')
    expect(insert.params).toEqual([1, 2, new Date(NOW).toISOString(), 'Counted cash was mistyped', 1000, 1500, 1500, 0, 1000, 1500, 1500, 0])
  })

  it('never touches the shift, any sale, or the sync queue: the one write is the new row', () => {
    const { fake, db } = dbWith()
    const before = fake.callsFor('run', '').length

    db.addShiftCorrection(input(), NOW)

    const written = fake.callsFor('run', '').slice(before)
    expect(written).toHaveLength(1)
    expect(written[0].sql).toContain('INSERT INTO shift_corrections')
  })

  it('keeps an M-Pesa balance that was never recorded as not recorded, and a typed 0 as 0', () => {
    const { db } = dbWith()
    const blank = db.addShiftCorrection(input({ mpesaOpeningBalance: null, mpesaClosingBalance: null }), NOW)
    expect(blank).toMatchObject({ mpesa_opening_balance: null, mpesa_closing_balance: null, mpesa_expected: null, mpesa_difference: null })

    const { db: other } = dbWith()
    const zero = other.addShiftCorrection(input({ mpesaClosingBalance: 0 }), NOW)
    expect(zero.mpesa_closing_balance).toBe(0)
    expect(zero.mpesa_difference).toBe(-1500)
  })

  it('compares with the shift\'s own figures the first time, and with the last correction after that', () => {
    const { fake, db } = dbWith(closedShift, [])
    // Same as the shift's own (counted 1480, M-Pesa 1280): nothing to correct.
    expect(() =>
      db.addShiftCorrection(input({ endingCash: 1480, mpesaClosingBalance: 1280 }), NOW)
    ).toThrow('Nothing has changed from the current figures')
    expect(fake.callsFor('run', 'INSERT INTO shift_corrections')).toHaveLength(0)

    // After a correction to 1500, 1480 is a change back; 1500 again is not.
    const latest = correctionRow()
    const { db: next } = dbWith(closedShift, [latest])
    expect(() => next.addShiftCorrection(input(), NOW)).toThrow('Nothing has changed from the current figures')
    const { db: back } = dbWith(closedShift, [latest])
    expect(back.addShiftCorrection(input({ endingCash: 1480 }), NOW).ending_cash).toBe(1480)
  })

  it('refuses a missing shift, an open shift, a blank reason and a bad figure, writing nothing', () => {
    const cases: Array<[() => unknown, RegExp]> = [
      [() => dbWith(null).db.addShiftCorrection(input(), NOW), /Shift 1 not found/],
      [() => dbWith({ ...closedShift, status: 'open', clock_out: null }).db.addShiftCorrection(input(), NOW), /still open/],
      [() => dbWith().db.addShiftCorrection(input({ reason: '   ' }), NOW), /reason is required/],
      [() => dbWith().db.addShiftCorrection(input({ endingCash: -1 }), NOW), /0 or more/],
      [() => dbWith().db.addShiftCorrection(input({ startingCash: Number.NaN }), NOW), /0 or more/],
      [() => dbWith().db.addShiftCorrection(input({ mpesaClosingBalance: Number.POSITIVE_INFINITY }), NOW), /0 or more/]
    ]
    for (const [run, message] of cases) {
      expect(run).toThrow(message)
    }
  })

  it('is one write transaction, so two managers cannot both correct the same current figures', () => {
    const { fake, db } = dbWith()
    db.addShiftCorrection(input(), NOW)

    expect(fake.connection.transaction).toHaveBeenCalled()
  })

  it('lists a shift\'s corrections oldest first', () => {
    const { fake, db } = dbWith()
    db.listShiftCorrections(1)

    const [call] = fake.callsFor('all', 'FROM shift_corrections WHERE shift_id')
    expect(call.sql).toContain('ORDER BY id ASC')
    expect(call.params).toEqual([1])
  })
})

describe('the request schema', () => {
  const valid = {
    managerId: 2,
    managerPin: '1234',
    shiftId: 1,
    startingCash: 1000,
    endingCash: 1500,
    mpesaOpeningBalance: null,
    mpesaClosingBalance: 1500,
    reason: 'Counted cash was mistyped'
  }

  it('accepts a complete request, null M-Pesa balances included', () => {
    expect(shiftCorrectionSchema.safeParse(valid).success).toBe(true)
  })

  it('requires the manager, the shift, every figure (null for M-Pesa) and a reason', () => {
    for (const missing of ['managerId', 'managerPin', 'shiftId', 'startingCash', 'endingCash', 'mpesaOpeningBalance', 'mpesaClosingBalance', 'reason']) {
      const { [missing]: _removed, ...rest } = valid as Record<string, unknown>
      expect(shiftCorrectionSchema.safeParse(rest).success).toBe(false)
    }
    expect(shiftCorrectionSchema.safeParse({ ...valid, reason: '  ' }).success).toBe(false)
    expect(shiftCorrectionSchema.safeParse({ ...valid, endingCash: -1 }).success).toBe(false)
    expect(shiftCorrectionSchema.safeParse({ ...valid, mpesaClosingBalance: Number.NaN }).success).toBe(false)
  })
})

const staffRow = (name: string) => ({ id: 2, name, role: 'admin', is_active: 1 }) as unknown as StaffRow

const reportDb = (corrections: ShiftCorrectionRow[]) =>
  ({
    getShiftById: () => closedShift,
    getStaffById: () => staffRow('Manager Mo'),
    getOrdersForShift: () => [],
    getMpesaPaymentsForShift: () => [],
    listShiftCorrections: () => corrections,
    listShiftAdjustments: () => [], // ADDED (docs/phase-231)
    listAdjustmentSales: () => []
  }) as unknown as RubisDatabase

describe('the Z report with corrections', () => {
  it('keeps the original figures exactly and lists each correction under them, oldest first, with the name', () => {
    const report = generateZReport(
      reportDb([correctionRow(), correctionRow({ id: 2, ending_cash: 1490, discrepancy: -10 })]),
      1,
      0.16
    )

    expect(report.endingCash).toBe(1480)
    expect(report.discrepancy).toBe(-20)
    expect(report.corrections).toHaveLength(2)
    expect(report.corrections?.[0]).toMatchObject({ id: 1, correctedByName: 'Manager Mo', reason: 'Counted cash was mistyped', endingCash: 1500 })
    expect(report.corrections?.[1].endingCash).toBe(1490)
  })

  it('has none for a shift never corrected', () => {
    expect(generateZReport(reportDb([]), 1, 0.16).corrections).toEqual([])
  })

  const format = (n: number): string => `KES ${n}`
  const when = (iso: string): string => `at ${iso}`

  it('words each correction the same in the renderer twin, with the M-Pesa lines from the one place', () => {
    const report = generateZReport(reportDb([correctionRow({ mpesa_opening_balance: null, mpesa_closing_balance: null, mpesa_expected: null, mpesa_difference: null })]), 1, 0.16)
    const blocks = zReportCorrectionBlocks(report, format, when)

    expect(blocks).toHaveLength(1)
    expect(blocks[0].heading).toBe('Corrected on at 2026-10-06T08:00:00.000Z by Manager Mo: Counted cash was mistyped')
    expect(blocks[0].details).toEqual([
      'Starting Cash: KES 1000',
      'Expected Cash: KES 1500',
      'Counted Cash: KES 1500',
      'Discrepancy: KES 0',
      'M-Pesa opening: Not recorded',
      'M-Pesa expected: Not recorded',
      'M-Pesa counted: Not recorded',
      'Check against the M-Pesa statement: Not recorded'
    ])
    expect(rendererBlocks(report, format, when)).toEqual(blocks)
    expect(zReportCorrectionBlocks({}, format, when)).toEqual([])
  })

  it('prints every correction after the originals, each under a dashed line', () => {
    const report = generateZReport(reportDb([correctionRow(), correctionRow({ id: 2, reason: 'Float was mistyped' })]), 1, 0.16)
    const lines: string[] = []
    const noop = (): void => {}
    const client = {
      isPrinterConnected: async () => true,
      alignCenter: noop,
      alignLeft: noop,
      alignRight: noop,
      bold: noop,
      setTextNormal: noop,
      setTextQuadArea: noop,
      println: (text: string) => lines.push(text),
      drawLine: () => lines.push('---'),
      printQR: noop,
      cut: noop,
      execute: async () => undefined
    } as unknown as ThermalPrinterLike
    const settings: PrinterSettings = { interfaceName: 'tcp://x', storeName: 'ENJOY', taxRate: 0.16 }

    renderZReport(client, report, settings)

    const original = lines.findIndex((l) => l.startsWith('Counted Cash: ') && l.includes('1,480.00'))
    const first = lines.findIndex((l) => l.includes('Counted cash was mistyped'))
    const second = lines.findIndex((l) => l.includes('Float was mistyped'))
    expect(original).toBeGreaterThan(-1)
    expect(first).toBeGreaterThan(original)
    expect(second).toBeGreaterThan(first)
    expect(lines[first - 1]).toBe('---')
    expect(lines[second - 1]).toBe('---')
  })
})

describe('the Z report screen', () => {
  let container: HTMLDivElement
  let root: Root

  const baseReport: ZReport = {
    shiftId: 1,
    staffName: 'Ann',
    openedAt: closedShift.clock_in,
    closedAt: closedShift.clock_out,
    status: 'closed',
    startingCash: 1000,
    totalsByMethod: { cash: 500, mpesa: 500, card: 75 },
    mpesaByMode: { manual: 0, daraja: 0 },
    orderCount: 4,
    totalRevenue: 1075,
    vatIncluded: 148.28,
    vatRate: 0.16,
    expectedCash: 1500,
    endingCash: 1480,
    discrepancy: -20
  }
  const corrected: ZReport = {
    ...baseReport,
    corrections: [
      {
        id: 1,
        correctedAt: '2026-10-06T08:00:00.000Z',
        correctedByName: 'Manager Mo',
        reason: 'Counted cash was mistyped',
        startingCash: 1000,
        endingCash: 1500,
        expectedCash: 1500,
        discrepancy: 0,
        mpesaOpeningBalance: null,
        mpesaClosingBalance: null,
        mpesaExpected: null,
        mpesaDifference: null
      }
    ]
  }

  const ok = <T,>(data?: T) => ({ success: true as const, data })
  const stubApi = (overrides: Record<string, unknown> = {}): void => {
    window.api = {
      printZReport: vi.fn().mockResolvedValue(ok({})),
      getZReport: vi.fn().mockResolvedValue(ok(corrected)),
      correctShift: vi.fn().mockResolvedValue(ok({ id: 1 })),
      ...overrides
    } as unknown as typeof window.api
  }
  const flush = async (): Promise<void> => {
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }
  const click = async (label: string): Promise<void> => {
    const el = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)
    if (!el) throw new Error(`No button "${label}"`)
    await act(async () => {
      el.click()
      await Promise.resolve()
    })
  }
  const type = (label: string, value: string): void => {
    const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
    if (!input) throw new Error(`No field "${label}"`)
    act(() => input.click())
    act(() => useKeyboardStore.getState().request?.onChange(value))
  }
  const mount = async (report: ZReport, onClose = vi.fn()): Promise<void> => {
    await act(async () => {
      root.render(createElement(ZReportModal, { report, onClose }))
      await Promise.resolve()
    })
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    useKeyboardStore.setState({ request: null })
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('offers "Correct figures" on a closed shift, beside Print, and not on an open one', async () => {
    stubApi()
    await mount(baseReport)
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Correct figures')).toBe(true)
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Print Z-Report')).toBe(true)

    act(() => root.unmount())
    root = createRoot(container)
    await mount({ ...baseReport, status: 'open', closedAt: null, endingCash: null, discrepancy: null })
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Correct figures')).toBe(false)
  })

  it('shows the original figures and, under them, the latest correction and who made it', async () => {
    stubApi()
    await mount(corrected)

    expect(container.textContent).toContain('1,480.00')
    expect(container.textContent).toContain('Corrected on')
    expect(container.textContent).toContain('by Manager Mo: Counted cash was mistyped')
    expect(container.textContent).toContain('Counted Cash: ')
  })

  it('shows nothing about corrections for a shift never corrected', async () => {
    stubApi()
    await mount(baseReport)
    expect(container.textContent).not.toContain('Corrected on')
  })

  it('starts the form from the current figures, and checks cash, M-Pesa and reason before the PIN', async () => {
    stubApi()
    await mount(corrected)
    await click('Correct figures')

    // The last correction's figures (1500), not the shift's own (1480).
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Ending cash (counted)"]')!.value).toBe('1500')

    type('Ending cash (counted)', '')
    await click('Record correction')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Enter the starting cash and the counted ending cash')

    type('Ending cash (counted)', '1490')
    type('M-Pesa balance at end (optional)', 'abc')
    await click('Record correction')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Enter a valid M-Pesa balance, or leave it blank')

    type('M-Pesa balance at end (optional)', '')
    await click('Record correction')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Say why the figures are being corrected')
    expect(container.querySelector('[data-testid="pin"]')).toBeNull()
  })

  it('sends the whole set of figures with the manager, then re-reads the report', async () => {
    stubApi()
    await mount(baseReport)
    await click('Correct figures')
    type('Ending cash (counted)', '1500')
    type('Reason', 'Counted cash was mistyped')
    await click('Record correction')
    await click('Authorize as manager')
    await flush()

    expect(window.api.correctShift).toHaveBeenCalledWith({
      managerId: 2,
      managerPin: '1234',
      shiftId: 1,
      startingCash: 1000,
      endingCash: 1500,
      mpesaOpeningBalance: null,
      mpesaClosingBalance: null,
      reason: 'Counted cash was mistyped'
    })
    expect(window.api.getZReport).toHaveBeenCalledWith(1)
    expect(container.querySelector('input[aria-label="Reason"]')).toBeNull()
    expect(container.textContent).toContain('Corrected on')
  })

  it('shows a refusal from the main process and keeps the form open', async () => {
    stubApi({ correctShift: vi.fn().mockResolvedValue({ success: false, error: 'Nothing has changed from the current figures' }) })
    await mount(baseReport)
    await click('Correct figures')
    type('Reason', 'x')
    await click('Record correction')
    await click('Authorize as manager')
    await flush()

    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Nothing has changed from the current figures')
    expect(container.querySelector('input[aria-label="Reason"]')).not.toBeNull()
  })

  it('cancelling the PIN keeps the form, and cancelling the form keeps the report: neither closes the one behind', async () => {
    stubApi()
    const onClose = vi.fn()
    await mount(baseReport, onClose)
    await click('Correct figures')
    type('Reason', 'x')
    await click('Record correction')
    await click('Cancel PIN')
    expect(container.querySelector('input[aria-label="Reason"]')).not.toBeNull()

    await click('Cancel')
    expect(container.querySelector('input[aria-label="Reason"]')).toBeNull()
    expect(container.textContent).toContain('Z-Report')
    expect(onClose).not.toHaveBeenCalled()
  })
})
