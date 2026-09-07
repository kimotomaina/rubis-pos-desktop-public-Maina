# Phase 83 — Task 2 (revised): unified toast stack, Audit

Read-only. No code changed. STOP for review before Apply. Supersedes
`docs/phase-82.md`'s narrower "just add a sale-complete toast" design —
that audit's findings about `lastReceipt` vs `checkoutStatus` and the
`getFiscalNotice`-driven coordination still hold and are reused below.

Numbering note: the brief names the final apply+test report
`phase-83.md`, but this project's convention is one new file per STOP,
and the audit STOP needs its own file too. This audit is `phase-83.md`;
the apply+test report will land as **`phase-84.md`** instead.

## Every toast/banner mounted at the App.tsx root today

| Component | Trigger | Position | Auto-dismiss | Close button |
|---|---|---|---|---|
| `ConnectivityToast.tsx` | `window.api.onConnectivityStatus` (IPC push), debounced via `lib/connectivityToasts.ts` | `fixed bottom-4 left-4`, stacks multiple | Yes, fixed 5000ms per entry | No |
| `UpdateToast.tsx` | `window.api.onUpdateStatus` (IPC push) | `fixed bottom-4 right-4` | **No** — persists until installed | No (only the "Restart & Install" action) |
| `FiscalNotice.tsx` | `cartStore.lastReceipt` (phase-78) | `fixed right-4 top-4` | **No** — persists until dismissed | Yes (×) |
| *(new)* sale-complete toast | `cartStore.lastReceipt`, per phase-82's design | not yet built | — | — |

**A fourth one exists that neither brief named**, found while confirming
"every toast mounted at the App root": a **barcode-scan/search-feedback
toast**, inline in `App.tsx` (not its own component) — `scanToast` state
(`App.tsx:98`), triggered by local scan/search handlers (not IPC, not
`cartStore`), rendered `fixed bottom-6 left-1/2 -translate-x-1/2`
(bottom-center), auto-dismisses after 2500ms (`App.tsx:258-262`), no
close button, single-slot (one at a time, not stacked).

I'm flagging it rather than silently including or excluding it: it's the
same kind of transient, non-modal, non-actionable feedback as
`ConnectivityToast`, and leaving it out of the unification would mean
one inconsistent toast remains after this task — the opposite of the
goal. My recommendation is to fold it in (same treatment as
Connectivity: push into the shared stack, keep its exact trigger and
2500ms timeout, add a close button). Flagging for your call since it
wasn't in either brief.

## The two flagged behavior changes

### UpdateToast: give it a timeout without losing the update

Confirmed by reading `updater.ts`/`main/index.ts`: `autoUpdater.autoDownload
= true` and **`autoInstallOnAppQuit` is never overridden**, so it stays at
electron-updater's default (`true`). That means the downloaded update
installs automatically on the app's next normal quit/restart *regardless*
of whether the toast was ever seen, clicked, or dismissed — clicking
"Restart & Install" only controls *when* (right now, vs. next natural
restart), never *whether*. So a generous timeout genuinely cannot lose
the update itself, only the toast's visibility.

Proposed handling: give it a long timeout (I'll use 5 minutes) **that
resets on every new status event** — not just a fixed countdown from
first sight. Since `download-progress` fires repeatedly while a download
is active, each tick re-arms the timer, so the toast can't vanish
mid-download; it only starts counting down for real once events stop
(i.e., once the download finishes and the terminal "ready to install"
state sits idle). The close button dismisses the current toast without
touching `autoInstallOnAppQuit`'s registered plan — the OS-level "will
install on quit" is main-process state (`autoUpdater`'s own), completely
outside the toast's reach.

### FiscalNotice: confirming the persistence claim, then a generous timeout

Confirmed: `setOrderFiscalFailure`/`setOrderFiscalInfo` write directly to
the SQLite `orders` row (`fiscal_status`, `fiscal_error_reason`,
`fiscal_error_kind` — phase-71/76). Dismissing today's `FiscalNotice`
(its × button) only ever sets a local `dismissedLocalId` value in the
component — it never touches `cartStore.lastReceipt`, the order row, or
any persisted state. So **yes, this claim is true**: whether the notice
is dismissed by a click or a future timeout, the sale's `needs_fixing`/
`waiting` status is already durable on the order row before the notice
ever renders, and will be exactly as findable by Step 4's back-office
list either way. A toast timing out is strictly a "stop showing it here"
event, never a "forget this happened" event.

Given that, and given your note that a tiny timeout on an actionable
toast feels wrong: I'm proposing a genuinely generous default — **3
minutes** — for the idle state, and, per the brief, the timer must be
fully suspended (not just long) while `editingPin` or `resending` is
true, resuming a fresh 3-minute window the moment the cashier finishes.
If 3 minutes still feels short once you see it in Apply, it's a single
named constant to change, not a design change.

## Proposed architecture (for Apply, pending your review)

**A shared store, not a shared component that owns triggers.** The brief
is explicit that content/trigger logic must not move, only presentation
— so the design is a small Zustand store (`stores/toastStore.ts`,
matching this app's existing store convention — `cartStore`,
`connectivityStore`, etc.) holding the current stack of active toast
entries, plus one presentational shell and one stack container:

- **`toastStore.ts`** — `toasts: ToastEntry[]`, `show(entry)` (upserts by
  `id` — calling it again with an id already in the stack **replaces**
  that entry instead of appending, which is exactly the "rapid sales
  replace, not pile up" behavior for a fixed `id: 'sale-complete'`, and
  is also how `UpdateToast`'s progress ticks update in place rather than
  stacking), `dismiss(id)`. Directly unit-testable the same way
  `cartStore.test.ts` already tests store actions — no component
  rendering needed.
- **`ToastEntry`** shape, per the brief's base fields plus the one
  documented extension point for the two actionable toasts:
  `{ id, message, tone: 'info'|'success'|'warning'|'error', timeoutMs:
  number | null, onDismiss: () => void, actions?: ReactNode }`.
  `timeoutMs: null` is a deliberate, temporary pause (only used by
  `FiscalNotice` while `editingPin`/`resending` is true) — every toast
  still has a real default duration; nothing is permanently exempt.
- **`ToastShell.tsx`** — pure presentation: tone-colored chrome, the
  message, `actions` rendered below it when present, and an
  **unconditional** × button — every entry gets one, there's no prop to
  hide it, so "every toast has a close button" is a structural guarantee,
  not a per-toast choice. Owns the countdown timer itself
  (`setTimeout(onDismiss, timeoutMs)`), calling the SAME `onDismiss` for
  a timeout as for the × click — the producer decides what dismissal
  means (see below), the shell just triggers it.
- **`ToastStack.tsx`** — mounted once at the `App.tsx` root, replacing
  the three existing mounts (`ConnectivityToast`, `UpdateToast`,
  `FiscalNotice`) plus the new sale-complete toast (and, if approved,
  the barcode toast). `fixed top-4 left-1/2 -translate-x-1/2 z-50`,
  vertical column, new entries appended at the end (oldest toast stays
  where it is, newest appears at the bottom of the column) — the same
  append order `ConnectivityToast` already uses today, so nothing jumps
  around as toasts arrive.

**Why `onDismiss` lives on the entry, not in the shell:** a timer firing
and a × click need to mean the *same* thing to the producer — for
`FiscalNotice` specifically, that's "remember this sale's notice was
dismissed, don't resurrect it on the next unrelated re-render," exactly
what its existing `dismiss()` function (which sets `dismissedLocalId`)
already does. Routing both paths through that one existing function
(now also calling `toastStore.dismiss('fiscal-notice')`) means no new
"was this removed out from under me by a timer?" detection logic is
needed anywhere — the producer's own state change is the single source
of truth, exactly as it is today for the manual-dismiss case.

**Migrating each producer**: `ConnectivityToast`, `UpdateToast`, and
`FiscalNotice` keep their exact existing trigger code (the IPC listeners,
the `cartStore` selector) and keep deciding content exactly as they do
today — the only change is that instead of rendering their own `fixed`
div, they call `toastStore.show(...)` (or `dismiss(...)`) and render
`null` themselves. `ToastStack` is the only component that actually puts
pixels on screen for any of this.

**The new sale-complete toast**: a new `SaleCompleteToast.tsx` (or folded
directly into a small effect since it's genuinely simple — one derived
message, no interactive state), using a pure `lib/saleCompleteToast.ts`
helper (mirrors `fiscalNotice.ts`'s shape) so the message-selection logic
is unit-tested the same way `getFiscalNotice` already is:

```ts
export function getSaleCompleteMessage(receipt: FiscalOutcome): string | null {
  if (getFiscalNotice(receipt)) return null // banner owns this sale's story
  return receipt.fiscalStatus === 'fiscalized'
    ? 'Sale complete — tax receipt issued.'
    : 'Sale complete.'
}
```

Fires once per `localId` change (a `useEffect` keyed on
`lastReceipt?.localId`, not on every render), tone `'success'`, fixed
`id: 'sale-complete'` so a second sale before the first toast times out
replaces it rather than stacking.

## What the tests can and can't cover

This project's established convention (confirmed by `tests/checkout.test.ts`'s
own doc comment, and every toast/banner phase so far) is **no
component-level rendering tests** — only pure functions in `lib/*.ts` and
store actions get unit-tested directly; components stay thin and
untested via rendering. That shapes the Apply's test plan:

- `toastStore.ts`'s `show`/`dismiss`/upsert-by-id/append-order behavior —
  fully testable directly (`useToastStore.getState()`, same pattern as
  `cartStore.test.ts`).
- `lib/saleCompleteToast.ts`'s message selection, including the
  suppression case — fully testable, mirrors `fiscalNotice.test.ts`.
- "Every toast has a timeout and a close button" — the close button is a
  structural guarantee in `ToastShell` (unconditional, no prop to hide
  it), not a per-entry runtime fact I can assert without rendering; the
  timeout is a real field on every entry each producer constructs, which
  IS testable per-producer (e.g. a pure `resolveFiscalNoticeTimeoutMs
  (editingPin, resending)` helper, asserting it returns `null` only
  during those two states and a real number otherwise).
- The two behavior changes (UpdateToast survives its timeout via
  reset-on-activity; FiscalNotice's timer never fires mid-interaction;
  the order row's `fiscal_status` is unaffected by the toast dismissing)
  — testable at the logic-that-decides-`timeoutMs` layer and at the
  database layer, not by rendering a countdown and watching it expire in
  a browser.
- On-screen stacking/overlap/spacing — visual-only, same honest
  limitation every prior toast/banner phase has flagged; call it out
  again rather than claim a test covers it.

Holding here for your call on the barcode toast, the two timeout values
(5 min / 3 min), and the overall architecture before I build it.
