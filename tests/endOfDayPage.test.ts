/**
 * `EndOfDayPage` (docs/phase-150.md deferred approval to this;
 * docs/phase-151/152 built the day approval; docs/phase-153 lets a
 * manager leave individual entries out with a reason) — mounted with
 * `react-dom/client`, the `NeedsAttentionPage.test.ts`/`paymentModal.test.ts`
 * pattern for a page whose interactive surface is what needs covering.
 *
 * `window.api` is stubbed per test with only the methods this page and
 * `ManagerPinModal` call.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import EndOfDayPage from '../src/renderer/src/pages/EndOfDayPage.js'
import type { EndOfDayReport, ManualMpesaEntrySummary } from '../src/main/services/reports.js'
import { useAuthStore } from '../src/renderer/src/stores/authStore.js'
import { useKeyboardStore } from '../src/renderer/src/stores/keyboardStore.js'

let container: HTMLDivElement
let root: Root

function entry(overrides: Partial<ManualMpesaEntrySummary> = {}): ManualMpesaEntrySummary {
  return {
    paymentId: 1,
    orderLocalId: 10,
    createdAt: '2026-09-10T09:00:00.000Z',
    localDay: '2026-09-10',
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

function baseReport(overrides: Partial<EndOfDayReport> = {}): EndOfDayReport {
  return {
    localDay: '2026-09-10',
    cashiers: [
      {
        staffId: 1,
        staffName: 'Ann',
        orderCount: 2,
        totalsByMethod: { cash: 50, mpesa: 100, card: 0 },
        mpesaByMode: { manual: 60, daraja: 40 }
      }
    ],
    totalsByMethod: { cash: 50, mpesa: 100, card: 0 },
    manualEntries: [entry()],
    carryOver: [],
    pendingIds: [1],
    pendingManualTotal: 60,
    ...overrides
  }
}

function stubApi(report: EndOfDayReport, approveImpl?: (...args: unknown[]) => unknown): void {
  window.api = {
    getEndOfDayReport: vi.fn().mockResolvedValue({ success: true, data: report }),
    approveDayReport: vi.fn(
      approveImpl ??
        (() =>
          Promise.resolve({
            success: true,
            data: { approval: null, approvedCount: 0, excludedCount: 0, alreadyApproved: false }
          }))
    ),
    login: vi.fn().mockResolvedValue({ success: true, data: { id: 9, name: 'Manager Mo', role: 'admin' } })
  } as unknown as typeof window.api
}

async function mount(): Promise<void> {
  await act(async () => {
    root.render(createElement(EndOfDayPage))
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

/**
 * Sets a controlled `<input>`'s value through the native setter, bypassing
 * React's own value tracking, then fires `input` — the standard jsdom
 * workaround for typing into a React-controlled field with no testing
 * library installed here.
 */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useKeyboardStore.setState({ request: null })
  useAuthStore.setState({
    staffList: [
      { id: 1, name: 'Ann', role: 'cashier' },
      { id: 9, name: 'Manager Mo', role: 'admin' }
    ]
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function authorizeWithPin(): Promise<void> {
  const pinInput = container.querySelector('input[type="password"]') as HTMLInputElement
  act(() => typeInto(pinInput, '9999'))
  await act(async () => {
    button('Authorize').click()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('EndOfDayPage', () => {
  it('renders the per-cashier table, the M-Pesa mode split, and pending manual entries — all ticked by default', async () => {
    stubApi(baseReport())
    await mount()

    expect(container.textContent).toContain('End of Day — 2026-09-10')
    expect(container.textContent).toContain('Ann')
    expect(container.textContent).toContain('QDF73HK9LM')
    expect(container.textContent).toContain('Pending')
    expect(checkbox('QDF73HK9LM').checked).toBe(true)
    expect(container.textContent).toContain('Approving 1 of 1 entry. 0 left out.')
  })

  it('shows carry-over separately, labeled by its own day', async () => {
    stubApi(
      baseReport({
        manualEntries: [],
        carryOver: [
          entry({
            paymentId: 2,
            orderLocalId: 5,
            createdAt: '2026-09-08T09:00:00.000Z',
            localDay: '2026-09-08',
            reference: 'ABCD123456',
            amount: 20
          })
        ],
        pendingIds: [2],
        pendingManualTotal: 20
      })
    )
    await mount()

    expect(container.textContent).toContain('Carry-over — not yet approved')
    expect(container.textContent).toContain('2026-09-08')
    expect(container.textContent).toContain('ABCD123456')
  })

  it('shows a prior exclusion\'s day, manager, and reason on a carry-over row', async () => {
    stubApi(
      baseReport({
        manualEntries: [],
        carryOver: [
          entry({
            paymentId: 2,
            reference: 'ABCD123456',
            lastExclusion: { localDay: '2026-09-09', staffName: 'Manager Mo', reason: 'not on statement' }
          })
        ],
        pendingIds: [2],
        pendingManualTotal: 20
      })
    )
    await mount()

    expect(container.textContent).toContain('Left out on 2026-09-09 by Manager Mo: not on statement')
  })

  it('marks an approved entry recorded and approved by the same person', async () => {
    stubApi(
      baseReport({
        manualEntries: [
          entry({
            approved: true,
            reconciledByStaffId: 1,
            reconciledByStaffName: 'Ann',
            sameApproverAsRecorder: true
          })
        ],
        pendingIds: [],
        pendingManualTotal: 0
      })
    )
    await mount()

    expect(container.textContent).toContain('Recorded and approved by the same person')
  })

  it('disables the button when nothing is pending', async () => {
    stubApi(baseReport({ manualEntries: [], pendingIds: [], pendingManualTotal: 0 }))
    await mount()

    const approveButton = button('Nothing pending')
    expect(approveButton.disabled).toBe(true)
  })

  it('unticking the only entry switches the button to "Record review" and reveals a reason field', async () => {
    stubApi(baseReport())
    await mount()

    act(() => checkbox('QDF73HK9LM').click())

    expect(container.textContent).toContain('Approving 0 of 1 entry. 1 left out.')
    expect(button('Record review')).toBeTruthy()
    expect(container.querySelector('input[placeholder^="Reason"]')).not.toBeNull()
  })

  it('the reason field is read-only and driven by the shared on-screen keyboard', async () => {
    stubApi(baseReport())
    await mount()
    act(() => checkbox('QDF73HK9LM').click())

    const reasonInput = container.querySelector('input[placeholder^="Reason"]') as HTMLInputElement
    expect(reasonInput.readOnly).toBe(true)

    act(() => reasonInput.click())
    expect(useKeyboardStore.getState().request).not.toBeNull()

    act(() => useKeyboardStore.getState().request?.onChange('not on statement'))
    const updated = container.querySelector('input[placeholder^="Reason"]') as HTMLInputElement
    expect(updated.value).toBe('not on statement')
  })

  it('the optional note is a read-only field driven by the shared on-screen keyboard', async () => {
    stubApi(baseReport())
    await mount()

    const noteInput = container.querySelector('input[placeholder^="e.g."]') as HTMLInputElement
    expect(noteInput.readOnly).toBe(true)

    act(() => noteInput.click())
    expect(useKeyboardStore.getState().request).not.toBeNull()

    act(() => useKeyboardStore.getState().request?.onChange('checked against statement'))
    const updated = container.querySelector('input[placeholder^="e.g."]') as HTMLInputElement
    expect(updated.value).toBe('checked against statement')
  })

  it('approving with everything ticked sends approvedIds only, with an empty excluded list', async () => {
    stubApi(baseReport())
    await mount()

    act(() => button('Approve').click())
    expect(container.textContent).toContain('Manager PIN Required')
    await authorizeWithPin()

    expect(window.api.approveDayReport).toHaveBeenCalledWith(
      expect.objectContaining({
        localDay: '2026-09-10',
        approvedIds: [1],
        excluded: [],
        managerId: 9,
        managerPin: '9999'
      })
    )
  })

  it('unticking one of two entries sends it in excluded with its reason, and the other stays approved', async () => {
    stubApi(
      baseReport({
        manualEntries: [entry({ paymentId: 1, reference: 'AAA1111111', amount: 60 }), entry({ paymentId: 2, reference: 'BBB2222222', amount: 25 })],
        pendingIds: [1, 2],
        pendingManualTotal: 85
      })
    )
    await mount()

    act(() => checkbox('BBB2222222').click())
    const reasonInput = container.querySelector('input[placeholder^="Reason"]') as HTMLInputElement
    act(() => reasonInput.click())
    act(() => useKeyboardStore.getState().request?.onChange('not on statement'))

    expect(container.textContent).toContain('Approving 1 of 2 entries. 1 left out.')

    act(() => button('Approve').click())
    await authorizeWithPin()

    expect(window.api.approveDayReport).toHaveBeenCalledWith(
      expect.objectContaining({
        approvedIds: [1],
        excluded: [{ paymentId: 2, reason: 'not on statement' }]
      })
    )
  })

  it('unticking every entry reads "Record review" and submits an empty approvedIds list', async () => {
    stubApi(baseReport())
    await mount()
    act(() => checkbox('QDF73HK9LM').click())

    act(() => button('Record review').click())
    await authorizeWithPin()

    expect(window.api.approveDayReport).toHaveBeenCalledWith(
      expect.objectContaining({ approvedIds: [], excluded: [{ paymentId: 1, reason: undefined }] })
    )
  })

  it('reports how many were approved and how many left out after a successful review', async () => {
    stubApi(baseReport(), () =>
      Promise.resolve({
        success: true,
        data: {
          approval: {
            id: 1,
            local_day: '2026-09-10',
            approved_by_staff_id: 9,
            approved_at: '2026-09-10T18:00:00.000Z',
            entry_count: 1,
            excluded_count: 0,
            total_amount: 60,
            note: null
          },
          approvedCount: 1,
          excludedCount: 0,
          alreadyApproved: false
        }
      })
    )
    await mount()

    act(() => button('Approve').click())
    await authorizeWithPin()

    expect(container.textContent).toContain('1 approved, 0 left out.')
  })

  it('reports "already approved" without re-approving when the backend says nothing was pending', async () => {
    stubApi(baseReport(), () =>
      Promise.resolve({
        success: true,
        data: {
          approval: {
            id: 3,
            local_day: '2026-09-10',
            approved_by_staff_id: 9,
            approved_at: '2026-09-10T18:00:00.000Z',
            entry_count: 1,
            excluded_count: 0,
            total_amount: 60,
            note: null
          },
          approvedCount: 0,
          excludedCount: 0,
          alreadyApproved: true
        }
      })
    )
    await mount()

    act(() => button('Approve').click())
    await authorizeWithPin()

    expect(container.textContent).toContain('Already approved')
    expect(container.textContent).toContain('Manager Mo')
  })

  it('ticks and reasons survive paging back and forth', async () => {
    const entries = Array.from({ length: 7 }, (_, i) =>
      entry({ paymentId: i + 1, reference: `REF${i}000000`.slice(0, 10), amount: 10 })
    )
    stubApi(
      baseReport({
        manualEntries: entries,
        pendingIds: entries.map((e) => e.paymentId),
        pendingManualTotal: 70
      })
    )
    await mount()

    // Page 1 (6 rows at ENTRIES_PER_PAGE=6): untick the first entry.
    act(() => checkbox('REF0000000').click())
    expect(container.textContent).toContain('Approving 6 of 7 entries. 1 left out.')

    // Move to page 2, back to page 1 — the untick must still be there.
    act(() => button('Next').click())
    expect(container.textContent).toContain('REF6000000')
    act(() => button('Previous').click())

    expect(checkbox('REF0000000').checked).toBe(false)
    expect(container.textContent).toContain('Approving 6 of 7 entries. 1 left out.')
  })
})
