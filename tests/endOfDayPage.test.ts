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

function stubApi(
  report: EndOfDayReport,
  approveImpl?: (...args: unknown[]) => unknown,
  discarded: unknown[] = []
): void {
  window.api = {
    getEndOfDayReport: vi.fn().mockResolvedValue({ success: true, data: report }),
    getDiscardedHeldSales: vi.fn().mockResolvedValue({ success: true, data: discarded }),
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

  it('shows all seven entries with no paging, and an untick keeps its choice', async () => {
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

    act(() => checkbox('REF0000000').click())
    expect(container.textContent).toContain('Approving 6 of 7 entries. 1 left out.')
    expect(container.textContent).toContain('REF6000000')
    expect(container.textContent).not.toContain('Page 1 of')
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Next')).toBe(false)

    expect(checkbox('REF0000000').checked).toBe(false)
    expect(checkbox('REF6000000').checked).toBe(true)
  })
})

/** `entry()` rows with ids from `firstId`, for a list long enough to need scrolling. */
function entryList(count: number, firstId: number, localDay: string, prefix: string): ManualMpesaEntrySummary[] {
  return Array.from({ length: count }, (_, i) =>
    entry({ paymentId: firstId + i, localDay, reference: `${prefix}${String(i).padStart(7, '0')}`, amount: 10 })
  )
}

function discardedSale(id: number): Record<string, unknown> {
  return {
    id,
    label: `Customer ${id}`,
    total: 100,
    lineCount: 1,
    heldAt: '2026-09-10T09:00:00.000Z',
    discardedAt: '2026-09-10T09:20:00.000Z',
    heldByName: 'ann',
    discardedByName: 'ann',
    managerName: 'mo',
    reason: 'left'
  }
}

/** The report of a very busy day: 50 in every list, every entry still pending. */
function busyReport(): EndOfDayReport {
  const manual = entryList(50, 1, '2026-09-10', 'MAN')
  const carry = entryList(50, 101, '2026-09-08', 'CAR')
  return baseReport({
    cashiers: Array.from({ length: 50 }, (_, i) => ({
      staffId: i + 1,
      staffName: `Cashier ${i + 1}`,
      orderCount: 1,
      totalsByMethod: { cash: 10, mpesa: 10, card: 0 },
      mpesaByMode: { manual: 10, daraja: 0 }
    })),
    manualEntries: manual,
    carryOver: carry,
    pendingIds: [...manual, ...carry].map((e) => e.paymentId),
    pendingManualTotal: 1000
  })
}

const fiftyDiscarded = (): unknown[] => Array.from({ length: 50 }, (_, i) => discardedSale(i + 1))
const scrollRegion = (): HTMLElement => container.querySelector('[data-testid="end-of-day-scroll"]') as HTMLElement
const actionBar = (): HTMLElement => container.querySelector('[data-testid="end-of-day-bar"]') as HTMLElement
const VERTICAL_SCROLL = /overflow-(?:y-)?(?:auto|scroll)\b/

/** The bar's one button: Approve, Record review, Nothing pending or Working. */
const barButton = (): HTMLButtonElement => actionBar().querySelector('button') as HTMLButtonElement

describe('EndOfDayPage layout (docs/phase-220)', () => {
  const cases: Array<[string, () => EndOfDayReport, unknown[]]> = [
    ['no entries', () => baseReport({ manualEntries: [], carryOver: [], pendingIds: [], cashiers: [] }), []],
    ['50 in every list', busyReport, fiftyDiscarded()]
  ]

  it.each(cases)('%s: the bar follows the scrolling part and holds Approve, outside it', async (_name, make, discarded) => {
    stubApi(make(), undefined, discarded)
    await mount()

    expect(scrollRegion()).not.toBeNull()
    expect(actionBar().compareDocumentPosition(scrollRegion()) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    expect(scrollRegion().contains(actionBar())).toBe(false)
    expect(actionBar().contains(barButton())).toBe(true)
    expect(scrollRegion().contains(barButton())).toBe(false)
    expect(['Approve', 'Nothing pending']).toContain(barButton().textContent)
    expect(actionBar().querySelector('input[placeholder^="e.g."]')).not.toBeNull()
  })

  it('the top card and the day buttons sit before the scrolling part, outside it', async () => {
    stubApi(baseReport())
    await mount()

    const heading = Array.from(container.querySelectorAll('h3')).find((h) => h.textContent?.startsWith('End of Day'))!
    expect(scrollRegion().contains(heading)).toBe(false)
    expect(heading.compareDocumentPosition(scrollRegion()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(scrollRegion().contains(button('← Previous day'))).toBe(false)
    expect(scrollRegion().contains(button('Next day →'))).toBe(false)
  })

  it('the page is a flex column that fills its parent, and the scrolling part takes what is left', async () => {
    stubApi(baseReport())
    await mount()

    const page = container.firstElementChild as HTMLElement
    expect(page.className).toMatch(/\bflex\b/)
    expect(page.className).toContain('flex-col')
    expect(page.className).toContain('flex-1')
    expect(page.className).toContain('min-h-0')
    expect(scrollRegion().className).toContain('flex-1')
    expect(scrollRegion().className).toContain('min-h-0')
    expect(actionBar().className).toContain('shrink-0')
  })

  it('the scrolling part is the only element with vertical overflow set to scroll or auto', async () => {
    stubApi(busyReport(), undefined, [discardedSale(1)])
    await mount()

    const scrollers = Array.from(container.querySelectorAll('*')).filter((el) =>
      VERTICAL_SCROLL.test(el.getAttribute('class') ?? '')
    )
    expect(scrollers).toEqual([scrollRegion()])
  })

  it('shows a visible, finger-wide scrollbar on the scrolling part', async () => {
    stubApi(baseReport())
    await mount()

    expect(scrollRegion().className).toContain('touch-scrollbar')
    expect(scrollRegion().className).not.toMatch(/scrollbar-(none|hidden)/)
  })

  it('renders every entry in the scrolling part, with no paging, and the counts match', async () => {
    stubApi(busyReport(), undefined, fiftyDiscarded())
    await mount()

    const region = scrollRegion()
    expect(region.querySelectorAll('input[type="checkbox"]')).toHaveLength(100)
    expect(region.textContent).toContain('MAN0000049')
    expect(region.textContent).toContain('CAR0000049')
    expect(region.querySelectorAll('[data-testid="discarded-held-sales"] tbody tr')).toHaveLength(50)
    expect(region.querySelectorAll('tbody tr')).toHaveLength(50 + 50 + 100)
    expect(container.textContent).not.toMatch(/Page \d+ of/)
    expect(actionBar().textContent).toContain('Approving 100 of 100 entries. 0 left out.')
    expect(actionBar().textContent).toContain('1,000')
  })

  it('the summary counts follow the ticks across the whole list', async () => {
    stubApi(busyReport())
    await mount()

    act(() => checkbox('MAN0000049').click())
    act(() => checkbox('CAR0000000').click())

    expect(actionBar().textContent).toContain('Approving 98 of 100 entries. 2 left out.')
  })

  it('Approve day approves exactly the report pendingIds, from the bar', async () => {
    const report = busyReport()
    stubApi(report)
    await mount()

    act(() => barButton().click())
    expect(container.textContent).toContain('Manager PIN Required')
    await authorizeWithPin()

    expect(window.api.approveDayReport).toHaveBeenCalledWith(
      expect.objectContaining({ approvedIds: report.pendingIds, excluded: [], managerId: 9, managerPin: '9999' })
    )
  })

  it('after approving, the reloaded day reads "Nothing pending" in the bar and the button is disabled', async () => {
    stubApi(busyReport(), () =>
      Promise.resolve({
        success: true,
        data: { approval: null, approvedCount: 100, excludedCount: 0, alreadyApproved: false }
      })
    )
    await mount()
    vi.mocked(window.api.getEndOfDayReport).mockResolvedValue({
      success: true,
      data: baseReport({ manualEntries: [], carryOver: [], pendingIds: [] })
    })

    act(() => barButton().click())
    await authorizeWithPin()
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain('100 approved, 0 left out.')
    expect(barButton().textContent).toBe('Nothing pending')
    expect(barButton().disabled).toBe(true)
  })

  it('the note field opens the shared keyboard from the bar', async () => {
    stubApi(baseReport())
    await mount()

    const noteInput = actionBar().querySelector('input[placeholder^="e.g."]') as HTMLInputElement
    act(() => noteInput.click())

    expect(useKeyboardStore.getState().request?.docked).toBe(true)
  })

  it('the fade appears only while more is below the visible part, and goes at the bottom', async () => {
    stubApi(busyReport())
    await mount()
    const fade = (): Element | null => container.querySelector('[data-testid="end-of-day-fade"]')
    expect(fade()).toBeNull()

    const region = scrollRegion()
    Object.defineProperty(region, 'scrollHeight', { configurable: true, value: 2000 })
    Object.defineProperty(region, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(region, 'scrollTop', { configurable: true, writable: true, value: 0 })
    act(() => {
      region.dispatchEvent(new Event('scroll'))
    })
    expect(fade()).not.toBeNull()
    expect(fade()?.getAttribute('aria-hidden')).toBe('true')

    region.scrollTop = 1600
    act(() => {
      region.dispatchEvent(new Event('scroll'))
    })
    expect(fade()).toBeNull()
  })
})
