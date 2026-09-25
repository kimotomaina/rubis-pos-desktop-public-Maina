/**
 * The logged-in header's shrink behavior (phase-142's overflow finding;
 * Phase E2(a), later superseded for the status cluster by the
 * `NavStatusButton` consolidation) — every header child was `shrink-0`,
 * so its minimum width was the sum of all of them with nothing able to
 * give: ~1331px online, ~1470px offline, overflowing the 1366px design
 * width.
 *
 * `App.tsx` boots the full app shell (barcode scanner, five Zustand
 * stores, several `window.api` calls at mount) — heavier to mount than
 * the value a real DOM render would add here, so this is a source
 * inspection in the `stockTakeGuard.test.ts` style: it fails the moment
 * the header's shrink/truncation classes regress. `NavStatusButton`
 * itself (the Online/Offline, unfiled-sales and connectivity rows that
 * used to render directly in the header) is covered by a real mount in
 * `tests/navStatusButton.test.ts` instead — it has no heavy fan-out, so
 * a real DOM test is stronger evidence there than source inspection.
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

  it('consolidates status into a single NavStatusButton instead of separate pills/badges', () => {
    expect(HEADER).toContain('<NavStatusButton')
    expect(HEADER).not.toMatch(/\bConnectivityBadges\b/)
    expect(HEADER).not.toMatch(/\bUnfiledSalesBadge\b/)
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
