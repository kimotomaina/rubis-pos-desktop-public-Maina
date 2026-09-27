# Phase 166 — auto-print failure toast, check:fit covers every screen, pagination instead of scrolling

Three commits, as briefed: **Commit 0** (auto-print failure toast),
**Commit E3** (`check:fit` covers every screen), **Commit E4**
(pagination instead of scrolling, emptying Commit E3's allow-list).
Hard rules held throughout: no fiscal-device command added or changed,
no change to the payment gate, no Shopify call, no SQL on real data.
Tripwires (fiscal suite, `mpesaPaymentGate.test.ts`, keyboard tests,
Phase E layout tests) run unmodified and pass. Every changed existing
assertion is listed by name, old value, new value, and why.

Commits: `d1b1cc9` (Commit 0), `e03a2c6` (Commit E3), `01aac6e` (Commit E4).

## Commit 0 — auto-print failure toast

`getAutoPrintOfflineMessage` (`autoPrintToast.ts`) previously returned
`null` for an outright print failure (the `receipt:print` IPC call
rejects or throws) — a cashier had no way to know a receipt never
printed at all. It now returns a distinct message for that case:

```ts
export const AUTO_PRINT_FAILURE_MESSAGE = 'Receipt did not print. Print it from Order History.'
export const AUTO_PRINT_OFFLINE_MESSAGE =
  'Printer offline. Receipt saved; print it from Order History when the printer is back.'

export function getAutoPrintOfflineMessage(result: ServiceResult<ReceiptPrintResult>): string | null {
  if (!result.success) return AUTO_PRINT_FAILURE_MESSAGE
  if (result.data?.mode !== 'pdf') return null
  return AUTO_PRINT_OFFLINE_MESSAGE
}
```

The PDF-fallback message is unchanged; a genuine physical/mock success
still shows nothing. `cartStore.ts`'s `triggerAutomaticPrint` gained a
small `showAutoPrintToast(message)` helper, called from both its
`.catch()` (a rejected promise) and its outer `catch` (a synchronous
throw) with `AUTO_PRINT_FAILURE_MESSAGE` — `checkoutStatus` is still
never touched by any of this, exactly as docs/phase-165 established.

**Changed existing assertion** — `tests/autoPrintToast.test.ts`:

- Test name: `'returns null for an outright failure — never surfaces as an error toast'`
  → `'returns the failure notice for an outright failure (docs/phase-166 Commit 0)'`.
- Assertion: `toBeNull()` → `toBe(AUTO_PRINT_FAILURE_MESSAGE)`.
- **Why**: this commit's own point — an outright failure now gets a
  message instead of being silently ignored.

**New tests**: `tests/cartStore.test.ts` gained a case where
`printReceipt` rejects outright — asserts the failure toast appears
while `checkoutStatus`/`checkoutError` stay exactly as the successful
checkout already set them, both immediately and after the rejection
settles (mirrors the existing "print that throws" test, plus the toast
assertion).

**Mutation test**: temporarily changed `getAutoPrintOfflineMessage`'s
failure branch back to `return null`. Ran
`tests/autoPrintToast.test.ts` + `tests/cartStore.test.ts` — exactly
the target pure-function test failed (`expected null to be 'Receipt did
not print...'`); the cartStore-level test still passed, because it
exercises the `.catch()`/throw path, which calls
`AUTO_PRINT_FAILURE_MESSAGE` directly rather than through the mutated
function — confirming the two tests genuinely cover different code
paths, not the same assertion twice. Restored, re-verified both green.

## Commit E3 — `check:fit` covers every screen

### 1–2. Screen list and the `RUBIS_CHECK_FIT_SIZE`-style test hook

`scripts/check-fit.mjs` previously measured only the POS/catalog screen
(Cash/M-Pesa) and the Admin Reports tab's six sub-views. It now also
covers, **reached by clicking, within the same 9-relaunch sweep**:

- Order History.
- Every other Admin tab: Overview, Peripherals, M-Pesa Logs, Needs
  Attention, Stock Take, End of Day, System, and Integrations' five
  sections (Shopify, Location, Fiscal Device, M-Pesa, Printer).
- VariantModal (a multi-variant catalog search), ZReportModal (a Shift
  History row), ManagerPinModal ("Save & Restart" in System),
  ConnectivityModal (the header's "Status" button → a status row).
- The on-screen keyboard's modal variant (any Admin text field) and its
  docked-sheet variant (the manual M-Pesa code field).

Four more screens a normal click-driven flow genuinely cannot reach are
each run **once, at the single tightest case only** (1366×768 @150%,
911×512 — the binding constraint for fitting; not across all 9 sizes,
to keep total runtime bounded):

- **Onboarding** — reached by simply not copying any app state into the
  throwaway launch (`copyAppState`'s own existing fallback, "no
  existing userData found — launching unconfigured", is exactly the
  real first-run condition).
- **LocationPendingScreen**, **EtimsSetupGate**, and **the fiscal
  notice paired with the toast stack at its limit** — reached via a
  new renderer test hook, `RUBIS_CHECK_FIT_SCREEN`, mirroring the
  existing `RUBIS_CHECK_FIT_SIZE` pattern exactly:
  - `src/main/index.ts`: `ipcMain.handle('checkFit:getForcedScreen', () => process.env['RUBIS_CHECK_FIT_SCREEN'] ?? null)`.
  - `src/preload/index.ts`/`window.d.ts`: `getCheckFitForcedScreen(): Promise<string | null>`.
  - `App.tsx`: fetches it once at mount into `checkFitForcedScreen`
    state (always `null` on a real launch); when it equals
    `'locationPending'`/`'etimsGate'`, an early return renders that
    screen directly after login, bypassing the real
    `locationConfirmed`/`etimsComplete` state; when it equals
    `'fiscalNoticeAndToastLimit'`, a `useEffect` seeds
    `cartStore.lastReceipt` with a synthetic `needs_fixing`/wrong-pin
    receipt (driving the real `FiscalNotice` component, not a fake) and
    pushes two synthetic routine toasts, so all three fill the stack's
    cap at once.
  - `scripts/check-fit.mjs`: `runForcedScreenCase(screenId, label)` and
    `runOnboardingCase()`, each their own throwaway
    launch/measure/teardown cycle, sharing a new `launchAndConnect`
    helper (the existing `runCase`'s own spawn logic is left
    untouched — see "Observed but not changed").

**Not measured, and why** (best-effort, each skipped with a note):

- **VariantModal** — this dev environment's real catalog has no
  multi-variant product matching any of 12 tried search letters after
  trying every visible dropdown row for each, not just the first.
- **The docked keyboard sheet** — this dev environment's real M-Pesa
  confirmation method isn't `'manual'` (nor `'daraja'` with manual
  entry enabled), so the code field that opens it never renders.
- **ZReportModal** — no shift has been closed yet in this dev
  environment's real, copied database, so Shift History has no row to
  click.

**Not measured at all** (documented in `check-fit.mjs`'s own header):
`LocationConfirmScreen` (the admin-role counterpart of
`LocationPendingScreen` — `screensFitDesignBox.test.ts` already guards
it against a hardcoded pixel dimension and smoke-mounts it),
`RestartCountdownModal` (would need a real manager-PIN completion plus
a config save against the throwaway copy — the PIN modal itself IS
measured, only the screen after it is skipped), and the orphaned
`MpesaReconciliationPage` (no nav path reaches it today).

### 3. The grep-based overflow test

New file `tests/noUnexpectedScroll.test.ts`: strips block comments from
each screen/modal file's source, counts occurrences of
`overflow-y-auto`/`overflow-y-scroll`/`overflow-auto`/`overflow-scroll`
(never `overflow-x-*`, an established, separate pattern for wide data
tables in several of the same files), and asserts an **exact** count
per file against an allow-list — dropping below the listed count fails
just as loudly as going over, so the list can never quietly drift out
of date.

As committed in E3, the allow-list reflected E3's own state (before
E4's pagination landed): `App.tsx` at 2 (Orders' and Admin's shared
wrappers), `PosCartTable.tsx` and `ToastStack.tsx` each at 1. Commit E4
shrinks all three to 0 — see Commit E4's own section below for the
exact diff.

### Two real bugs found while building this

Both surfaced only by actually running `npm run build && npm run
check:fit` against the real app — not by static reading:

1. **`NavStatusButton`'s status rows aren't clickable by their visible
   label text.** `clickWhereText(cmd, 'button', 'M-Pesa')` never
   matched, because each row's button also renders a trailing
   "Connected"/"Disconnected" detail `<span>` as a sibling of the label
   span — the button's whole `textContent` is `"M-PesaConnected"`, never
   exactly `"M-Pesa"`. **Fix**: match on the label span specifically
   (`button.querySelector('span.flex-1')?.textContent.trim() === 'M-Pesa'`),
   documented inline in the script.
2. **The first single-variant product tried always won**, so
   `tryOpenVariantModal` never got past the first dropdown row.
   **Fix**: for each search letter, try every visible row (up to
   `AUTOCOMPLETE_MAX_RESULTS`) before moving to the next letter,
   re-typing the query before each attempt (a successful single-variant
   click adds to cart and closes the dropdown). This still didn't find
   a multi-variant product in this dev catalog — see "not measured"
   above — but it is now a genuine, thorough search rather than a
   single guess.

### Verified against the real built app

All 247 cases: 220 measured (pass), 27 best-effort items skipped with
a reason (9 × VariantModal, 9 × docked keyboard, 9 × ZReportModal — one
of each per the 9 main-sweep sizes), 0 failures.

One real, legitimate scroller was found and allow-listed in
`check-fit.mjs`'s own `SCROLL_ALLOW_LIST` (a runtime allow-list,
separate from the static grep test's, matched by the scrolling
element's class): `App.tsx`'s shared Admin content wrapper
(`min-h-0 flex-1 overflow-y-auto px-6 pb-6`) genuinely scrolls at the
tightest sizes on Overview (~30–36px over), End of Day (~60–64px
over), and Integrations' Shopify (~31–33px over) and Fiscal Device
(~363–365px over) sections — none of which this phase's pagination
work touches.

## Commit E4 — pagination instead of scrolling

### Cart (7 lines/page)

`PosCartTable.tsx`: `CART_LINES_PER_PAGE = 7`; renders
`paginate(items, page, CART_LINES_PER_PAGE).items` instead of `items`,
with a new shared `Pager` below the table. A `useEffect` keyed on
`flashId` (the variant id most recently added/scanned, already threaded
in from `App.tsx`) jumps to `pageOfIndex(index, CART_LINES_PER_PAGE)`
— deliberately keyed on `flashId` alone, not `items`, so an unrelated
cart mutation while a flash is still technically active can't snap the
cashier back to that page mid-navigation. Removing the only line left
on a page steps back automatically, for free, via `paginate`'s own
clamping (`current = Math.min(Math.max(requested, 1), pageCount)`) —
no special-case code needed. The table's own `flex-1 overflow-y-auto`
is now plain `flex flex-1 flex-col`.

### Order History, Needs Attention, M-Pesa Logs (10 rows/page each)

Same `paginate()` + new shared `Pager` component
(`src/renderer/src/components/Pager.tsx`, extracted from
`ReportsPage.tsx`'s existing local `Pager` shape — that file's and
`EndOfDayPage.tsx`'s own copies are deliberately left as they are, out
of scope for this change). `App.tsx`'s Orders `<main>` wrapper changed
from `overflow-y-auto` to `overflow-hidden`, since `OrderHistory` is
the only thing it ever renders and now paginates its own list.

### Stock Take's counted lines (10/page, jump to the scanned line)

Same pattern as the cart: a new `lastRecordedVariantId` state, set in
`handleCount`'s success callback, drives a `useEffect` (keyed on itself
alone, same reasoning as the cart's) that jumps `linesPage` to the page
holding the just-recorded line.

### Product search dropdown

Already capped at 5 results (`AUTOCOMPLETE_MAX_RESULTS`, pre-existing —
not new to this phase). A new pure function, `hasMoreMatches`
(`posSearch.ts`), tells `PosSearchBar` when the underlying match count
exceeds the cap, and the dropdown now shows "Refine your search to see
more results" in that case.

### Toast stack (cap 3, FiscalNotice never dropped)

`ToastInput`/`ToastEntry` (`toastStore.ts`) gained an optional
`pinned?: boolean`, set only by `FiscalNotice`'s `show()` call — the
same "this one plays by different rules" pattern as its existing
`timeoutMs: null`. A new pure function, `visibleToasts(toasts, max = 3)`
(`toastVisibility.ts`), keeps every pinned toast and fills the
remaining slots with the most recently arrived routine ones, dropping
the oldest routine ones first; `ToastStack.tsx` renders
`visibleToasts(toasts)` instead of `toasts`, and its `max-h-[70vh]
overflow-y-auto` is now plain (nothing can exceed 3 toasts, so nothing
can need to scroll).

### Emptying Commit E3's allow-list

**Changed existing assertions** — `tests/noUnexpectedScroll.test.ts`
(committed by E3, edited here):

| File | Old | New | Why |
| --- | --- | --- | --- |
| `App.tsx` | `2` (`ALLOW_LIST`) | `1` (`ALLOW_LIST`) | Orders wrapper now `overflow-hidden` — Order History paginates its own list, so that wrapper can never need to scroll again. Admin's wrapper stays allow-listed (see Commit E3's real-measurement finding above). |
| `PosCartTable.tsx` | `1` (`ALLOW_LIST`) | `0` (moved to `ZERO_SCROLL_FILES`) | The cart table's own scroll is replaced by pagination. |
| `ToastStack.tsx` | `1` (`ALLOW_LIST`) | `0` (moved to `ZERO_SCROLL_FILES`) | The toast column's own scroll is replaced by the 3-toast cap. |

**Mutation test** (grep-based test, run against the final state):
temporarily re-added `overflow-y-auto` to `PosCartTable.tsx`. Ran
`tests/noUnexpectedScroll.test.ts` — exactly one test failed
(`src/renderer/src/components/PosCartTable.tsx has none at all`,
`expected 1 to be +0`); every other file's count was unaffected.
Restored, re-verified 24/24 green.

## Tests

- `tests/autoPrintToast.test.ts` — Commit 0's changed assertion (above)
  plus the existing three cases untouched.
- `tests/cartStore.test.ts` — new failure-toast case (Commit 0).
- `tests/noUnexpectedScroll.test.ts` (new, Commit E3; edited, Commit
  E4) — 24 cases: 5 allow-listed files at their exact count, 19 files
  (StockTake/NeedsAttention/MpesaLogs/etc.) at exactly zero.
- `tests/toastVisibility.test.ts` (new) — 7 cases for `visibleToasts`:
  under/at/over the cap, a pinned toast never dropped even when oldest,
  a pinned toast protected while routine ones are dropped to make room,
  original stacking order preserved, a custom `max`, and
  `MAX_VISIBLE_TOASTS === 3`.
- `tests/posCartTable.test.ts` (new) — real `react-dom/client` mount:
  exactly 7 rows per page, no pager at 7 or fewer lines, Next reveals
  the remainder, a flash jump to page 2, and removing the last line on
  page 2 steps back to page 1 automatically.
- `tests/orderHistoryPagination.test.ts`,
  `tests/needsAttentionPagination.test.ts`,
  `tests/mpesaLogsPagination.test.ts` (new, real mounts) — page size,
  no pager when everything fits, Next reveals the remainder, for each
  screen.
- `tests/stockTakePagination.test.ts` (new, real mount, same stubbing
  convention as `tests/stockTakePageKeypad.test.ts`) — page size, no
  pager when everything fits, and a full search → count → record flow
  that proves recording a line jumps the table to the page holding it.
- `tests/posSearch.test.ts` (new — fills a gap another file's comment
  already implied existed) and `tests/posSearchBarPagination.test.ts`
  (new, real mount) — `hasMoreMatches`'s pure logic, then the dropdown
  actually capping at 5 rows and showing the hint only when there were
  more.

## The four rules

Unaffected. No fiscal-device command was added or changed. No change
to the payment gate — `PaymentModal.tsx`, `checkout.ts` and every
fiscal/mpesa provider file are untouched (confirmed by `git diff
--stat`). No Shopify call. No SQL against real data — `check:fit`
launches only against a throwaway copy of this dev machine's own
userData (never the real one, per `check-fit.mjs`'s own long-standing
safety design), and every unit test uses `:memory:` databases or pure
functions. `tests/mpesaPaymentGate.test.ts` (24 tests) and the fiscal
suite (`fiscalIntegration.test.ts`, `fiscalEngine.test.ts`, etc.) run
unmodified and pass.

## Verify

```
$ npm run typecheck
(clean)

$ npx vitest run
Test Files: 138 passed (138)
Tests: 2048 passed (2048)

$ npm run build
(succeeds; verify-no-mock-provider.cjs confirmed clean)

$ npm run check:fit
All 247 case(s) fit with no overflow.
```

Each commit was also verified standalone before the next was made:
Commit E3 was staged, then E4's still-uncommitted changes were held
aside with `git stash` so `npx vitest run`/`npm run typecheck` ran
against the true Commit-E3-only tree (2017 tests, all passing,
including `noUnexpectedScroll.test.ts`'s E3-time allow-list) before the
stash was restored and E4 was built on top.

## Rollback

`git revert` each commit in reverse order (E4, then E3, then Commit 0)
— no schema change, no destructive migration. The only new IPC channel
(`checkFit:getForcedScreen`) is a test hook with no effect unless
`RUBIS_CHECK_FIT_SCREEN` is set, which no real launch ever does.

## Observed but not changed

- **`runCase`'s own spawn/CDP-connect logic in `check-fit.mjs` was left
  untouched** rather than refactored to share the new
  `launchAndConnect`/`loginAsAdminIfShowing` helpers built for the two
  new relaunch kinds — it already worked, and touching it risked the
  one part of this change with no unit-test safety net at all (only the
  real `check:fit` run itself proves it).
- **A pre-existing, unrelated bug**: `OrderHistory.tsx` imported
  `formatCurrency` from `'../lib/currency'` with no `.js` extension —
  valid under Vite's bundler resolution (how the real app always ran),
  but invalid under `tsconfig.node.json`'s NodeNext resolution (how
  `tests/**` compiles), and no test had ever imported this component
  directly before this phase's `posCartTable`-style real mounts.
  Fixed (`'../lib/currency.js'`) since it was a one-line, unambiguous
  correction blocking `npm run typecheck` — otherwise unrelated to this
  phase's actual work.
- **`ManagerPinModal`'s numpad and admin/staff dropdowns were never
  exercised** by `check:fit`'s `System > Save & Restart` case — the
  script only opens the modal and clicks Cancel, deliberately never
  entering a PIN or submitting, so no config write happens against the
  throwaway copy.
- **The App.tsx `checkFitForcedScreen` hook's own renderer-side wiring
  has no dedicated unit test**, matching the existing, already-accepted
  pattern for `RUBIS_CHECK_FIT_SIZE`'s equivalent main-process wiring
  (`parseCheckFitSize`) — its own verification is the real `check:fit`
  run itself, which did exercise all three of its branches
  (`locationPending`, `etimsGate`, `fiscalNoticeAndToastLimit`)
  successfully.
- **Reports' and End of Day's own local `Pager` implementations** were
  not migrated to the new shared `Pager` component, to avoid touching
  already-working, already-tested code outside this phase's explicit
  scope.
- **The Admin content wrapper (`App.tsx`) still relies on scrolling**
  for Overview, End of Day, and two Integrations sections at the
  tightest supported sizes — real, current behaviour, not a regression,
  and out of this phase's explicit pagination list. A future phase
  extending pagination to those screens would let this allow-list entry
  finally reach zero.

STOP for review, per the brief.
