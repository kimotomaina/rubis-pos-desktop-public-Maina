# Phase 82 — Task 2: sale-complete toast, Audit

Read-only. No code changed. STOP for review before Apply.

## The existing toast mechanism

Two toasts already exist, both mounted once at the `App.tsx` root
(alongside each other and `FiscalNotice`, `src/renderer/src/App.tsx`
lines 559-567):

- **`ConnectivityToast.tsx`** — driven by an IPC push stream
  (`window.api.onConnectivityStatus`), debounced via
  `lib/connectivityToasts.ts` so a flaky connection doesn't spam a toast
  every 30-second poll. Renders `fixed bottom-4 left-4`, stacks multiple
  entries, each auto-dismisses after a fixed `TOAST_LIFETIME_MS` (5000ms)
  via its own `setTimeout`.
- **`UpdateToast.tsx`** — also IPC-driven (`window.api.onUpdateStatus`),
  renders `fixed bottom-4 right-4`, does **not** auto-dismiss — it stays
  until the user installs, since it's actionable.

Neither is the right template to copy directly: both are driven by an
IPC push stream, but a completed checkout is local Zustand state
(`cartStore`), not a main-process event. **`FiscalNotice.tsx`** (phase-78)
is the closer precedent for what I'd actually build on: it's the one
existing toast/banner driven by `cartStore.lastReceipt` rather than IPC,
and it already solved the exact timing problem a sale-complete toast
would hit — see below.

## Where the renderer learns a checkout finished

`cartStore.ts`'s `checkout()` action sets `checkoutStatus` (`'synced'` |
`'queued-offline'`) and `lastReceipt` (the full `CheckoutReceipt`, from
`main/index.ts`'s `orders:checkout` handler → `runCheckout`) together, in
the same `set()` call, the moment the IPC call resolves.

`checkoutStatus` is **not safe to key a mount-once toast off** —
confirmed by reading `PosCheckoutPanel.tsx` (the only checkout UI
actually mounted; `CheckoutModal.tsx` exists in the repo but is not
imported anywhere in `App.tsx`, so it's dead code, not a second live
checkout path to account for): `PosCheckoutPanel` has a `useEffect` that
fires the instant `checkoutStatus` becomes `'synced'`/`'queued-offline'`
and immediately calls `resetCheckoutStatus()` — no delay, no
`setTimeout`. So `checkoutStatus` is a single-render pulse back to
`'idle'`, exactly the reason `FiscalNotice.tsx`'s own doc comment gives
for reading `lastReceipt` instead.

`lastReceipt` doesn't get reset — it holds the last completed sale's
full receipt until the next checkout overwrites it. `FiscalNotice.tsx`
already solved "how do I know this is a *new* sale, not the same one
re-rendering" by comparing `lastReceipt.localId` against a
locally-tracked id (`dismissedLocalId`). A toast needs the same
comparison, just auto-timed instead of button-dismissed.

`lastReceipt`'s fiscal fields (`fiscalStatus`, `fiscalErrorReason`,
`fiscalErrorKind`, `fiscalDataIssue`, `fiscal`) are exactly what
`fiscalNotice.ts#getFiscalNotice` already reads to decide whether to show
a banner, and it returns `null` precisely when there's nothing for the
banner to say (`fiscalStatus` is `'fiscalized'` or `null`/not attempted).

## Coordinating the toast and the banner

The task brief asks me to pick one of two approaches and say which.
Since `getFiscalNotice(receipt)` is already the single, pure, tested
function that decides "does the banner have something to say about this
sale," the cleanest coordination is to make it the same function that
decides whether the toast is neutral or suppressed — not to re-derive
the fiscalized/waiting/needs_fixing logic a second time in the toast:

- `getFiscalNotice(receipt)` returns **non-null** (waiting or
  needs_fixing) → **suppress the toast entirely**. The banner already
  opens with "Sale complete, but..." for both those cases (phase-78) — a
  second, neutral "Sale complete" toast alongside it would be pure
  restatement, not new information, and two on-screen elements for one
  sale is more than a cashier needs to process for what's still a normal
  completed transaction.
- `getFiscalNotice(receipt)` returns **null** — either the sale
  fiscalized cleanly, or fiscalization was never attempted
  (`fiscalStatus` is `null`, e.g. mock/real-eTIMS toggled off) — show the
  toast. Message depends on `fiscalStatus === 'fiscalized'`: "Sale
  complete — tax receipt issued." vs. plain "Sale complete." for the
  no-fiscal-attempt case.

This can never show a "tax receipt issued" toast for a sale the banner
is simultaneously flagging as rejected/queued, because both read the
same derivation off the same `lastReceipt` — there's no separate state
to drift out of sync.

## Proposed approach (for Apply, pending your review)

- New `src/renderer/src/components/SaleCompleteToast.tsx`, mounted once
  at the `App.tsx` root next to `FiscalNotice`/`ConnectivityToast`.
- Reads `lastReceipt` from `cartStore` (not `checkoutStatus`, for the
  reason above). Tracks the last `localId` it already showed a toast for
  (same pattern as `FiscalNotice`'s `dismissedLocalId`, but set the
  moment the toast fires, not on a dismiss click) so it never re-fires
  for the same sale on an unrelated re-render.
- Auto-dismisses on a timer, matching `ConnectivityToast`'s
  `TOAST_LIFETIME_MS` pattern (5000ms) — non-modal, no action required,
  same `fixed` positioning convention (a corner not already claimed:
  `ConnectivityToast` has bottom-left, `UpdateToast` bottom-right,
  `FiscalNotice` top-right — bottom-center or a stacked bottom-right
  under `UpdateToast` are the open options; will pick one that doesn't
  overlap either in Apply).
- Rule 4 (never blocks): a `fixed`, non-modal overlay exactly like the
  other three — never touches `PosCheckoutPanel`'s layout or the
  Complete Sale button, and the panel is already free to start the next
  sale the instant `checkoutStatus` resets, regardless of what this toast
  is doing.

Holding here for review before building it.
