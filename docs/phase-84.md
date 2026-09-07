# Phase 84 — Task 2 (revised): unified toast stack, Apply

Builds the design `docs/phase-83.md` proposed and the review approved,
plus the two adjustments from that review: a column-height cap, and the
fiscal notice being close-button-only rather than "generous timeout"
until Step 4 exists.

## What was built

### The shared system

- **`stores/toastStore.ts`** (new, Zustand — matches `cartStore`/
  `connectivityStore`'s convention) — `toasts: ToastEntry[]`, `show(input)`
  (upserts by `id`: replaces an existing entry **in place**, same index,
  rather than appending a duplicate or moving it to the end; stamps a
  fresh `updatedAt` on every call, including a replace with otherwise-
  identical fields), `dismiss(id)`.
- **`lib/toastTimeouts.ts`** (new) — every toast's duration as a named,
  exported constant, each with a comment explaining the choice:
  `CONNECTIVITY_TOAST_TIMEOUT_MS` (5000, unchanged), `SCAN_TOAST_TIMEOUT_MS`
  (2500, unchanged), `SALE_COMPLETE_TOAST_TIMEOUT_MS` (5000),
  `UPDATE_TOAST_TIMEOUT_MS` (5 minutes), `FISCAL_NOTICE_TIMEOUT_MS`
  (`null` — see below).
- **`components/ToastShell.tsx`** (new) — pure presentation for one
  entry: tone-colored chrome, the message, `actions` rendered below when
  present, and an **unconditional** × button (no prop hides it — "every
  toast is dismissible" is structural, not a per-entry choice). Owns its
  own countdown (`setTimeout` keyed on `[timeoutMs, updatedAt]` — the
  `updatedAt` dependency is what makes a toast's timer reset on new
  activity even when the timeout's numeric value is unchanged, e.g.
  `UpdateToast` re-showing on every download-progress tick). The × click
  and the timer call the exact same `toast.onDismiss` — the shell has no
  opinion on what dismissal means.
- **`components/ToastStack.tsx`** (new) — the only component that
  renders a toast on screen. Mounted once at the `App.tsx` root, `fixed
  left-1/2 top-4 -translate-x-1/2 z-50`, vertical column, new entries
  appended at the end (an existing toast never jumps position when
  another arrives). **Column height cap** (per review): `max-h-[70vh]
  overflow-y-auto` — the simpler of the two options offered, since it
  handles any number of simultaneous toasts with one CSS rule rather
  than a "how many do I show" count to maintain.

### Every existing producer migrated — trigger and content unchanged

`ConnectivityToast`, `UpdateToast`, and `FiscalNotice` keep their exact
existing trigger (the IPC listener, the `cartStore` selector) and their
exact existing content-decision logic. The only change in each: instead
of rendering its own `fixed` div, it calls `toastStore.show()`/
`dismiss()` and returns `null`.

- **`ConnectivityToast.tsx`** — lost its own local `toasts` array and
  `setTimeout` bookkeeping entirely (the shell now owns that); the
  debounce logic (`lib/connectivityToasts.ts`, unchanged) still decides
  whether a status change fires a toast. Now has a close button, which
  it never had.
- **The barcode/search-feedback toast** (folded in per review, having
  been found during the audit and not in either original brief) — was
  inline `App.tsx` state (`scanToast`) with its own `fixed bottom-6
  left-1/2` render and 2500ms `setTimeout`. Same treatment: the six
  `setScanToast(...)` call sites became a `showScanToast(kind, message)`
  helper that calls `toastStore.show()` with a fixed `id: 'scan'` (so a
  rapid re-scan replaces in place) and `SCAN_TOAST_TIMEOUT_MS`. The old
  inline render block and the `ScanToast` interface are gone.
- **`UpdateToast.tsx`** — behavior change, approved: it now has a
  timeout (`UPDATE_TOAST_TIMEOUT_MS`, 5 minutes) where it previously had
  none. Because the toast is re-shown on every `download-progress` IPC
  event (unchanged trigger) and each `show()` call stamps a fresh
  `updatedAt`, an active download keeps re-arming the timer — it can
  only actually count down once events go idle (i.e. after the terminal
  "ready to install" state has sat unacknowledged for the full 5
  minutes). The × dismisses the toast only; it has no path to
  `autoUpdater` at all, so it cannot affect whether or when the update
  installs — confirmed in the audit that `autoInstallOnAppQuit` defaults
  to `true` and is never overridden, so the update installs on the next
  normal app restart regardless.
- **`FiscalNotice.tsx`** — kept its `cartStore` trigger, its
  `getFiscalNotice`-derived content, its once-per-`localId` gating, and
  its existing `dismiss()` function (sets `dismissedLocalId`, clears the
  PIN-editing state) — now also calling `toastStore.dismiss('fiscal-notice')`.
  Its message and its wrong-PIN fix-and-resend buttons render through the
  shared shell (`message` / `actions`).

  **The standing exception, as directed**: `timeoutMs` is **always**
  `FISCAL_NOTICE_TIMEOUT_MS` (`null`) — not a generous-but-suspendable
  duration as phase-83 first proposed. The reasoning is in a comment on
  the constant itself: the sale's `needs_fixing`/`waiting` status is
  already durable on the order row before the notice ever renders, so
  nothing is lost if it disappears — but until Step 4's back-office list
  exists, this toast is the *only* place a flagged sale surfaces to a
  person, and with the device password currently wrong every sale flags
  `waiting`. An auto-timeout risked a flagged sale scrolling away
  unseen with no other way to find it. The × button (and, for a
  wrong-PIN rejection, "Send to Office") remain the only way it goes
  away. Revisit once Step 4 lands.

### New: the sale-complete toast

- **`lib/saleCompleteToast.ts`** (new, pure, mirrors `fiscalNotice.ts`) —
  `getSaleCompleteMessage(receipt)`: `null` whenever `getFiscalNotice`
  already has something to say (so the two can never contradict each
  other — both read the same derivation off the same receipt); otherwise
  `'Sale complete - tax receipt issued.'` when fiscalized, or plain
  `'Sale complete.'` when fiscalization was never attempted
  (`fiscalStatus: null`).
- **`components/SaleCompleteToast.tsx`** (new) — reads `cartStore.lastReceipt`,
  fires once per `localId` (a `useRef` guard, not a render-count
  guard — a same-visit wrong-PIN fix succeeding does **not** retrigger
  this; the banner's own disappearance is that confirmation, so the
  cashier doesn't get a "Sale complete" toast popping up mid PIN-
  correction). Tone `'success'`, `SALE_COMPLETE_TOAST_TIMEOUT_MS` (5s),
  fixed `id: 'sale-complete'` so a second sale before the first toast
  times out replaces it rather than stacking.

### Rule 4

Nothing here touches `cartStore.checkout()`, `runCheckout`, or any IPC
handler — this task is renderer-UI-only. The whole stack remains a
`fixed`, non-modal overlay; no toast, timeout, or close button has any
path back into `PosCheckoutPanel`'s flow. `cartCheckout.test.ts`'s
existing "a second sale proceeds immediately" test is untouched and
still passes, since the code it exercises wasn't touched.

## Tests

- **`tests/toastStore.test.ts`** (new, 7 tests): `show()` appends a new
  id; `show()` with an existing id replaces it **in place** (same
  index, not moved to the end, not a duplicate); every `show()` call
  stamps a fresh `updatedAt` even on an otherwise-identical replace
  (spying `Date.now`); `dismiss()` removes the matching entry and
  leaves others alone; `dismiss()` of a missing id is a no-op; append
  order is preserved; a `null` `timeoutMs` is stored as-is.
- **`tests/saleCompleteToast.test.ts`** (new, 6 tests): the fiscalized
  message; the plain message when eTIMS was never attempted; suppressed
  for `waiting`; suppressed for `needs_fixing`/data; suppressed for
  `needs_fixing`/system; no em dash.
- **`tests/toastTimeouts.test.ts`** (new, 6 tests): each constant's
  exact value, plus a loop asserting every constant is either `null` or
  a positive number (catches an accidental `0` or negative value).
- **Existing suites** (`connectivityToasts.test.ts`, `fiscalNotice.test.ts`,
  `cartStore.test.ts`, `cartCheckout.test.ts`, `checkout.test.ts`, …) —
  all pass unmodified. Nothing they test (the debounce logic, the notice
  derivation, the checkout flow) changed.

### What the tests can't cover, and why

- **The close button being present on every toast** — structural in
  `ToastShell` (no prop to hide it), not a per-entry runtime fact;
  verified by reading the component, not by a test, per this project's
  no-component-rendering-test convention.
- **"Dismissing a fiscal notice leaves the order row unchanged"** — also
  structural rather than test-asserted: `FiscalNotice.tsx`'s `dismiss()`
  calls only local `setState` and `toastStore.dismiss()`; it makes no
  `window.api.*` call at all, so there is no code path from dismissal to
  the database. `toastStore.ts` itself has no import of `database.js` or
  `window.api`. I didn't write a synthetic test asserting this since
  there's nothing to execute that would prove more than reading the
  source already does — `fiscalResend.test.ts` already covers
  exhaustively that `resendFiscalization`/`correctPinAndResend` are the
  only things that ever change `fiscal_status`.
- **On-screen stacking, spacing, and whether the height cap actually
  keeps the cart/search bar/Complete Sale button clear** — visual-only,
  same honest limitation every prior toast/banner phase has flagged.
  Worth a real screen check before calling this done, especially the
  worst-case pile-up (a wrong-PIN fiscal notice open with its buttons,
  plus a connectivity toast, plus a fresh sale-complete toast, all at
  once).

## Verification

- `npx vitest run`: **64 files / 972 tests** (953 going in + 19 new), 0
  failures.
- `npm run typecheck` (node + web): clean.
- No modification to `cartStore.ts`, `checkout.ts`, any IPC handler, or
  any main-process file — confirmed by grep and by every pre-existing
  test in those areas passing unmodified.

Holding here for the visual check and for review before Task 3 (the
on-screen keyboard).
