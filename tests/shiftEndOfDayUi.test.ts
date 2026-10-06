/**
 * The end of day of one shift on the screen (docs/phase-246, the amendment). It keeps what the day's page of docs/phase-150 to
 * 153 did, ported from `endOfDayPage.test.ts`: the cashier totals, the entries ticked by default, the reasons for leaving one out, the
 * note, the PIN, the notices. What is new: it is one shift's, approving is offered only when the shift can be approved,
 * and the carry-over is that of earlier shifts. Real mount; the PIN window is stood in for by a button.
 *
 * CHANGED (docs/phase-246). OLD: `endOfDayPage.test.ts` and `endOfDayShiftFilterUi.test.ts` (38 tests) drove the day's
 * page with its day buttons, its shift filter and its own scrolling part. NEW: those are gone with the page; the day buttons and
 * the shift filter are the Reports tab's scope.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import ShiftEndOfDay from '../src/renderer/src/components/ShiftEndOfDay.js'
import ShiftApprovalList from '../src/renderer/src/components/ShiftApprovalList.js'
import type { ManualMpesaEntrySummary, ShiftEndOfDayReport, ShiftApprovalRow } from '../src/main/services/reports.js'
import { useKeyboardStore } from '../src/renderer/src/stores/keyboardStore.js'

vi.mock('../src/renderer/src/components/ManagerPinModal.js', () => ({
  default: ({ onAuthorized, title }: { onAuthorized: (id: number, pin: string) => void; title: string }) =>
    createElement('div', { 'data-testid': 'pin-modal' }, createElement('p', null, title), createElement('button', { onClick: () => onAuthorized(9, '9999') }, 'Authorize as admin'))
}))

let container: HTMLDivElement
let root: Root

const ok = <T,>(data?: T) => ({ success: true as const, data })
const plain = (text: string | null | undefined): string => (text ?? '').replace(/ /g, ' ')

function entry(overrides: Partial<ManualMpesaEntrySummary> = {}): ManualMpesaEntrySummary {
  return {
    paymentId: 1,
    orderLocalId: 10,
    createdAt: '2026-10-05T09:00:00.000Z',
    localDay: '2026-10-05',
    staffId: 1,
    staffName: 'Ann',
    reference: 'QDF73HK9LM',
    amount: 60,
    approved: false,
    reconciledAt: null,
    reconciledByStaffId: null,
    reconciledByStaffName: null,
    sameApproverAsRecorder: false,
    lastExclusion: null,
    ...overrides
  }
}

function report(overrides: Partial<ShiftEndOfDayReport> = {}): ShiftEndOfDayReport {
  return {
    localDay: '2026-10-05',
    shiftId: 3,
    shiftStatus: 'closed',
    openedAt: '2026-10-05T06:14:00.000Z',
    closedAt: '2026-10-05T14:30:59.000Z',
    windowType: 'day',
    mergedInto: null,
    approval: null,
    canApprove: true,
    cannotApproveBecause: null,
    cashiers: [{ staffId: 1, staffName: 'Ann', orderCount: 2, totalsByMethod: { cash: 50, mpesa: 100, card: 0 }, mpesaByMode: { manual: 60, daraja: 40 } }],
    totalsByMethod: { cash: 50, mpesa: 100, card: 0 },
    manualEntries: [entry()],
    carryOver: [],
    pendingIds: [1],
    pendingManualTotal: 60,
    ...overrides
  }
}

function stubApi(first: ShiftEndOfDayReport, approve?: (...args: unknown[]) => unknown, later?: ShiftEndOfDayReport): void {
  const getShiftEndOfDayReport = vi.fn().mockResolvedValueOnce(ok(first))
  if (later) getShiftEndOfDayReport.mockResolvedValue(ok(later))
  else getShiftEndOfDayReport.mockResolvedValue(ok(first))
  window.api = {
    getShiftEndOfDayReport,
    getDiscardedHeldSales: vi.fn().mockResolvedValue(ok([])),
    approveShiftReport: vi.fn(approve ?? (() => Promise.resolve(ok({ approval: null, approvedCount: 1, excludedCount: 0, alreadyApproved: false }))))
  } as unknown as typeof window.api
}

async function mount(shiftId = 3): Promise<void> {
  await act(async () => {
    root.render(createElement(ShiftEndOfDay, { shiftId }))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

function button(label: string): HTMLButtonElement {
  const el = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)
  if (!el) throw new Error(`No button "${label}"`)
  return el as HTMLButtonElement
}

function checkbox(reference: string): HTMLInputElement {
  const row = Array.from(container.querySelectorAll('tr')).find((tr) => tr.textContent?.includes(reference))
  if (!row) throw new Error(`No row for "${reference}"`)
  const el = row.querySelector('input[type="checkbox"]')
  if (!el) throw new Error(`No checkbox on the row for "${reference}"`)
  return el as HTMLInputElement
}

async function approve(): Promise<void> {
  const label = Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Approve') ? 'Approve' : 'Record review'
  await act(async () => {
    button(label).click()
    await Promise.resolve()
  })
  await act(async () => {
    button('Authorize as admin').click()
    await Promise.resolve()
    await Promise.resolve()
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
  vi.restoreAllMocks()
})

describe('the end of day of one shift', () => {
  it('asks for that shift only, and shows its cashier totals and its manual entries ticked by default', async () => {
    stubApi(report())
    await mount()

    expect(window.api.getShiftEndOfDayReport).toHaveBeenCalledWith(3)
    expect(container.textContent).toContain('End of Day for shift #3')
    expect(container.textContent).toContain('Per cashier')
    expect(container.textContent).toContain('QDF73HK9LM')
    expect(checkbox('QDF73HK9LM').checked).toBe(true)
    expect(plain(container.querySelector('[data-testid="end-of-day-bar"]')?.textContent)).toContain('Approving 1 of 1 entry. 0 left out.')
  })

  it('shows the carry-over of earlier shifts apart, each with its own day, and a reason it was left out before', async () => {
    stubApi(
      report({
        carryOver: [entry({ paymentId: 2, reference: 'CARRY12345', localDay: '2026-10-04', lastExclusion: { localDay: '2026-10-04', staffName: 'Bob', reason: 'not on the statement' } })],
        pendingIds: [1, 2],
        pendingManualTotal: 120
      })
    )
    await mount()

    expect(container.textContent).toContain('Carry-over from earlier shifts')
    const row = Array.from(container.querySelectorAll('tr')).find((tr) => tr.textContent?.includes('CARRY12345'))!
    expect(row.textContent).toContain('2026-10-04')
    expect(container.textContent).toContain('Left out on 2026-10-04 by Bob: not on the statement')
    expect(checkbox('CARRY12345').checked).toBe(true)
  })

  it('marks an entry recorded and approved by the same person', async () => {
    stubApi(report({ manualEntries: [entry({ approved: true, sameApproverAsRecorder: true, reconciledByStaffName: 'Ann' })], pendingIds: [], pendingManualTotal: 0, canApprove: false, cannotApproveBecause: 'There is nothing waiting to be approved.' }))
    await mount()

    expect(container.textContent).toContain('Recorded and approved by the same person.')
  })
})

describe('approving a shift', () => {
  it('sends the shift and every ticked id, with an empty excluded list, after the PIN', async () => {
    stubApi(report())
    await mount()

    await approve()

    expect(window.api.approveShiftReport).toHaveBeenCalledWith({ shiftId: 3, approvedIds: [1], excluded: [], managerId: 9, managerPin: '9999', note: undefined })
    expect(container.querySelector('[data-testid="pin-modal"]')).toBeNull()
  })

  it('names the shift in the PIN prompt, and says how many it approves and how many it leaves out', async () => {
    stubApi(report({ manualEntries: [entry(), entry({ paymentId: 2, reference: 'SECOND12345', amount: 40 })], pendingIds: [1, 2] }))
    await mount()
    act(() => checkbox('SECOND12345').click())

    await act(async () => {
      button('Approve').click()
      await Promise.resolve()
    })

    expect(container.querySelector('[data-testid="pin-modal"]')?.textContent).toContain('Approve 1 entry, leave 1 out for shift #3')
  })

  it('unticking one of two sends it in excluded with its reason, and the other stays approved', async () => {
    stubApi(report({ manualEntries: [entry(), entry({ paymentId: 2, reference: 'SECOND12345', amount: 40 })], pendingIds: [1, 2] }))
    await mount()
    act(() => checkbox('SECOND12345').click())
    const reasonInput = container.querySelector<HTMLInputElement>('input[placeholder="Reason for leaving this out (optional)"]')!
    act(() => reasonInput.click())
    act(() => useKeyboardStore.getState().request?.onChange('not on the statement'))

    await approve()

    expect(vi.mocked(window.api.approveShiftReport).mock.calls[0][0]).toMatchObject({
      shiftId: 3,
      approvedIds: [1],
      excluded: [{ paymentId: 2, reason: 'not on the statement' }]
    })
  })

  it('unticking the only entry makes the button "Record review", and it submits an empty approvedIds list', async () => {
    stubApi(report())
    await mount()
    act(() => checkbox('QDF73HK9LM').click())

    expect(button('Record review')).toBeDefined()
    await approve()

    expect(vi.mocked(window.api.approveShiftReport).mock.calls[0][0]).toMatchObject({ approvedIds: [], excluded: [{ paymentId: 1 }] })
  })

  it('opens the shared keyboard for the note, and sends it', async () => {
    stubApi(report())
    await mount()
    const note = container.querySelector<HTMLInputElement>('input[aria-label="Note for this review (optional)"]')!
    act(() => note.click())
    act(() => useKeyboardStore.getState().request?.onChange('checked against the statement'))

    await approve()

    expect(vi.mocked(window.api.approveShiftReport).mock.calls[0][0]).toMatchObject({ note: 'checked against the statement' })
  })

  it('says how many were approved and left out, then reads the shift as approved, with no tick boxes and no button', async () => {
    const approved = report({
      manualEntries: [entry({ approved: true, reconciledByStaffName: 'Bob' })],
      pendingIds: [],
      pendingManualTotal: 0,
      canApprove: false,
      cannotApproveBecause: 'Approved by Bob on 2026-10-06T10:00:00.000Z.',
      approval: { approvalId: 5, approvedAt: '2026-10-06T10:00:00.000Z', approvedByName: 'Bob', entryCount: 1, excludedCount: 0, totalAmount: 60 }
    })
    stubApi(report(), undefined, approved)
    await mount()

    await approve()

    expect(container.textContent).toContain('1 approved, 0 left out.')
    expect(plain(container.querySelector('[data-testid="shift-approval-state"]')?.textContent)).toContain('Approved by Bob on')
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Approve')).toBe(false)
    expect(container.querySelector('[data-testid="end-of-day-limited"]')?.textContent).toContain('This shift is approved.')
  })

  it('shows the refusal of the main process and keeps the entries as they were', async () => {
    stubApi(report(), () => Promise.resolve({ success: false, error: 'Shift #3 was already approved by Bob on 2026-10-06T10:00:00.000Z' }))
    await mount()

    await approve()

    expect(container.textContent).toContain('Shift #3 was already approved by Bob')
    expect(checkbox('QDF73HK9LM').checked).toBe(true)
  })
})

describe('a shift that cannot be approved', () => {
  it.each([
    ['still open', { shiftStatus: 'open' as const, closedAt: null, cannotApproveBecause: 'The shift is still open. Close it before approving its M-Pesa entries.' }, 'The shift is still open'],
    ['merged into another', { mergedInto: 1, cannotApproveBecause: 'This shift was merged into shift #1. Approve that shift.' }, 'was merged into shift #1'],
    ['with nothing waiting', { pendingIds: [], pendingManualTotal: 0, cannotApproveBecause: 'There is nothing waiting to be approved.' }, 'nothing waiting to be approved']
  ])('says why, shows no tick box and no Approve, when it is %s', async (_name, extra, words) => {
    stubApi(report({ canApprove: false, ...extra }))
    await mount()

    expect(container.textContent).toContain(words)
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Approve' || b.textContent === 'Record review')).toBe(false)
    expect(window.api.approveShiftReport).not.toHaveBeenCalled()
  })
})

describe('the held sales discarded block', () => {
  it('is read for the day the shift began', async () => {
    stubApi(report())
    await mount()

    expect(window.api.getDiscardedHeldSales).toHaveBeenCalledWith('2026-10-05')
  })
})

describe('the shifts of a range', () => {
  const rows: ShiftApprovalRow[] = [
    { shiftId: 8, status: 'open', openedAt: '2026-10-06T08:35:14.000Z', closedAt: null, windowType: 'day', windowDate: '2026-10-06', orderCount: 36, state: 'open', manualCount: 19, pendingCount: 19, pendingAmount: 24175, approvedAt: null, approvedByName: null },
    { shiftId: 3, status: 'closed', openedAt: '2026-10-05T06:14:00.000Z', closedAt: '2026-10-05T14:30:59.000Z', windowType: 'day', windowDate: '2026-10-05', orderCount: 42, state: 'not-approved', manualCount: 23, pendingCount: 1, pendingAmount: 60, approvedAt: null, approvedByName: null }
  ]

  it('names each shift, its sales, its entries and its state, and switches to it with one button', async () => {
    window.api = { getEndOfDayShifts: vi.fn().mockResolvedValue(ok(rows)) } as unknown as typeof window.api
    const onOpenShift = vi.fn()
    await act(async () => {
      root.render(createElement(ShiftApprovalList, { scope: 'yesterday', onOpenShift }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(window.api.getEndOfDayShifts).toHaveBeenCalledWith('yesterday')
    const text = plain(container.textContent)
    expect(text).toContain('Shift #8, Day, 6 Oct 11:35 to now')
    expect(text).toContain('1 of 23 waiting')
    await act(async () => {
      button('Open shift #3').click()
      await Promise.resolve()
    })
    expect(onOpenShift).toHaveBeenCalledWith(rows[1], 'Shift #3, Day, 5 Oct 09:14 to 17:30')
  })

  it('says so when no shift has sales in the range, and when the list cannot be read', async () => {
    window.api = { getEndOfDayShifts: vi.fn().mockResolvedValue(ok([])) } as unknown as typeof window.api
    await act(async () => {
      root.render(createElement(ShiftApprovalList, { scope: 'today', onOpenShift: vi.fn() }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.textContent).toContain('No shift has sales in this range.')

    window.api = { getEndOfDayShifts: vi.fn().mockResolvedValue({ success: false, error: 'boom' }) } as unknown as typeof window.api
    await act(async () => {
      root.render(createElement(ShiftApprovalList, { scope: { shiftId: 99 }, onOpenShift: vi.fn() }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.textContent).toContain('boom')
  })
})
