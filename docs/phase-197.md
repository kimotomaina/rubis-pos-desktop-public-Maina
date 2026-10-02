# Phase 197 — Cart: manager PIN to remove or reduce a line; cart survives a restart

- **Date:** 2026-10-02
- **Requested:** a manager PIN to remove a line, reduce a quantity or clear the cart; the cart saved to SQLite so it survives a restart. Shopify stays the only stock ledger; the saved cart is a draft on this till and is never pushed anywhere. No new dependency, no `check:fit`.
- **Outcome:** **Built and run by hand.** Typecheck clean; full suite 167 files, 2601 tests passing (161 files, 2538 tests before: 6 new files, 63 new tests); `npm run build` passes including the no-mock-provider check. `check:fit` was not run.
- **Branch / base commit:** staging @ c835d07 (phase 196-2, committed separately at the start of this phase), tree clean at the start. Not committed, not pushed, not deployed.

## 1. Audit

The Step 0 findings and the seven decisions you approved ("all as recommended"):

1. **Clear cart:** no such control existed, so a PIN-gated "Clear cart" button was added.
2. **No park:** none exists and none was built. A cashier with no manager can cancel the PIN prompt and complete the sale as it stands.
3. **One source of truth:** zustand `persist` (localStorage `rubis-pos-cart`, items only) is removed; the SQLite draft replaces it. An old localStorage cart is discarded, not imported.
4. **Restore re-prices:** lines are rebuilt from today's catalogue; a price override or discount is removed and the toast says so. A variant absent from the cached catalogue (Shopify's active products only) is dropped.
5. **`cart_token`:** one extra column on `cart_line_removals`, created when the cart goes from empty to non-empty, so checkout stamps only that cart's rows.
6. **Audit before action:** the removal row is written first, by an IPC that re-verifies the PIN; if that fails, the cart does not change.
7. **Best effort in the sale:** the draft delete and the stamp run inside `queueOrder`'s transaction under a try/catch, so they can never abort a sale.

Evidence behind them: the cart store and its callers ([cartStore.ts](../src/renderer/src/stores/cartStore.ts), [PosCartTable.tsx](../src/renderer/src/components/PosCartTable.tsx)); `ManagerPinModal` verifies via `auth:login` and accepts any role, and nothing caches a verified PIN ([ManagerPinModal.tsx:53-73](../src/renderer/src/components/ManagerPinModal.tsx#L53-L73), [requireAdminPin.ts:43](../src/main/lib/requireAdminPin.ts#L43)); all four order-creating paths call `queueOrder` inside their own transaction ([database.ts](../src/main/services/database.ts)); a kill after the order is saved but before the renderer cleared the cart would have brought the localStorage cart back, a double-sale risk the SQLite draft closes.

## 2. Changes

| File | Change |
| --- | --- |
| `src/renderer/src/lib/cartGuard.ts` (new) | `needsManagerApproval`: true for remove, clear, and a quantity that goes down; false for equal or higher. A quantity change with no target counts as a reduction. |
| `src/renderer/src/lib/guardedCartActions.ts` (new) | Remove, reduce and clear behind the PIN: ask, record through the main process, and only then change the cart. Cancel, a failed record and a missing cashier or cart token all leave the cart as it was. Increasing never asks. |
| `src/renderer/src/lib/cartDraft.ts` (new) | A 300 ms debounced saver (an empty cart deletes the draft; a failed write is swallowed), `restoreCartDraft` (re-price, drop missing variants, drop overrides) and the toast wording. |
| `src/renderer/src/stores/cartStore.ts` | zustand `persist` removed. New `cartToken` (new for each cart) and `restoreCart`; checkout sends the token. |
| `src/renderer/src/components/PosCartTable.tsx` | Optional `onClear` and a "Clear cart" button in the footer row. |
| `src/renderer/src/App.tsx`, `lib/toastTimeouts.ts` | Wires the guarded actions; saves the draft as the cart changes (paused while a checkout is in flight); restores once, after sign-in and catalogue load, only if the cart is empty; deletes the retired localStorage key. |
| `src/renderer/src/types/shopify.ts`, `src/preload/*` | `CartRemovalRequest`; bridge methods `saveCartDraft`, `loadCartDraft`, `clearCartDraft`, `recordCartRemovals`. |
| `src/main/services/database.ts` | Tables `cart_drafts` (one row, `id = 1`, overwritten) and `cart_line_removals`; `saveCartDraft`, `getCartDraft`, `clearCartDraft`, `recordCartLineRemovals`, `listCartLineRemovals`; `queueOrder` calls `settleCartForOrder` inside its transaction. |
| `src/main/services/cart-removals.ts` (new) | `recordApprovedRemovals`: re-verifies the manager with `requireAdminPin`, then inserts. |
| `src/main/lib/ipcValidator.ts`, `src/main/index.ts`, `src/main/services/checkout.ts` | `cartToken` on the checkout request and the order input; schemas and four thin handlers (`cart:save-draft`, `cart:load-draft`, `cart:clear-draft`, `cart:record-removals`). |
| `tests/cartCheckout.test.ts` | The test that asserted localStorage persistence is replaced (see section 5). |

## 3. Affected files and functionality

| File | Functionality affected |
| --- | --- |
| `queueOrder` (`database.ts`) | Two extra statements in every sale's transaction (delete the draft, stamp removals), wrapped so a failure is logged and swallowed. The order, queue and fiscal-queue inserts are unchanged. |
| `cartStore.ts` | The cart is no longer written to localStorage. |
| `PosCartTable.tsx`, `App.tsx` | Minus, trash and the new Clear button now go through the guard. Plus is unchanged. |

## 4. Possible impact

- **Direct:** a cashier can no longer remove or reduce without a manager. A mis-scanned item can then only be sold or left to a manager, and the till cannot issue credit notes.
- **Indirect:** the first launch after this update starts with an empty cart (the old localStorage cart is discarded). A restored cart shows today's prices, so its total can differ from before the restart.
- **Data / schema / contract:** two new tables, `CREATE TABLE IF NOT EXISTS`, no migration. The checkout request gained an optional `cartToken`.
- **Security posture:** removal approvals are re-verified in the main process, so a renderer cannot forge one. The draft holds lines only: no tender, M-Pesa code or amount given.
- **Idempotency / re-run safety:** the draft is overwritten, never appended; stamping only touches rows with no order yet, so a second order from the same token stamps nothing.
- **Residual risk:** see section 7. Layout at the tightest supported window size is unmeasured.

## 5. Verification

- `npm run typecheck`: exit 0. `npx vitest run`: **167 files, 2601 tests passed**; the standing tripwires (`fiscalEngine`, `fiscalRouting`, `mpesaPaymentGate`) are in that run, unmodified. `npm run build`: exit 0, "neither mock provider is in out/main".
- **New tests (63):** `cartGuard` 7, `guardedCartActions` 13, `cartDraft` 16, `cartDraftDb` 17, `cartRemovalGuard` 4, `cartToken` 6. They cover: every guard branch; PIN asked, cancel leaves the cart and records nothing, record before apply, record failure and throw leave the cart alone; the debounce (one write after a burst, empty deletes, cancel, a failed write swallowed); restore (re-price, drop a missing variant, drop overrides, bad quantities, unreadable drafts, toast wording); the draft overwritten and deleted in the order's transaction and kept when the order rolls back; a sale still created when the draft cannot be deleted; removal rows stamped for that cart only; rows written only for a correct admin PIN (not for a wrong PIN, a cashier's PIN or an unknown manager); a grep test that only `database.ts` names the removals table or its reader.
- **Mutation check:** `needsManagerApproval` forced to `return false`: **15 tests failed**: 5 in `cartGuard` (clear, remove, quantity down, to zero, no target) and 10 in `guardedCartActions` (reducing: asks, cancel, record failure, record throws, last-unit, records-then-applies; removing: asks, cancel; clearing: records every line; no-cashier refusal). Restored; the file matched its backup and all 20 passed again.
- **Existing `expect()` changed:** one test, `tests/cartCheckout.test.ts` "persists items to localStorage…", replaced by "no longer writes the cart to localStorage…": the old `expect(stored.state?.items).toHaveLength(1)` and `expect(stored.state?.items?.[0].title).toBe('RUBIS Mug')` became `expect(localStorage.getItem('rubis-pos-cart')).toBeNull()` and `expect(useCartStore.getState().items).toHaveLength(1)`. **Added `expect()` calls:** 8 + 32 + 27 + 36 + 6 + 10 = 119 across the six new files.
- **Hands-on run of the built app** (`electron-vite build` with `VITE_DEMO_MODE=true`, then driven over CDP by a throwaway script outside the repo, against a throwaway profile). Shopify store URL and token were blanked and no fiscal device details exist in that profile, so nothing could reach Shopify or a fiscal device; the printer was the mock. The profile was deleted afterwards and `out/` rebuilt as the normal build.

```
[A] added 3 lines: ["Kabras Milk 500ml x1","Bread Loaf x1","Coca-Cola 300ml x1"]
[A] pressed Remove on line 1 -> PIN modal shown: true
[A] cancelled the PIN modal -> cart: ["Kabras Milk 500ml x1","Bread Loaf x1","Coca-Cola 300ml x1"]
[A] Remove with manager PIN -> cart: ["Bread Loaf x1","Coca-Cola 300ml x1"]
[A] plus on line 1 -> PIN modal shown: false | cart: ["Bread Loaf x2","Coca-Cola 300ml x1"]
[A] minus on line 1 -> PIN modal shown: true
[A] minus with manager PIN -> cart: ["Bread Loaf x1","Coca-Cola 300ml x1"]
[A] plus on line 2 -> PIN modal shown: false | cart: ["Bread Loaf x1","Coca-Cola 300ml x2"]
[db before kill] {"cart_drafts": 1, "orders": 0, "cart_line_removals": [
  {"variant_id": "demo-kabras-milk-500ml-variant", "qty_before": 1, "qty_after": 0, "staff_id": 1, "manager_id": 1, "order_local_id": null, "cart_token": "8d3296fe"},
  {"variant_id": "demo-bread-loaf-variant", "qty_before": 2, "qty_after": 1, "staff_id": 1, "manager_id": 1, "order_local_id": null, "cart_token": "8d3296fe"}]}
[A] app killed (taskkill /F /T, no clean quit)
[db after kill]  {"cart_drafts": 1, "orders": 0, ... same two removal rows ...}
[B] relaunched, signed in -> toast: Restored the cart from before the restart. 3 items.
[B] restored cart: ["Bread Loaf x1","Coca-Cola 300ml x2"]
[B] pressed COMPLETE SALE (cash, tendered 500): true
[B] cart after checkout: []
[B] draft via IPC after checkout: null
[db after checkout] {"cart_drafts": 0, "orders": 1, "cart_line_removals": [
  {"variant_id": "demo-kabras-milk-500ml-variant", ..., "order_local_id": 1, "cart_token": "8d3296fe"},
  {"variant_id": "demo-bread-loaf-variant", ..., "order_local_id": 1, "cart_token": "8d3296fe"}]}
```

  A second short run covered Clear cart: button present; PIN modal shown; cancelling left all three lines; with the PIN the cart emptied, the draft read back `null`, and one removal row per line (`qty_after` 0) was written. A screenshot showed the button sitting cleanly under the lines at 1920 px wide.
- **Not verified:** the layout at the tightest supported window sizes (`check:fit` was not run; the new button adds one row of about 36 px plus padding under the lines). Wrong-PIN and cashier-PIN refusals are covered by unit tests only; the hands-on run used the one seeded Admin account as both cashier and manager. The IPC handlers' own wiring has no unit test, like every handler in `index.ts`; their logic is in the tested services.

## 6. Rollback

`git checkout -- src tests` for the twelve modified files; delete `cart-removals.ts`, `cartDraft.ts`, `cartGuard.ts`, `guardedCartActions.ts`, the six new test files and this report. The `cart_drafts` and `cart_line_removals` tables may remain in a database that already ran this build; nothing outside this feature reads them.

## 7. Observed but not changed

- **No park feature.** A cashier without a manager cannot remove a wrong item and can only sell the cart as it stands; the sale is then a permanent KRA record.
- `CartLineItem.tsx` has the same three buttons, is imported only by tests, and is not guarded; if it is ever put back in the UI it bypasses this rule.
- The draft write is debounced by 300 ms, so a kill inside that window loses the last edit.
- Restore is skipped when the cart already has lines, and the draft is then overwritten by the new cart.
- The cart-level discount was never persisted and is not restored.
- "N items" in the restore toast counts units, not lines.
- Removal rows from a cart that is cleared or abandoned keep `order_local_id` NULL for good; nothing reads them yet.
- Variants that are out of stock but still in the catalogue are restored; only variants absent from the cached catalogue are dropped.
