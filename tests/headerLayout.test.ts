/**
 * The logged-in header's shrink behavior (phase-142's overflow finding;
 * Phase E2(a)) — every header child was `shrink-0`, so its minimum
 * width was the sum of all of them with nothing able to give: ~1331px
 * online, ~1470px offline (the "Offline — sales will queue" pill was
 * wider than "Online"), overflowing the 1366px design width.
 *
 * `App.tsx` boots the full app shell (barcode scanner, five Zustand
 * stores, several `window.api` calls at mount) — heavier to mount than
 * the value a real DOM render would add here, so this is a source
 * inspection in the `stockTakeGuard.test.ts` style: it fails the moment
 * the header's shrink/truncation classes, or the offline pill's fixed
 * width, regress.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const APP_TSX = readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'App.tsx'), 'utf8')

/** The header markup only, so a match elsewhere in the file can't false-pass these checks. */
const HEADER = APP_TSX.slice(APP_TSX.indexOf('<header'), APP_TSX.indexOf('</header>'))

describe('logged-in header shrinks to fit 1366px (Phase E2(a))', () => {
  it('lets the right-hand cluster shrink instead of forcing the header wider', () => {
    expect(HEADER).toMatch(/className="flex min-w-0 flex-1 items-center justify-end gap-4/)
  })

  it('truncates the staff name instead of reserving its full unbounded width', () => {
    expect(HEADER).toMatch(/className="flex min-w-0 items-center gap-2"/)
    expect(HEADER).toMatch(/className="max-w-40 truncate font-medium text-slate-700"/)
  })

  it('hides the role chip below the 2xl breakpoint', () => {
    expect(HEADER).toMatch(/hidden shrink-0 rounded-full bg-slate-100[^"]*2xl:inline-block/)
  })

  it('renders the Online and Offline pills at the same fixed width, so offline is never wider', () => {
    const pillClasses = [...HEADER.matchAll(/className="flex (w-\d+) shrink-0 items-center justify-center/g)].map(
      (m) => m[1]
    )
    expect(pillClasses).toHaveLength(2)
    expect(pillClasses[0]).toBe(pillClasses[1])
  })

  it('shortens the offline pill\'s on-screen text and keeps the full message in title/aria-label', () => {
    expect(HEADER).toContain('title="Offline — sales will queue"')
    expect(HEADER).toContain('aria-label="Offline — sales will queue"')
    // The on-screen text node is just "Offline" — not the full sentence.
    const offlineBranch = HEADER.slice(HEADER.indexOf('title="Offline'))
    expect(offlineBranch.slice(0, 400)).toMatch(/>\s*Offline\s*</)
    expect(offlineBranch.slice(0, 400)).not.toContain('sales will queue<')
  })

  it('leaves the two "Admin" occurrences as distinct elements (staff name vs. nav tab) — not a fixable duplicate', () => {
    // The staff-name span and the nav <button>Admin</button> are separate
    // elements reading different state (currentStaff.name vs. a static
    // label); phase-142 flagged this as cosmetic only, confirmed still
    // true and deliberately left alone.
    expect(APP_TSX).toMatch(/>\s*\{currentStaff\.name\}\s*</)
    expect(APP_TSX).toMatch(/>\s*Admin\s*<\/button>/)
  })
})

describe('ConnectivityBadges collapse to icons below 2xl (Phase E2(a))', () => {
  const badges = readFileSync(
    join(process.cwd(), 'src', 'renderer', 'src', 'components', 'ConnectivityBadges.tsx'),
    'utf8'
  )

  it('hides every badge label below 2xl, keeping the glyph always visible', () => {
    const labels = ['M-Pesa', 'Fiscal Server', 'Scanner', 'Printer']
    for (const label of labels) {
      expect(badges).toContain(`<span className={LABEL_CLASS}>${label}</span>`)
    }
    expect(badges).toMatch(/LABEL_CLASS = 'hidden 2xl:inline'/)
  })
})
