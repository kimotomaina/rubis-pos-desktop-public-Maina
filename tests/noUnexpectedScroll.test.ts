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
 * over, so the list can never quietly drift out of date. It starts as
 * today's legitimate cases (this commit) and Commit E4 shrinks it for
 * every file this phase actually paginates — `PosCartTable` and
 * `ToastStack` are listed here (not omitted) for exactly that reason,
 * so Commit E4's own diff can show them dropping to zero by name.
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
  [join('src', 'renderer', 'src', 'App.tsx')]: 2, // Orders' and Admin's shared wrappers — both still needed until Order History (Orders') and the rest of Admin (Admin's) are paginated.
  [join('src', 'renderer', 'src', 'components', 'PosCartTable.tsx')]: 1, // The cart table's own scroll — Commit E4 replaces it with pagination.
  [join('src', 'renderer', 'src', 'components', 'ToastStack.tsx')]: 1, // The toast column's own scroll — Commit E4 replaces it with a 3-toast cap.
  [join('src', 'renderer', 'src', 'components', 'OnboardingScreen.tsx')]: 1, // Pre-login; out of scope for this phase.
  [join('src', 'renderer', 'src', 'components', 'LocationConfirmScreen.tsx')]: 1, // Pre-login; out of scope for this phase.
  [join('src', 'renderer', 'src', 'components', 'EtimsSetupGate.tsx')]: 1, // Pre-login; out of scope for this phase.
  [join('src', 'renderer', 'src', 'components', 'VariantModal.tsx')]: 1 // Not in this phase's pagination list.
}

/** Files expected to have ZERO vertical-scroll classes. */
const ZERO_SCROLL_FILES = [
  join('src', 'renderer', 'src', 'components', 'LoginScreen.tsx'),
  join('src', 'renderer', 'src', 'components', 'LocationPendingScreen.tsx'),
  join('src', 'renderer', 'src', 'components', 'AdminScreen.tsx'),
  join('src', 'renderer', 'src', 'components', 'OrderHistory.tsx'),
  join('src', 'renderer', 'src', 'components', 'ZReportModal.tsx'),
  join('src', 'renderer', 'src', 'components', 'ManagerPinModal.tsx'),
  join('src', 'renderer', 'src', 'components', 'PaymentModal.tsx'),
  join('src', 'renderer', 'src', 'components', 'ConnectivityModal.tsx'),
  join('src', 'renderer', 'src', 'components', 'RestartCountdownModal.tsx'),
  join('src', 'renderer', 'src', 'components', 'VirtualKeyboardModal.tsx'),
  join('src', 'renderer', 'src', 'components', 'FiscalNotice.tsx'),
  join('src', 'renderer', 'src', 'pages', 'NeedsAttentionPage.tsx'),
  join('src', 'renderer', 'src', 'pages', 'MpesaLogsPage.tsx'),
  join('src', 'renderer', 'src', 'pages', 'StockTakePage.tsx'),
  join('src', 'renderer', 'src', 'pages', 'EndOfDayPage.tsx'),
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
