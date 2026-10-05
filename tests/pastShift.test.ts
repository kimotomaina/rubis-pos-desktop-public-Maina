/**
 * Recording a shift for sales that had none (docs/phase-223): the period and overlap rules, and the Z report that says so.
 *
 * CHANGED (docs/phase-231). OLD: this file also tested `createRetrospectiveShift` (the one transaction that wrote the shift
 * and attached its sales), `listUnattachedDays`, `previewPastShift` and the `shifts:create-past` and `shifts:past-preview`
 * request schemas. NEW: the manual past-shift flow is retired (the till gives every sale to its shift by itself), so those
 * are removed. Their replacements are in tests/oneShiftPerWindow.test.ts. What stays is the period and overlap rules
 * (still used, to make an automatic shift that touches no other) and the Z report lines.
 */

import { describe, it, expect } from 'vitest'
import type { RubisDatabase, ShiftRow, StaffRow } from '../src/main/services/database.js'
import { findOverlappingShift, parsePastShiftPeriod } from '../src/main/lib/pastShift.js'
import { generateZReport } from '../src/main/services/reports.js'
import type { ZReport } from '../src/main/services/reports.js'
import { renderZReport } from '../src/main/services/printer.js'
import type { PrinterSettings, ThermalPrinterLike } from '../src/main/services/printer.js'
import { zReportRetroLines } from '../src/main/lib/zReportRetro.js'
import { zReportRetroLines as rendererRetroLines } from '../src/renderer/src/lib/zReportRetro.js'

const NOW = Date.parse('2026-10-05T12:00:00.000Z')
const START = '2026-10-03T07:00:00.000Z'
const END = '2026-10-03T14:59:59.999Z'

describe('parsePastShiftPeriod', () => {
  it('normalises both instants to the .000Z form and keeps their milliseconds', () => {
    const period = parsePastShiftPeriod('2026-10-03T10:00:00+03:00', '2026-10-03T17:59:59.999+03:00', NOW)

    expect(period.startIso).toBe('2026-10-03T07:00:00.000Z')
    expect(period.endIso).toBe('2026-10-03T14:59:59.999Z')
  })

  it('refuses an unreadable time, an end before the start, and an end in the future', () => {
    expect(() => parsePastShiftPeriod('nonsense', END, NOW)).toThrow(/not a valid time/)
    expect(() => parsePastShiftPeriod(END, START, NOW)).toThrow(/before its start/)
    expect(() => parsePastShiftPeriod(START, '2026-10-05T12:00:00.001Z', NOW)).toThrow(/future/)
  })

  it('allows an end of exactly now, and an end equal to the start', () => {
    expect(() => parsePastShiftPeriod(START, '2026-10-05T12:00:00.000Z', NOW)).not.toThrow()
    expect(() => parsePastShiftPeriod(START, START, NOW)).not.toThrow()
  })
})

describe('findOverlappingShift', () => {
  const shift = { id: 4, clock_in: '2026-10-03T06:00:00.000Z', clock_out: '2026-10-03T14:00:00.000Z' }
  const at = (iso: string): number => Date.parse(iso)

  it('counts touching as overlap, at either end, to the millisecond', () => {
    expect(findOverlappingShift([shift], at('2026-10-03T14:00:00.000Z'), at('2026-10-03T16:00:00.000Z'))).toBe(shift)
    expect(findOverlappingShift([shift], at('2026-10-03T04:00:00.000Z'), at('2026-10-03T06:00:00.000Z'))).toBe(shift)
    expect(findOverlappingShift([shift], at('2026-10-03T14:00:00.001Z'), at('2026-10-03T16:00:00.000Z'))).toBeUndefined()
    expect(findOverlappingShift([shift], at('2026-10-03T04:00:00.000Z'), at('2026-10-03T05:59:59.999Z'))).toBeUndefined()
  })

  it('refuses a period inside, around or straddling a shift', () => {
    expect(findOverlappingShift([shift], at('2026-10-03T08:00:00.000Z'), at('2026-10-03T09:00:00.000Z'))).toBe(shift)
    expect(findOverlappingShift([shift], at('2026-10-03T01:00:00.000Z'), at('2026-10-03T20:00:00.000Z'))).toBe(shift)
    expect(findOverlappingShift([shift], at('2026-10-03T13:00:00.000Z'), at('2026-10-03T20:00:00.000Z'))).toBe(shift)
  })

  it('treats an open shift as running on for ever: a period wholly before it is allowed, one after is not', () => {
    const open = { id: 5, clock_in: '2026-10-05T06:00:00.000Z', clock_out: null }
    expect(findOverlappingShift([open], at('2026-10-03T07:00:00.000Z'), at('2026-10-03T15:00:00.000Z'))).toBeUndefined()
    expect(findOverlappingShift([open], at('2026-10-05T06:00:00.000Z'), at('2026-10-05T07:00:00.000Z'))).toBe(open)
    expect(findOverlappingShift([open], at('2026-10-04T00:00:00.000Z'), at('2026-10-05T11:00:00.000Z'))).toBe(open)
  })

  it('refuses rather than guesses when a shift time cannot be read', () => {
    const broken = { id: 6, clock_in: '2026-10-03T06:00:00.000Z', clock_out: 'garbage' }
    expect(findOverlappingShift([broken], at('2030-01-01T00:00:00.000Z'), at('2030-01-02T00:00:00.000Z'))).toBe(broken)
  })
})

describe('the Z report of a shift recorded afterwards', () => {
  const staff = (name: string) => ({ id: 2, name, role: 'admin', is_active: 1 }) as unknown as StaffRow
  const row: ShiftRow = {
    id: 9,
    staff_id: 2,
    clock_in: START,
    clock_out: END,
    starting_cash: 1000,
    expected_cash: 1500,
    ending_cash: 1480,
    discrepancy: -20,
    status: 'closed',
    shift_type: 'day',
    kind: 'retrospective',
    created_by_staff_id: 2,
    created_at: '2026-10-05T12:00:00.000Z',
    reason: 'Till used without opening a shift'
  }
  const reportFor = (shift: ShiftRow): ZReport =>
    generateZReport(
      {
        getShiftById: () => shift,
        getStaffById: () => staff('Manager Mo'),
        getOrdersForShift: () => [],
        getMpesaPaymentsForShift: () => [],
        listShiftCorrections: () => [],
        listShiftAdjustments: () => [], // ADDED (docs/phase-231)
        listAdjustmentSales: () => []
      } as unknown as RubisDatabase,
      9,
      0.16
    )

  it('carries who recorded it, when and why', () => {
    expect(reportFor(row)).toMatchObject({
      kind: 'retrospective',
      createdAt: '2026-10-05T12:00:00.000Z',
      createdByName: 'Manager Mo',
      reason: 'Till used without opening a shift'
    })
  })

  it('is a normal shift, with nothing recorded, for one from before', () => {
    const { kind: _k, created_by_staff_id: _c, created_at: _a, reason: _r, ...old } = row
    expect(reportFor(old as ShiftRow)).toMatchObject({ kind: 'normal', createdAt: null, createdByName: null, reason: null })
  })

  it('has the retrospective lines, none for a normal shift, the same in the renderer twin', () => {
    const format = (iso: string): string => `at ${iso}`
    const retro = reportFor(row)
    const normal = reportFor({ ...row, kind: 'normal' })

    expect(zReportRetroLines(retro, format)).toEqual([
      'RETROSPECTIVE SHIFT, created at 2026-10-05T12:00:00.000Z by Manager Mo',
      'Reason: Till used without opening a shift'
    ])
    expect(zReportRetroLines(normal, format)).toEqual([])
    for (const report of [retro, normal]) {
      expect(rendererRetroLines(report, format)).toEqual(zReportRetroLines(report, format))
    }
  })

  it('prints those lines in place of a cashier, and prints the cashier for a normal shift', () => {
    const settings: PrinterSettings = { interfaceName: 'tcp://x', storeName: 'ENJOY', taxRate: 0.16 }
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
        drawLine: () => lines.push('---'),
        printQR: noop,
        cut: noop,
        execute: async () => undefined
      } as unknown as ThermalPrinterLike
      renderZReport(client, report, settings)
      return lines
    }

    const retro = printed(reportFor(row))
    expect(retro.some((l) => l.startsWith('RETROSPECTIVE SHIFT, created'))).toBe(true)
    expect(retro).toContain('Reason: Till used without opening a shift')
    expect(retro.some((l) => l.startsWith('Cashier:'))).toBe(false)

    const normal = printed(reportFor({ ...row, kind: 'normal' }))
    // docs/phase-227: old `startsWith('Cashier:')`, new `startsWith('Opened by:')` — the line names the opener, not necessarily the person at the till.
    expect(normal.some((l) => l.startsWith('Opened by:'))).toBe(true)
    expect(normal.some((l) => l.includes('RETROSPECTIVE'))).toBe(false)
  })
})
