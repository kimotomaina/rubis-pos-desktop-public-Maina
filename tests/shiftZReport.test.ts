/**
 * The shift type on the Z report (docs/phase-199): `generateZReport` carries it
 * with its window label, `renderZReport` prints one extra line, and the cash
 * figures are the same with or without it.
 *
 * CHANGED (docs/phase-237). OLD: Day began at 09:00 and Night ended at 08:59 (docs/phase-199 D1). NEW: Day begins at
 * 07:00 and Night ends at 06:59, the owner's correction; the rule, the labels and the boundary seconds move with it.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { generateZReport } from '../src/main/services/reports.js'
import type { ZReport } from '../src/main/services/reports.js'
import { renderZReport } from '../src/main/services/printer.js'
import type { PrinterSettings, ThermalPrinterLike } from '../src/main/services/printer.js'
import type { RubisDatabase, ShiftRow, StaffRow } from '../src/main/services/database.js'

const baseShift: ShiftRow = {
  id: 4,
  staff_id: 1,
  clock_in: '2026-10-02T06:10:00.000Z',
  clock_out: '2026-10-02T14:20:00.000Z',
  starting_cash: 100,
  expected_cash: 180,
  ending_cash: 175,
  discrepancy: -5,
  status: 'closed'
}

const staff = { id: 1, name: 'Ann', role: 'cashier', is_active: 1 } as unknown as StaffRow

const dbFor = (shift: ShiftRow): RubisDatabase =>
  ({
    getShiftById: vi.fn(() => shift),
    getStaffById: vi.fn(() => staff),
    getOrdersForShift: vi.fn(() => []),
    getMpesaPaymentsForShift: vi.fn(() => []),
    listShiftCorrections: vi.fn(() => []), // ADDED (docs/phase-224): the Z report reads the shift's corrections
    getShiftMerge: () => undefined, // ADDED (docs/phase-239): the Z report reads whether the shift was merged
    listShiftAdjustments: vi.fn(() => []), // ADDED (docs/phase-232): the Z report reads the shift's adjustments
    listAdjustmentSales: vi.fn(() => []), // ADDED (docs/phase-232)
  }) as unknown as RubisDatabase

describe('generateZReport shift fields', () => {
  it('returns the day shift and its window label', () => {
    const report = generateZReport(dbFor({ ...baseShift, shift_type: 'day' }), 4, 0.16)

    expect(report.shiftType).toBe('day')
    expect(report.shiftWindowLabel).toBe('Day shift (07:00 to 17:30)')
  })

  it('returns the night shift and its window label', () => {
    // CHANGED (docs/phase-232, W4). OLD: a shift stored as 'night' read back as the night shift whatever its clock_in
    // was (here 09:10 Nairobi). NEW: the type is the window of clock_in, so it is the day shift, and the stored label
    // is kept as `labelledAs` ("Labelled Night when opened"). The night case now uses a clock_in inside the night window.
    const report = generateZReport(
      dbFor({ ...baseShift, clock_in: '2026-10-02T15:00:00.000Z', clock_out: '2026-10-02T16:00:00.000Z', shift_type: 'night' }),
      4,
      0.16
    )

    expect(report.shiftType).toBe('night')
    expect(report.shiftWindowLabel).toBe('Night shift (17:31 to 06:59)')
    expect(report.labelledAs).toBeUndefined()
  })

  it('shows a shift by its window and notes the label it was given when it differs (docs/phase-231, W4)', () => {
    const report = generateZReport(dbFor({ ...baseShift, shift_type: 'night' }), 4, 0.16)

    expect(report.shiftType).toBe('day')
    expect(report.shiftWindowLabel).toBe('Day shift (07:00 to 17:30)')
    expect(report.labelledAs).toBe('night')
  })

  it('shows the window for a shift opened before shift types existed, with no "labelled" note', () => {
    // CHANGED (docs/phase-232, W4). OLD: null for both when the shift had no label. NEW: every shift has a window
    // (its clock_in), so the type and label are the window's; there was no label, so there is no "labelled" note.
    for (const shift of [baseShift, { ...baseShift, shift_type: null }]) {
      const report = generateZReport(dbFor(shift), 4, 0.16)

      expect(report.shiftType).toBe('day')
      expect(report.shiftWindowLabel).toBe('Day shift (07:00 to 17:30)')
      expect(report.labelledAs).toBeUndefined()
    }
  })

  it('leaves every other figure as it was', () => {
    const report = generateZReport(dbFor({ ...baseShift, shift_type: 'night' }), 4, 0.16)
    // CHANGED (docs/phase-222). OLD: only the shift type and its label were set aside. NEW: the four M-Pesa balance
    // fields too: they are new, and tests/shiftMpesaBalances.test.ts covers them. Every figure below is unchanged.
    // CHANGED AGAIN (docs/phase-223): and the four fields that say a shift was recorded afterwards (kind, createdAt,
    // createdByName, reason), covered by tests/pastShift.test.ts.
    // CHANGED AGAIN (docs/phase-224): and `corrections`, covered by tests/shiftCorrections.test.ts.
    // CHANGED AGAIN (docs/phase-232): and `labelledAs` (here the stored 'night' differs from the window), covered above.
    const {
      shiftType: _type,
      shiftWindowLabel: _label,
      mpesaOpeningBalance: _opening,
      mpesaExpected: _expected,
      mpesaClosingBalance: _closing,
      mpesaDifference: _difference,
      kind: _kind,
      createdAt: _createdAt,
      createdByName: _createdByName,
      reason: _reason,
      corrections: _corrections,
      labelledAs: _labelledAs,
      ...figures
    } = report

    expect(figures).toEqual({
      shiftId: 4,
      staffName: 'Ann',
      openedAt: baseShift.clock_in,
      closedAt: baseShift.clock_out,
      status: 'closed',
      startingCash: 100,
      totalsByMethod: { cash: 0, mpesa: 0, card: 0 },
      mpesaByMode: { manual: 0, daraja: 0 },
      orderCount: 0,
      totalRevenue: 0,
      vatIncluded: 0,
      vatRate: 0.16,
      expectedCash: 180,
      endingCash: 175,
      discrepancy: -5
    })
  })
})

describe('renderZReport shift line', () => {
  const settings: PrinterSettings = { interfaceName: 'tcp://x', storeName: 'ENJOY', taxRate: 0.16 }

  const baseReport: ZReport = {
    shiftId: 4,
    staffName: 'Ann',
    openedAt: baseShift.clock_in,
    closedAt: baseShift.clock_out,
    status: 'closed',
    startingCash: 100,
    totalsByMethod: { cash: 0, mpesa: 0, card: 0 },
    mpesaByMode: { manual: 0, daraja: 0 },
    orderCount: 0,
    totalRevenue: 0,
    vatIncluded: 0,
    vatRate: 0.16,
    expectedCash: 180,
    endingCash: 175,
    discrepancy: -5
  }

  const printed = (report: ZReport): string[] => {
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
      drawLine: noop,
      cut: noop,
      execute: async () => undefined
    } as ThermalPrinterLike
    renderZReport(client, report, settings)
    return lines
  }

  it('prints the window label on its own line, straight after the shift number', () => {
    const lines = printed({ ...baseReport, shiftType: 'night', shiftWindowLabel: 'Night shift (17:31 to 06:59)' })
    const at = lines.indexOf('Shift #4')

    expect(lines[at + 1]).toBe('Night shift (17:31 to 06:59)')
    expect(lines[at + 2]).toMatch(/^Opened:/)
  })

  it('fits a 32-column slip', () => {
    expect('Night shift (17:31 to 06:59)'.length).toBeLessThanOrEqual(32)
    expect('Day shift (07:00 to 17:30)'.length).toBeLessThanOrEqual(32)
  })

  it('prints no extra line for a shift without a type', () => {
    const withLabel = printed({ ...baseReport, shiftWindowLabel: 'Day shift (07:00 to 17:30)' })
    const without = printed(baseReport)
    const nulled = printed({ ...baseReport, shiftType: null, shiftWindowLabel: null })

    expect(without).toEqual(nulled)
    expect(withLabel.length).toBe(without.length + 1)
    expect(without.some((l) => /shift \(/i.test(l))).toBe(false)
  })
})

describe('the shift handlers in main/index.ts', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8')
  const handlerBody = (channel: string): string => {
    const start = source.indexOf(`'${channel}',`)
    return source.slice(start, source.indexOf('ipcMain.handle(', start))
  }

  it('validates shifts:open with shiftOpenSchema and no longer coerces the cash figure', () => {
    const body = handlerBody('shifts:open')

    expect(body).toContain('validate(shiftOpenSchema, request)')
    expect(body).not.toContain('Number(request')
  })

  it('validates shifts:close with shiftCloseSchema and no longer coerces the cash figure', () => {
    const body = handlerBody('shifts:close')

    expect(body).toContain('validate(shiftCloseSchema, request)')
    expect(body).not.toContain('Number(request')
  })
})
