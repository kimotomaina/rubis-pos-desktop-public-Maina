# Phase 11 — POC Hardening, Bug Fixes, and Final Polish

**Date:** 2026-08-25 · **Branch:** `main` · **Previous:** [Phase 10](./phase-10.md)

## 1. Objective

Close out the Phase 10 backlog before the RUBIS 1-week trial: fix the
shift-reconciliation bug where a voided cash sale still counted toward
the drawer, add sanity limits to manual price overrides, verify the
`electron-updater` import fix is durable, and add a Demo Mode so the
till looks fully populated and is scannable even with zero internet or
Shopify credentials on the trial floor.

## 2. Clarification defaults applied

- **Q1 (free-item / Ksh 0 override):** blocked entirely, exactly as
  recommended — `validatePriceOverride` rejects `0` and negative
  prices outright. A give-away goes through a 100% cart or line
  discount instead, which is already Manager PIN-gated (Phase 10).
- **Q2 (Demo Mode dummy data):** implemented as recommended — 10
  realistic Kenyan convenience-store items with round, easy-to-scan
  barcodes (`111111`, `222222`, … `101010`) in
  `src/main/services/demoData.ts`.

## 3. Task 1 — Shift Reconciliation Bug Fix (Critical)

### The bug

`RubisDatabase.closeShift` computed expected cash as
`starting_cash + Σ(cash orders' totals)`, filtering only on
`payment_method === 'cash'`. A `pending_sync` cash order that was
later voided (Phase 10) kept its row in the `orders` table with
`status = 'voided'` but was **never excluded from that sum** — so a
voided Ksh 500 cash sale still inflated the shift's expected cash by
Ksh 500, meaning a cashier counting the *actual* drawer would show a
Ksh 500 shortfall for a sale that was correctly reversed.

### The fix

One-line filter added in `database.ts`:

```ts
const cashTotal = this.getOrdersForShift(shiftId)
  .filter((order) => order.payment_method === 'cash' && order.status !== 'voided')
  .reduce((sum, order) => sum + order.total, 0)
```

The same class of bug existed in `reports.ts`'s revenue aggregations —
`generateZReport` and `generateDailySummary` both summed `orders`
without excluding voided ones, so a Z-report's "Total Revenue" and
"Orders" count, and the Admin screen's "Today's Sales", also
overstated actual sales by however much had been voided. Fixed with a
shared `excludeVoided()` helper applied before both aggregations.
`OrderHistory.tsx`'s order *list* (Phase 10) is deliberately untouched
— voided orders should still be visible there, with their "Voided"
badge, just excluded from cash/revenue math.

### Verification

`getOrdersForShift`/`getOrdersForDateRange` are plain SQL `SELECT`s
with no status filter (by design — other callers may want every
order regardless of status), so the bug was in the TypeScript-side
aggregation, not the query. That means the existing recording-fake
test harness (which replays whatever rows a test registers, ignoring
the real `WHERE` clause) can't exercise the fix faithfully — a test
using that harness would only prove "the code does what the test
pre-arranged," not "voiding actually flows through end-to-end."

`tests/reconciliation.test.ts` instead runs against a **real**
in-memory `better-sqlite3` connection (`:memory:`) — the first file in
this codebase to do so, alongside `tests/demoData.test.ts` (§5). This
is a deliberate, narrow exception to the "always mock the native
module" convention used everywhere else: `better-sqlite3`'s binary is
already a hard build dependency of this project (`postinstall`
rebuilds it), so there's no new cost, and the bug is specifically
about real SQL/aggregation behavior that a mock cannot reproduce. Five
tests: a voided cash order excluded from `expectedCash`, a zero
discrepancy when the counted drawer matches sales minus the void, a
non-voided order still counting normally (no over-correction), and the
matching exclusion from `generateZReport` and `generateDailySummary`.

## 4. Task 2 — Price Override Sanity Checks

`checkoutMath.ts` gained `validatePriceOverride(newPrice, basePrice)`:

- **Floor:** `newPrice <= 0` (or non-finite) is rejected — "Price must
  be greater than zero." (Q1)
- **Ceiling:** `newPrice > basePrice × 1.5` is rejected — "Price
  exceeds maximum allowed override. Contact Admin." — catching the
  classic typo (`10000` for `1000`) that a Manager PIN alone doesn't
  guard against, since the PIN only authorizes *that* an override
  happens, not that its size is sane.

`basePrice` — the item's **original catalog price** — is a new field
on `CartItem`, captured once in `cartStore.addItem` when a fresh line
is created and never mutated afterward. The ceiling check is always
against this original price, not the item's current price: without
that distinction, two successive overrides could each individually
pass the 50% check yet compound past it (e.g. Ksh 100 → 145 → 149 →
… — see the "checks a second override against the original basePrice"
test in `tests/priceOverride.test.ts`).

Enforcement is doubled, matching this codebase's existing defense-in-
depth style (e.g. `canCompleteSale` gates the UI, the main process
re-validates the checkout total independently):

- **Store-level** (`cartStore.setItemPrice`) — silently no-ops an
  invalid override. This is the layer that can never be bypassed
  regardless of which UI path calls it.
- **UI-level** (`CartLineItem.savePrice`) — calls the same
  `validatePriceOverride` *before* calling `setItemPrice`, so it can
  show the rejection reason as a toast (reusing `App.tsx`'s existing
  `scanToast` mechanism via a new `showToast` prop) and leave the
  inline editor open for the cashier to correct the value, rather than
  the store's silent no-op leaving the cashier wondering why nothing
  happened.

## 5. Task 3 — Final Build Verification & Polish

### `electron-updater` CommonJS import

Verified, **not modified** — `src/main/index.ts` already has the
correct interop pattern from Phase 8:

```ts
import electronUpdater from 'electron-updater'
const { autoUpdater } = electronUpdater
```

`electron-updater` ships as CommonJS; under this project's
`"type": "module"`, its named exports aren't statically available to
an ESM import, so the default export is destructured at runtime
instead. This is already durable — confirmed by `tests/updater.test.ts`
(11 tests, unchanged) continuing to pass, and by `updater.ts` itself
never importing `electron-updater` directly (it only depends on the
narrow injected `AutoUpdaterLike` interface), so there is no import
path left that could regress.

### Demo Mode (`VITE_DEMO_MODE=true`)

`src/main/services/demoData.ts` exports `DEMO_PRODUCTS` — 10 items
(Kabras Milk 500ml, Bread Loaf, Coca-Cola 300ml, Airtime 50 Ksh, Fresh
Fri Cooking Oil 1L, Jogoo Maize Flour 2kg, Pishori Rice 1kg, Geisha Bar
Soap, Matchbox, Keringet Water 500ml), each a single-variant
`ProductSummary` with a round 6-digit barcode (`111111` … `101010`)
so a cashier can practice scanning without printed labels.

Wired into `main/index.ts`:

```ts
const demoMode = process.env.VITE_DEMO_MODE === 'true'
if (demoMode) {
  db.cacheProducts(DEMO_PRODUCTS)   // seeds the local cache on every launch
}
```

and the `products:fetch` IPC handler short-circuits to the cached data
before ever touching `shopifyEnv()`/the network:

```ts
ipcMain.handle('products:fetch', async () => {
  if (demoMode) return { success: true, data: db.getCachedProducts() }
  // ...existing live-fetch path, unchanged
})
```

This means Demo Mode requires **no Shopify credentials at all** — the
`.env` can be entirely blank except `VITE_DEMO_MODE=true` and the app
still opens fully stocked. `products:cached` (the offline-fallback
handler) is untouched and already reads the same cache, so it works
identically whether that cache came from a live fetch or from Demo
Mode seeding.

## 6. Testing Strategy

- `tests/reconciliation.test.ts` (5 tests, real in-memory SQLite) —
  §3's end-to-end fix verification.
- `tests/priceOverride.test.ts` (13 tests) — `validatePriceOverride`'s
  floor/ceiling/edge cases (exactly at the ceiling passes, one cent
  over fails, non-finite/negative/zero all rejected, a zero
  `basePrice` doesn't false-positive the ceiling check) plus
  `cartStore.setItemPrice` behavioral tests: `basePrice` capture on
  add, a valid override applying, an invalid one silently no-op'ing,
  and the compounding-override regression case.
- `tests/demoData.test.ts` (5 tests) — `DEMO_PRODUCTS` shape (exactly
  10, unique ids, unique 6-digit barcodes, positive price/stock) plus
  a round-trip through the real `cacheProducts`/`getCachedProducts`
  path `index.ts` actually uses.

```bash
npm test           # vitest run — 27 files / 261 tests
npm run typecheck  # tsc --noEmit (node + web) — clean
```

## 7. Files Created / Modified

**Created:**
- `src/main/services/demoData.ts`
- `tests/reconciliation.test.ts`
- `tests/priceOverride.test.ts`
- `tests/demoData.test.ts`
- `docs/phase-11.md`

**Modified:**
- `src/main/services/database.ts` — `closeShift`'s cash-total filter
  excludes `voided` orders
- `src/main/services/reports.ts` — `excludeVoided()` helper applied in
  `generateZReport` and `generateDailySummary`
- `src/main/index.ts` — Demo Mode seeding on startup,
  `products:fetch` short-circuit
- `src/renderer/src/lib/checkoutMath.ts` — `validatePriceOverride`,
  `PRICE_OVERRIDE_MAX_MARKUP_PERCENT`
- `src/renderer/src/types/shopify.ts` — `CartItem.basePrice`
- `src/renderer/src/stores/cartStore.ts` — `addItem` captures
  `basePrice`, `setItemPrice` enforces `validatePriceOverride`
- `src/renderer/src/components/CartLineItem.tsx` — `savePrice`
  validates before applying, new `showToast` prop
- `src/renderer/src/App.tsx` — `showToast={setScanToast}` wired to
  `CartLineItem`
- `.env.example` — `VITE_DEMO_MODE`

## 8. Final Deployment Checklist (RUBIS 1-week trial)

Pre-flight, on the actual trial machine:

1. **Build**: `npm run dist` (full NSIS installer + portable `.exe`,
   per Phase 8 §7). Run `npm run dist:dir` first if you just want a
   fast unpacked smoke test.
2. **`.env`** — copy `.env.example` → `.env` next to the packaged app
   (`electron-builder`'s `extraResources`, per Phase 8) and fill in:
   - Real trial: `VITE_SHOPIFY_STORE_URL`, `VITE_SHOPIFY_ADMIN_API_TOKEN`,
     `VITE_DEMO_MODE=false`.
   - Store internet is unreliable / credentials not ready in time /
     pure hardware demo: `VITE_DEMO_MODE=true` and leave the Shopify
     vars blank — the app still opens fully stocked (§5).
   - `VITE_MOCK_PRINTER=true` unless a real ESC/POS printer is
     connected and its `VITE_PRINTER_INTERFACE` IP is confirmed
     reachable.
   - `VITE_USE_MOCK_INTEGRATIONS=true` if M-Pesa/eTIMS mocks should be
     exercised during the trial (Phase 9/10) — leave `false` (default)
     to run the trial on Cash/Card only with no integration calls at
     all.
3. **Install** — `RUBIS POS Setup <version>.exe`, click through
   SmartScreen ("More info → Run anyway" — build is unsigned for the
   PoC, Phase 8 §7).
4. **First launch checklist**:
   - Login screen appears (not a white screen/crash) — confirms
     `errorHandler.ts`'s safety net and `.env` loading both worked.
   - Default admin PIN `1234` logs in — **change it immediately** via
     Admin → Staff → Reset PIN.
   - Product grid is populated (either from a live Shopify fetch or
     Demo Mode's 10 items — confirms catalog loading end-to-end).
   - Open a shift with a known starting cash float before any sales.
5. **Smoke-test the trial-critical flows** in order: ring a Cash sale
   → print/verify the mock or real receipt → ring an M-Pesa manual-
   code sale (Phase 10) → apply a >10% discount and confirm the
   Manager PIN prompt appears → void a `pending_sync` order and
   confirm it disappears from the next `closeShift`'s expected cash
   (this phase's fix) → close the shift and check the Z-report numbers
   are sane.
6. **Known-safe fallbacks to brief the cashier on**: offline sales
   queue automatically (Phase 3) and a banner says "Offline — sales
   will queue"; a failed M-Pesa code can be retried or the sale
   switched to Cash (Phase 10 Q3); voids only work on orders that
   haven't synced yet (Q1 from Phase 10 — a synced order needs a
   manual Shopify-side correction until Phase 12's Refund API work).

## 9. Known Limitations (candidate backlog)

- **Demo Mode re-seeds on every launch** — `db.cacheProducts` fully
  replaces the `products` table each time `demoMode` is true, so any
  local edits to demo inventory quantities (e.g. from real sales
  during a demo) reset on restart. Fine for a demo; would need a
  "seed once" guard if Demo Mode were ever used for anything longer.
- **Price override ceiling is a flat 50% for every item** — a Ksh 10
  matchbox and a Ksh 350 cooking oil bottle share the same markup
  tolerance; a future phase could scale the ceiling by absolute Ksh
  amount for low-price items if typos there prove to still be an
  issue in practice.
- **No renderer component-test harness** — carried over from Phase 10;
  `CartLineItem`'s new toast-on-rejection path was verified by
  typecheck + the store-level test, not a rendered-DOM assertion that
  the toast text actually appears.

---

## Phase 11 Completion Report

**Files created:** `src/main/services/demoData.ts`,
`tests/reconciliation.test.ts`, `tests/priceOverride.test.ts`,
`tests/demoData.test.ts`, `docs/phase-11.md`.

**Files modified:** `database.ts`, `reports.ts`, `index.ts`,
`checkoutMath.ts`, `types/shopify.ts`, `cartStore.ts`,
`CartLineItem.tsx`, `App.tsx`, `.env.example` — full list in §7.

**Tests:** `npm test` — **27 files / 261 tests passing** (23 new: 5
reconciliation + 13 priceOverride + 5 demoData; existing suite
unaffected). `npm run typecheck` — clean (node + web projects).

**Critical bug fixed:** shift-close cash reconciliation and both
revenue reports (Z-report, daily summary) previously counted voided
orders — verified end-to-end against a real SQLite connection rather
than the codebase's usual mocked harness, since the bug was
specifically in aggregation logic a mock can't exercise faithfully.

**Verified, not modified:** the `electron-updater` CommonJS import fix
from Phase 8 was already correctly and durably in place.

**Next steps:**
1. Run the full Deployment Checklist (§8) on the actual trial machine
   before the 1-week PoC starts — several steps (SmartScreen
   click-through, a real printer IP, a live Shopify credential check)
   can't be exercised in this environment.
2. Phase 12 candidate: Shopify Refund API for `synced` orders (closes
   the last gap from Phase 10's Q1), plus whatever surfaces from the
   trial itself.
3. Revisit Demo Mode's re-seed-on-launch behavior (§9) if it ends up
   used for anything beyond a short demo.
