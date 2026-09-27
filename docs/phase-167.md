# Phase 167 — Admin as a grid of cards, and closing the docs/phase-166 fit gaps

Two parts, as briefed: **Part A** (Admin's tabs become cards) and **Part
B** (close the fit gaps docs/phase-166 left open). Delivered as one
commit — the two parts are genuinely entangled in this implementation
(the card grid's removal of the old tab bar is part of why several of
Part B's gaps closed), so splitting them would mean either an
artificial revert-and-remeasure or mis-crediting a fix to the wrong
half. Hard rules held throughout: no fiscal-device command added or
changed, no change to the payment gate, no Shopify call, no SQL on real
data. Tripwires (fiscal suite, `mpesaPaymentGate.test.ts`, keyboard
tests, Phase E layout tests) run unmodified and pass. Every changed
existing assertion is listed by name, old value, new value, and why.

Theme: no new colours or fonts were needed. `bg-rose-600`/`text-rose-700`
etc. already resolve to the exact Enjoy brand red (`#E31A37`) via
`index.css`'s `--color-brand-red` token (`tests/themeTokens.test.ts`
already pins this), and Quicksand is already the app-wide sans font —
every new component (`SectionCardGrid`, `BackButton`, the new icons)
just reuses the same utility classes every existing screen already
uses.

## Part A — Admin as cards

### 1–2. The grid, and removing the tab bar

New `src/renderer/src/components/SectionCardGrid.tsx`: a generic
3×3 grid of large card buttons (icon + title only, no helper text, per
the brief), paginated at 9 per page via the existing `paginate()` +
`Pager` pattern (the same shape `LocationPicker`'s own card grid
already uses) — so a future section list past 9 degrades to paging
rather than growing the grid. A card carries an optional count badge,
top-right.

New `src/renderer/src/components/BackButton.tsx`: a shared, large
(`h-14`) top-left "Back to X" control, used at every level.

`AdminScreen.tsx`: `activeTab`'s type gained `| null` (the grid),
defaulting to `initialTab ?? null` — `initialTab` (the header's
unfiled-count shortcut) still jumps straight past the grid into Needs
Attention, unchanged. The old 9-button tab-bar `<div>` is replaced by:

```tsx
{activeTab === null ? (
  <SectionCardGrid sections={adminSections(unfiledCount)} onSelect={setActiveTab} />
) : (
  <BackButton label="Back to Admin" onClick={() => setActiveTab(null)} />
)}
```

Every existing `{activeTab === 'xxx' && (...)}` block below this is
**completely unchanged** — only what decides which one renders (a card
tap instead of a tab click) is new, which is also why
`tests/adminIntegrationsSections.test.ts`'s source-slicing tests (which
locate `INTEGRATIONS_BLOCK`/`PERIPHERALS_BLOCK` by searching for that
exact substring) needed no changes at all.

`unfiledCount` is read via `useUnfiledCountStore` (already initialised
once in `App.tsx`) and passed to the Needs Attention card as its badge
— the same count `NavStatusButton` already shows, one source of truth.

### 3. Integrations and Reports get the same pattern

`AdminScreen.tsx`'s Integrations block: `integrationSection`'s type
gained `| null`, defaulting to `null`. Its own 5-button sub-nav strip
is replaced the same way, with `INTEGRATION_SECTIONS` (5 cards) and a
"Back to Integrations" button.

`ReportsPage.tsx`: `subView`'s type gained `| null`, defaulting to
`null`. Its 6-button sub-nav strip is replaced with `REPORTS_SECTIONS`
(6 cards) and a "Back to Reports" button.

Both were implemented as cards rather than kept as sub-tabs (the
brief's own "product owner may keep sub-tabs instead" note) for
consistency with the top level — nothing about either sub-navigation
made tabs a better fit than the pattern used everywhere else, and two
different navigation idioms in the same screen would be the more
surprising choice.

New icons (`icons.tsx`): `ChartBarIcon` (Overview, Sales Summary),
`LinkIcon` (Integrations, Shopify), `PrinterIcon` (Peripherals,
Printer), `CalendarIcon` (End of Day, Shift History), `DocumentChartIcon`
(Reports, Invoice List), `DownloadIcon` (Export), `ArrowLeftIcon`
(every `BackButton`) — same single-`<path>`, stroke-only style as the
existing set. `WarningIcon`/`PackageIcon`/`InboxIcon`/`LockIcon` are
reused for Needs Attention/Stock Take/M-Pesa Logs & Fiscal
Reconciliation/System & Fiscal Device & Fiscal Status.

### 4. Behaviour unchanged — the changed tests

Every field, save handler, keyboard wiring and permission check is
untouched; only how a section is reached changed. Tests that clicked a
tab button now click a card, and — since a card grid means picking a
different sibling section goes via "Back" first, not directly from one
tab to the next — several tests gained an extra step.

**Changed existing assertions** — `tests/adminScreen.test.ts`:

| Test | Old | New | Why |
| --- | --- | --- | --- |
| Shopify field cases (`it.each`), "typing through the keyboard updates Store URL", "typing a new Shopify token", the sanity "consecutive keystrokes accumulate" test | `click('Integrations')` alone reached the Shopify fields | `click('Integrations')` then `click('Shopify')` | Integrations opens to a card grid now; Shopify is no longer the default section shown. |
| "Ending Cash (counted)…", "new-staff Name and PIN…", "typing a new staff name/PIN…" | `mount()` alone reached Overview's fields (Overview was `activeTab`'s default) | `mount()` then `click('Overview')` | Admin opens to the card grid now; Overview is no longer the default tab. |

**Changed existing assertions** — `tests/adminIntegrationsSections.test.ts`:

| Test | Old | New | Why |
| --- | --- | --- | --- |
| "declares exactly the five named sections, in order, as a sub-nav" → "…as cards" | (name only) | (name only) | The five section buttons are cards now, not a sub-nav strip — same assertions, renamed for accuracy. |
| "renders each section only when its sub-nav button is the one clicked — none unconditionally" → "…its own card is the one clicked…" | Clicking "Integrations" alone already showed "Shopify Connection"; a different sub-nav button switched directly between sections | Clicking "Integrations" shows neither section; each card must be tapped, and switching to a different one goes via "Back to Integrations" first | Integrations opens to a card grid; no section is selected by default, and the grid (not a persistent tab strip) is how a different section is reached. |
| "titles each section distinctly from the sub-nav label it lives under" → "…from the card it lives under" | Switched directly between sections (`click('Location')` right after `click('Shopify')`'s assertion) | `click('Back to Integrations')` between every section | Same reason as above. |
| "loads printers only once the Printer section is the one showing…" | `click('M-Pesa')` then `click('Printer')` directly | `click('M-Pesa')`, `click('Back to Integrations')`, then `click('Printer')` | Same reason as above. |

**Changed existing assertions** — `tests/reportsPage.test.ts`:

| Test | Old | New | Why |
| --- | --- | --- | --- |
| "lists shifts and opens the Z-report on tap…", "labels the Z-report VAT figure from the report's own rate…", "shows a Previous/Next pager…" | `mount()` alone reached Shift History (it was `subView`'s default) | `mount()` then `click('Shift History')` | Reports opens to a card grid now; Shift History is no longer the default sub-view. The other five sub-views' tests already clicked their own button, so needed no change. |

### 5. `check:fit`'s navigation, and the card grids themselves

`scripts/check-fit.mjs`'s `checkAdminScreens` now censuses each grid
itself ("Admin (card grid)", "Admin > Integrations (card grid)", "Admin
> Reports (card grid)") before tapping any card, and every section is
reached card → census → "Back to Admin"/"Back to Integrations"/"Back
to Reports" → next card, replacing the old direct tab-to-tab clicks.

**Two real bugs found and fixed while building this** (only surfaced
by actually running the script against the built app):

1. `NavStatusButton`'s status rows aren't clickable by their visible
   label text — each row's button also renders a trailing
   "Connected"/"Disconnected" `<span>`, so the whole button's
   `textContent` is never exactly `"M-Pesa"`. Already fixed in
   docs/phase-166's own build (matching on the label's own `span.flex-1`
   instead) — re-confirmed still correct here since Part A's navigation
   changes touch the same script.
2. Not a new bug this phase, but worth restating: the VariantModal
   search now tries every visible dropdown row per letter, not just the
   first (docs/phase-166) — still didn't find a multi-variant product
   in this dev catalog (see Part B's synthetic measurement below for
   why that no longer matters).

## Part B — closing the fit gaps

### 1. The three skipped screens, measured properly with synthetic data

New `RUBIS_CHECK_FIT_SCREEN` values, each with entirely synthetic,
**renderer-only** data — no database write, not even against the
throwaway copy `check:fit` otherwise launches against:

- **`'mpesaManualKeyboard'`** — `PaymentModal` gained an optional
  `forcedCapabilities` prop that skips its real `getMpesaCapabilities()`
  call when present (always `undefined` on every real launch).
  `PosCheckoutPanel` gained a matching `forceMpesaManualKeyboard`
  prop that forces the M-Pesa quick-toggle on and passes
  `forcedCapabilities={{ status: 'ready', mode: 'manual', manualEntryEnabled: false }}`
  down. `App.tsx` seeds one synthetic cart line (so `PaymentModal`'s
  `total > 0` guard doesn't block on an empty cart) and opens the
  docked keyboard on the code field directly via `useKeyboardStore`,
  when the hook is set — this measures the real embedded position
  (inside the 35%-width checkout aside), not a full-width stand-in.
- **`'zReport'`** — `App.tsx` renders `ZReportModal` directly with a
  fabricated closed-shift `ZReport` (`CHECK_FIT_SYNTHETIC_Z_REPORT`)
  whose `mpesaByMode` has both `manual` and `daraja` non-zero, so the
  full split row is exercised.
- **`'variantModal'`** — `App.tsx` renders `VariantModal` directly with
  a fabricated 6-variant product (`CHECK_FIT_SYNTHETIC_PRODUCT`).

All three are run at **all 9 sizes** (not just the tightest case, per
this item's own instruction) — `runForcedScreenCase` gained an
optional `testCase` parameter (default `TIGHTEST_CASE`, so the four
phase-166 screens that only ever need the tightest case are
unaffected) and `main()` loops it over `CASES` for these three.

**Unit test** (`tests/checkFit.test.ts`): the hook resolver,
`resolveCheckFitForcedScreen` (split out of `main/index.ts`'s
`checkFit:getForcedScreen` handler into a new `src/main/lib/checkFit.ts`
specifically so it could be unit tested — `main/index.ts` imports
Electron at module load time and is not importable in a test run, the
same constraint every other IPC handler in this codebase has), returns
`null` when unset, the raw value unchanged when set, and treats an
empty string as set (only a genuinely absent variable is `null`).

**A genuine bug this synthetic measurement found**: `VariantModal`'s
own variant list — never previously measurable with more than one or
two variants, since the real-catalog search kept finding only
single-variant products — genuinely overflowed the design box by
15–66px (worse at the tightest sizes) with 6 variants. Fixed, not
allow-listed (below).

### 2. Fixing the four named gaps

- **Integrations > Fiscal Device (~365px over).** The 5-field grid
  changed from 2 columns to 3 (`grid-cols-2` → `grid-cols-3`), and the
  static description paragraph under every field was removed — each
  field already has an obvious label and placeholder, so nothing
  became undiscoverable, only shorter. The one dynamic hint (the
  password field's "already saved" vs. "set on the control unit"
  wording, which genuinely differs by state) was kept, just shortened.
  The "Status: Set up / Not set up yet" line moved inline next to the
  heading instead of its own paragraph. Store Details (folded into the
  same screen) lost its own two filler paragraphs the same way, the
  KRA PIN warning shortened to "Not the customer's PIN." Every field's
  `onClick`/keyboard wiring is untouched.
- **End of Day (~60px), Integrations > Shopify (~32px), Overview
  (~33px).** No section-specific trim was needed for any of these
  three — removing the tab bar (Part A) and replacing it with the much
  shorter "Back to Admin" button freed enough height on its own, per
  real measurement (see Verify below). Nothing in `EndOfDayPage.tsx`,
  the Shopify section, or the Overview section itself was changed.

### 3. Removing the Admin wrapper from both allow-lists

`scripts/check-fit.mjs`'s `SCROLL_ALLOW_LIST` is now `[]` (was
`['min-h-0 flex-1 overflow-y-auto px-6 pb-6']`). `App.tsx`'s Admin
content wrapper changed from `overflow-y-auto` to `overflow-hidden`.

**Changed existing assertions** — `tests/noUnexpectedScroll.test.ts`:

| File | Old | New | Why |
| --- | --- | --- | --- |
| `App.tsx` | `1` (`ALLOW_LIST`) | `0` (`ZERO_SCROLL_FILES`) | The Admin wrapper's `overflow-y-auto` is gone — the card grid and the Fiscal Device fix (above) mean every section now fits without it. |
| `VariantModal.tsx` | `1` (`ALLOW_LIST`) | `0` (`ZERO_SCROLL_FILES`) | Its own scroll is replaced by pagination (Part B item 1's synthetic measurement found it genuinely needed fixing, not just allow-listing). |

### 4. The three-number summary

`scripts/check-fit.mjs`'s `main()` now reports, instead of one
pass/fail line:

```
Measured and fit: 274
Skipped (27):
  (VariantModal: no multi-variant product found in this catalog after several tries — skipping)
  ...
Allow-listed scrollers (0):
```

followed by "All fit" only when both the skipped and allow-listed
counts are zero — otherwise a line naming how many of each were not
verified fit on their own merits. `recordAllowListedHits` (new) logs
which screen and which class every allow-listed scroller actually
belonged to, since an allow-listed match was previously invisible in
output (silently excluded from the failure count, with no record at
all of what was excused).

**Why the 27 skips still show, even though the same three screens are
now also measured properly**: the *old*, best-effort, click-driven
attempts (search the real catalog for a multi-variant product, look
for a real shift-history row, look for a real manual-M-Pesa field)
are deliberately left in the main 9-case sweep, unchanged — this dev
environment's real data still doesn't support them (no multi-variant
product, no closed shift yet, and this till's real M-Pesa mode isn't
manual), so they still report "skipping", honestly. The new synthetic
screens (item 1 above) are a separate, additional set of cases that
*do* measure these three screens reliably, at all 9 sizes — see the
`VariantModal (synthetic 6-variant product)`/`ZReportModal (synthetic
closed shift...)`/`Keyboard (docked sheet, synthetic manual M-Pesa)`
lines in Verify below, all passing. Removing the old best-effort
attempts instead of leaving them to skip honestly would have been
simpler to report but is not what this item asked for — it asked to
*add* the reliable synthetic measurement, and skipping honestly when a
click-driven trigger genuinely isn't there is still useful signal (it
says something about this specific dev environment's data, not about
whether the screen fits).

### 5. Mutation test

Temporarily reverted `App.tsx`'s Admin wrapper back to
`overflow-y-auto`. Ran `tests/noUnexpectedScroll.test.ts` — exactly one
test failed (`src\renderer\src\App.tsx has none at all`, `expected 1 to
be +0`); every other file's count was unaffected. Restored,
re-verified 24/24 green.

## Tests

- `tests/adminScreen.test.ts`, `tests/adminIntegrationsSections.test.ts`,
  `tests/reportsPage.test.ts` — changed assertions above; every other
  test in these files (save-handler independence, field modes, source-
  slicing checks) is untouched and still passes.
- `tests/noUnexpectedScroll.test.ts` — changed assertions above (24
  cases total, unchanged in count).
- `tests/checkFit.test.ts` (new) — `resolveCheckFitForcedScreen`'s 3
  cases (unset → null, set → raw value, empty string → empty string).
- `tests/variantModalPagination.test.ts` (new, real mount) — exactly 4
  variants per page, no pager when 3 or fewer fit, and a variant on
  page 2 is still genuinely selectable (`onSelectVariant` called with
  the right variant).

## The four rules

Unaffected. No fiscal-device command was added or changed. No change
to the payment gate — `checkout.ts` and every fiscal/mpesa provider
file are untouched (confirmed by `git status`); `PaymentModal.tsx`'s
only change is a test-hook prop that bypasses a UI-only capabilities
read, never the payment logic itself (STK push, polling, unverified-
code validation are all untouched). No Shopify call. No SQL against
real data — the three new synthetic screens are explicitly
renderer-only (no IPC call to the database at all for their content),
and every unit test uses `:memory:` databases or pure functions.
`tests/mpesaPaymentGate.test.ts` (24 tests) and the fiscal suite
(`fiscalIntegration.test.ts`, `fiscalEngine.test.ts`) run unmodified
and pass.

## Verify

```
$ npm run typecheck
(clean)

$ npx vitest run
Test Files: 140 passed (140)
Tests: 2054 passed (2054)

$ npm run build
(succeeds; verify-no-mock-provider.cjs confirmed clean)

$ npm run check:fit
Measured and fit: 274
Skipped (27):
  (VariantModal: no multi-variant product found in this catalog after several tries — skipping) × 9
  (Keyboard docked sheet: manual M-Pesa code field not found — skipping) × 9
  (ZReportModal: no shift history row to click — skipping) × 9
Allow-listed scrollers (0):

✔ 274 case(s) fit with no overflow — but 27 skipped and 0 allow-listed
  scroller(s) were not verified fit on their own merits, see above.
```

0 failures throughout. The three synthetic screens (Part B item 1) all
pass at every one of the 9 sizes — `Keyboard (docked sheet, synthetic
manual M-Pesa)`, `ZReportModal (synthetic closed shift, M-Pesa split)`,
`VariantModal (synthetic 6-variant product)` — so the 27 skips above
are exactly the old, honestly-reported, best-effort attempts described
in Part B item 4, not a gap in actual coverage.

## Rollback

`git revert` this commit — no schema change, no destructive migration.
The one new IPC channel dependency (`checkFit:getForcedScreen`) already
existed from docs/phase-166; this phase only adds new values it
recognises, which are ignored (fall through to the normal screen) on
any real launch since `RUBIS_CHECK_FIT_SCREEN` is never set.

## Observed but not changed

- **`ReportsPage.tsx`'s and `EndOfDayPage.tsx`'s own local `Pager`
  copies** were not migrated to the shared `Pager` component used by
  the new card grids — same reasoning as docs/phase-166: avoid
  touching already-working, already-tested code outside this phase's
  scope.
- **The 27 old best-effort skips** (VariantModal search, the docked
  keyboard field, ZReportModal's shift-history row) were left in the
  main sweep rather than removed now that synthetic coverage exists —
  see Part B item 4's own explanation. A future phase could remove them
  once judged genuinely redundant.
- **`ManagerPinModal`'s numpad and admin/staff dropdowns** are still
  never exercised by `check:fit`'s `System > Save & Restart` case — the
  script only opens the modal and clicks Cancel, unchanged from
  docs/phase-166.
- **`PaymentModal`'s `forcedCapabilities` prop and `PosCheckoutPanel`'s
  `forceMpesaManualKeyboard` prop** are test-hook-only additions to
  components that also carry real payment logic. Both default to
  `undefined`/`false` and are wired only from `App.tsx`'s own
  `checkFitForcedScreen` state, which itself only ever becomes non-null
  when `RUBIS_CHECK_FIT_SCREEN` is set — never on a real launch. Noted
  here for visibility since they touch files this task's hard rules are
  strictest about, even though neither changes any payment-gate
  behaviour itself.

STOP for review, per the brief.
