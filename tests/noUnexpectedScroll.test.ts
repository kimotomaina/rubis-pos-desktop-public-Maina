/**
 * Phase E3 Commit item 3 (docs/phase-166): a screen root or modal
 * should not scroll internally — `npm run check:fit`'s CDP census is
 * the pixel-accurate proof of that against the real built app, but it
 * only runs on demand. This is the fast, always-on guard: a static
 * grep-style check over the actual screen/overlay files, so a newly
 * added `overflow-y-auto`/`overflow-scroll`/`overflow-auto` shows up in
 * a normal `npm test` run rather than being caught only when someone
 * remembers to run check:fit.
 *
 * The allow-list is deliberately an exact count per file, not just a
 * ceiling: a file dropping BELOW its listed count (the scroll was
 * fixed but the list wasn't updated) fails just as loudly as one going
 * over, so the list can never quietly drift out of date. Phase 166's
 * Commit E4 shrank it for `App.tsx`'s Orders wrapper, `PosCartTable`
 * and `ToastStack`; phase-167 Part B shrinks it again for `App.tsx`'s
 * Admin wrapper (the card grid, Part A, and the per-section fixes,
 * Part B item 2, made every Admin section fit without it) and for
 * `VariantModal` (paginated, Part B item 2, once `check:fit`'s new
 * synthetic 6-variant measurement found it genuinely overflowing).
 *
 * `overflow-x-auto`/`overflow-x-scroll` (horizontal-only, used for wide
 * data tables in several of these same files) are deliberately NOT
 * matched — that is an established, separate pattern in this codebase,
 * not the "does the whole screen scroll" question Phase E's rule is
 * about.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Matches `overflow-y-auto`, `overflow-y-scroll`, `overflow-auto`, `overflow-scroll` — never `overflow-x-*`. */
const VERTICAL_SCROLL_CLASS = /overflow-(?:y-)?(?:auto|scroll)\b/g

/** Strips `/** ... *\/`-style block comments so a class name merely *mentioned* in a doc comment isn't counted. */
function stripBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

function countVerticalScrollClasses(relativePath: string): number {
  const contents = readFileSync(join(process.cwd(), relativePath), 'utf8')
  const stripped = stripBlockComments(contents)
  return [...stripped.matchAll(VERTICAL_SCROLL_CLASS)].length
}

/**
 * Every screen root, gate, modal and admin sub-page in the renderer —
 * mirrors `scripts/check-fit.mjs`'s own screen coverage plus the pages
 * it doesn't drive by click (onboarding/gates), so the two checks
 * cover the same ground from different angles (static text vs. a real
 * render).
 */
const ALLOW_LIST: Record<string, number> = {
  [join('src', 'renderer', 'src', 'components', 'OnboardingScreen.tsx')]: 1, // Pre-login; out of scope for this phase.
  [join('src', 'renderer', 'src', 'components', 'LocationConfirmScreen.tsx')]: 1, // Pre-login; out of scope for this phase.
  [join('src', 'renderer', 'src', 'components', 'EtimsSetupGate.tsx')]: 1, // Pre-login; out of scope for this phase.
  [join('src', 'renderer', 'src', 'pages', 'EndOfDayPage.tsx')]: 1, // docs/phase-220: was 0 (ZERO_SCROLL_FILES), now 1. End of Day entries, owner's design, 2026-10-05.
  [join('src', 'renderer', 'src', 'components', 'OrderHistory.tsx')]: 1 // docs/phase-225: was 0 (ZERO_SCROLL_FILES), now 1. Order list scrolls, owner's request, 2026-10-05.
}

/** Files expected to have ZERO vertical-scroll classes — either always have, or (this commit) now do. */
const ZERO_SCROLL_FILES = [
  join('src', 'renderer', 'src', 'App.tsx'),
  join('src', 'renderer', 'src', 'components', 'LoginScreen.tsx'),
  join('src', 'renderer', 'src', 'components', 'LocationPendingScreen.tsx'),
  join('src', 'renderer', 'src', 'components', 'AdminScreen.tsx'),
  join('src', 'renderer', 'src', 'components', 'PosCartTable.tsx'),
  join('src', 'renderer', 'src', 'components', 'VariantModal.tsx'),
  join('src', 'renderer', 'src', 'components', 'ZReportModal.tsx'),
  join('src', 'renderer', 'src', 'components', 'ManagerPinModal.tsx'),
  join('src', 'renderer', 'src', 'components', 'PaymentModal.tsx'),
  join('src', 'renderer', 'src', 'components', 'ConnectivityModal.tsx'),
  join('src', 'renderer', 'src', 'components', 'RestartCountdownModal.tsx'),
  join('src', 'renderer', 'src', 'components', 'VirtualKeyboardModal.tsx'),
  join('src', 'renderer', 'src', 'components', 'ToastStack.tsx'),
  join('src', 'renderer', 'src', 'components', 'FiscalNotice.tsx'),
  join('src', 'renderer', 'src', 'pages', 'NeedsAttentionPage.tsx'),
  join('src', 'renderer', 'src', 'pages', 'MpesaLogsPage.tsx'),
  join('src', 'renderer', 'src', 'pages', 'StockTakePage.tsx'),
  join('src', 'renderer', 'src', 'pages', 'ReportsPage.tsx'),
  join('src', 'renderer', 'src', 'pages', 'MpesaReconciliationPage.tsx')
]

describe('no unexpected vertical scroll on a screen root or modal (docs/phase-166 Commit E3)', () => {
  it.each(Object.entries(ALLOW_LIST))('%s has exactly its allow-listed count', (path, expected) => {
    expect(countVerticalScrollClasses(path)).toBe(expected)
  })

  it.each(ZERO_SCROLL_FILES)('%s has none at all', (path) => {
    expect(countVerticalScrollClasses(path)).toBe(0)
  })
})
