# Phase 217 — hold a sale and serve the next customer

- **Date:** 2026-10-04 (started 2026-10-03)
- **Requested by the owner:** while customer 1 waits for their M-Pesa message, the cashier parks their cart, serves customer 2 (any payment), then reopens customer 1's cart and finishes it. The held sale stays on screen so it is never forgotten. Not split payment.
- **Outcome:** built and verified in tests and in `check:fit`. **Not verified on paper or on a real till**, and not released: no version bump, no installer, nothing sent to GitHub.
- **Checks:** typecheck clean; full suite **194 files, 3220 tests, all passing** (192 and 3155 before: +2 files, +65 tests); `npm run build` passes with the no-mock check; **`check:fit` measured 373 cases and all fit** (0 skipped, 0 allow-listed scrollers), including 0, 1, 2 and 3 held sales, a resumed sale on the M-Pesa and Card panels, and End of Day with and without discarded held sales, at all 9 sizes.
- **Commits:** the work spans two commits. `cb776de` ("featP update overflows", by Paul Chesa, 2026-10-03 22:44) is the owner's own commit of the work as it stood part-way through: the database, the services, the screens and both new test files. This phase's own commit holds what came after it (the End of Day list's final form, the `check:fit` changes and fixes, the test edits that followed, `KNOWN_GAPS.md`, this document). I did not rewrite `cb776de`.
- **Base:** staging on `b809cf1` (release 2.1.9).

## 1. The audit, as agreed

A held cart is **not a sale**. The three facts that make it safe were confirmed before anything was built:

- **(a) Fiscal:** the request is built and sent only inside `runCheckout`: `fiscalizationProvider.submitInvoice(fiscalRequest)` at [checkout.ts:643](../src/main/services/checkout.ts#L643), and `buildFiscalRequest` inside the order transaction.
- **(b) Shopify:** the `sync_queue` `orderCreate` row is inserted only inside `queueOrder`'s transaction; the renderer's only caller is `cartStore.checkout` (`window.api.checkout`, [cartStore.ts:318](../src/renderer/src/stores/cartStore.ts#L318)).
- **(c) Trader number:** `allocateTraderInvNum` runs inside the order insert ([database.ts:1850](../src/main/services/database.ts#L1850)).

What the audit found that shaped the build:

1. The cart stores a **price per line** (`price`, `basePrice`), so rule 12 is possible. Discount **approvals are not stored anywhere** (the PIN is checked when the discount is applied; `Discount` is only a type and a value); removal approvals are, in `cart_line_removals`, keyed by `cartToken`.
2. The **cart draft of phase 197** saves lines and token only, and its restore **rebuilds from the catalogue at today's prices and drops discounts and overrides**. That is the opposite of rules 1 and 12, so held carts use the same storage pattern (SQLite through the main process) but never `restoreCartDraft` or `restoreCart`.
3. **Checkout deletes every row of `cart_drafts`** in the order transaction, so held sales needed a table of their own.
4. The customer PIN, company name, payment method and tendered amount were local `useState` in `PosCheckoutPanel`. The first two moved into the cart store; the last two stay local and are reset by a hold.
5. **Payment in progress** lived only inside `PaymentModal` and `CardEntryPanel`, and the poller stops when the panel unmounts. Hence the shared signal (section 4).
6. `auth:logout` in the main process is a no-op, so Log Out never closed the shift; Close Shift exists only in the Admin screen.

## 2. The rulings, and how each is built

| Rule | Built as |
| --- | --- |
| **1** Hold parks the whole cart | `Hold sale` button in the cart footer beside "Clear cart" (`PosCartTable`); `heldSalesStore.hold` sends lines, prices, discounts, customer PIN, company name and `cartToken` to `held:hold`, then clears the cart. Not the guarded "clear" (a hold is not a removal). |
| **2** Always visible | `HeldSalesStrip`, in the left column between the search bar and the cart. One card per held sale (label, age, total, units). **No close or collapse control** (tested: its only buttons are Resume, Rename, Discard). |
| **3** Amber at 5 min, red at 15; header count | `heldAgeTone`, recomputed every 15 s; a `Held N` chip beside the clock, coloured by the oldest sale. The numbers are one constants block in `lib/heldSale.ts`, with a comment saying they are the owner's. |
| **4** "Customer N", renamable | The lowest number not used by a held sale; rename by the on-screen keyboard (text mode), saved when the keyboard closes. |
| **5** At most 3 | Enforced in the main process (`MAX_HELD_SALES` in `lib/heldSaleRules.ts`) and in the decision the screen makes; a test fails if the two copies differ. A cart resumed from hold can always be held again (it is already counted). |
| **6** Resume onto an empty cart only | `decideResume`; with a non-empty cart the strip offers "Hold the current cart first?". |
| **7** No hold during a payment | `usePaymentActivityStore`: `PaymentModal` sets it while a Daraja push is **waiting**, while the push request is **in flight**, or while a **code is typed**; `CardEntryPanel` while a reference is typed or the slip is ticked; both clear it on unmount. The Hold button is disabled with the reason beside it, and `hold()` itself refuses too. |
| **8** Label and total in large type | On a resumed sale, `heldLabel` replaces the description line in the manual M-Pesa panel and the card panel with `Customer 1 · Ksh 1,650.00` in `text-2xl`, above the code field. **Not shown on the Daraja STK tab** (no code field there). |
| **9** Discard: manager PIN and reason, logged | Reason first, then `ManagerPinModal`; `held:discard` re-verifies the admin PIN in the main process (`requireAdminPin`) and refuses an empty reason (also in the request schema). The row stays in `held_sales` as `discarded`, with who held it, who discarded it, when, the label, total, lines, reason and approving manager. A sale on screen (`resumed`) cannot be discarded. |
| **10** Survives a restart | `held_sales` table in the till's database; `load()` after login. |
| **11** Close Shift / Log Out | **Changed by the owner's second ruling:** *Log Out warns, does not refuse.* A list of the held sales and "These stay on the till for the next cashier", then log out. **Close Shift is refused** while any sale is held or resumed: in the Admin screen (naming each sale) and in the main process (`closeShiftUnlessHeld`, called by `shifts:close`). |
| **12** Prices stay as held | Lines come back verbatim; `parseHeldPayload` only validates, never reprices. |
| **13** Per till, not per cashier | `held_sales` has no per-cashier filter; any signed-in cashier sees and resumes every held sale. |

Also: the **End of Day** page lists "Held sales discarded" (section 6).

## 3. The one change on the order-write path

Decision 1, option A. The sale's own transaction marks the held row completed. In `settleCartForOrder` ([database.ts:1913](../src/main/services/database.ts#L1913)), called once from the order insert ([database.ts:1873](../src/main/services/database.ts#L1873)), the added statement, [database.ts:1922](../src/main/services/database.ts#L1922):

```ts
this.conn
  .prepare(
    "UPDATE held_sales SET status = 'completed', order_local_id = ?, completed_at = ? WHERE cart_token = ? AND status IN ('held', 'resumed')"
  )
  .run(localId, new Date().toISOString(), cartToken)
```

It is an `UPDATE` on a non-fiscal table, inside the existing best-effort `try` (a failure there is logged and never aborts a sale), keyed by the `cartToken` the checkout already carries. Nothing else in the checkout, fiscal, payment-gate or Shopify code changed (the 24 files in section 5 run unmodified).

**Startup rules** (`recoverHeldSales`, run by `init()`):
- a row left at `resumed` goes back to `held` (a crash after resume returns it to the strip, prices unchanged);
- a cart draft whose `cartToken` matches a held sale that is **not `completed` is deleted**: the held row wins ([database.ts:1973](../src/main/services/database.ts#L1973)). So a sale is never restored twice and never repriced.

A resumed row also keeps a sale from being resumed twice (`resume` only moves `held` to `resumed`).

## 4. Where state lives now

- **`held_sales`** (new table): `id`, `cart_token`, `label`, `payload_json` (items, cart discount, customer PIN, company name), `total`, `line_count`, `unit_count`, `held_at`, `held_by_staff_id`, `status` (`held` / `resumed` / `completed` / `discarded`), `order_local_id`, `completed_at`, `discarded_at`, `discarded_by_staff_id`, `discard_manager_id`, `discard_reason`. A partial unique index allows one open row per `cart_token`, so a sale held, resumed and held again reuses its row and label. **No payment method, tendered amount or typed code is stored**; the request schema has no field for them (tested).
- **Cart store:** `customerPin`, `companyName`, `resumedHeld` added; `resumeHeldSale` (not `restoreCart`); `clearCart` clears all three.
- **`heldSalesStore`**, **`paymentActivityStore`**: new.
- **`PosCheckoutPanel`:** after a hold or a resume (`resetEpoch`), the method goes back to **Cash**, the tendered amount is cleared and the customer fields are gone, so nothing of the last customer's payment shows over the next cart. Unmounting the panels also drops any code typed in them.
- **IPC:** `held:list`, `held:hold`, `held:resume`, `held:rename`, `held:discard`, `held:discarded-for-day`.

## 5. Tests

**New: [heldSales.test.ts](../tests/heldSales.test.ts) (28)** and **[heldSalesUi.test.ts](../tests/heldSalesUi.test.ts) (37)**, the latter running the store, the components and the rules against a real in-memory database through a `window.api` shim:

- hold then resume restores every line, quantity, price, base price, discount, customer PIN, company name and token exactly;
- a held cart sends nothing: `checkout` is never called, no order, no `sync_queue` row, no trader number (`last_trader_seq` unchanged);
- hold refused while a Daraja push is waiting (a real `PaymentModal` driven to "Waiting for M-Pesa Confirmation"), while a manual code is typed, while a card reference is typed;
- a fourth hold refused; a resumed cart held again at the limit reuses its row; resume refused on a non-empty cart (and the strip offers hold-first, which then does both);
- **survives a restart** (a file database closed and reopened); **crash after resume** returns the row as held with prices unchanged; **the draft-versus-held conflict** on startup, in both cases, and a draft with another token is left alone; a draft whose held sale is `completed` is not dropped;
- completing a resumed sale marks the row `completed` with the order id in the order's transaction; a sale that cannot be created leaves the row `resumed`; it does not return after a restart;
- **two held sales completed with different payment methods make two separate sales**, each with its own total, payment method and (different) trader number;
- discard: wrong PIN, a cashier's PIN and no PIN all leave the sale held; an empty reason is refused; the record is complete; a resumed sale cannot be discarded; the strip's reason → PIN → record flow;
- Close Shift refused in the main process while a sale is held, and again while one is resumed, and allowed after the sales are completed or discarded; the Log Out warning lists the sales, says they stay for the next cashier, and its "Log out" still logs out;
- ageing with fake timers: normal → amber at 5 min → red at 15; the payment-panel banner (label and total in large type, before the code field); the checkout panel returns to Cash after a hold; the Hold button and the 7-versus-6 lines a page; the End of Day list.

**Existing tests changed: none.** Two existing tests were affected by my first attempts and the design was changed instead of the tests: `tests/shifts.test.ts` (its fake database does not answer a new query inside `closeShift`, so the held-sale refusal sits in `closeShiftUnlessHeld` in the service layer, not in `RubisDatabase.closeShift`) and `tests/endOfDayPage.test.ts` (its mock has no `getDiscardedHeldSales`, so the list fails soft and, with nothing to show, is absent).

**The 24 tripwire files, unmodified: 464 tests before, 464 after, every file's count identical.**

| File | Tests | File | Tests |
| --- | --- | --- | --- |
| mpesaPaymentGate | 24 | cartDraftDb | 17 |
| mpesaManualPayment | 28 | cartRemovalGuard | 4 |
| mpesaPaymentPoller | 9 | guardedCartActions | 13 |
| paymentModal | 15 | fiscalCheckoutDurability | 15 |
| runCheckout | 27 | fiscalEngine | 23 |
| checkout | 12 | fiscalNumberUniqueness | 8 |
| cartStore | 18 | fiscalIntegration | 25 |
| cartCheckout | 13 | belowLgUnreachable | 12 |
| cartDraft | 16 | noUnexpectedScroll | 24 |
| scale | 46 | screensFitDesignBox | 8 |
| posCheckoutPanelFit | 6 | posCheckoutPanelCard | 9 |
| posCheckoutPanelFiscalGate | 8 | doubleSizeRows | 84 |

**Mutation checks, each restored afterwards (the file was identical to its backup each time):**

| Mutation | Result |
| --- | --- |
| draft-versus-held rule removed (`recoverHeldSales` no longer deletes the draft) | 2 failed: the two draft-conflict tests |
| a sale completes without marking the held row completed | 5 failed: completion stamp, no return after restart, the two-sales test, the completed-draft test, Close Shift after completion |
| Hold keeps the payment method (the reset to Cash removed) | 1 failed: "goes back to Cash" |
| hold allowed during a waiting Daraja push (the payment check removed from `decideHold`) | 4 failed: the store, the typed code, the waiting Daraja push, the rule |
| resume allowed onto a non-empty cart | 2 failed: the store and the rule |
| discard without a manager PIN (`requireAdminPin` removed) | 2 failed: the PIN tests, in the service and in the strip |

## 6. Layout and `check:fit`

The app is zoomed into a fixed 1366×772 design box at every size, so one budget applies. The right-hand checkout panel has no slack and was not touched except where rule 8 replaces text with text. The strip goes in the left column: one row of up to three cards, **65 px high** (a cart line is about 72 px), and while any sale is held the cart shows **6 lines a page instead of 7**, so the column keeps its height.

`check:fit` now also presses the real **Hold sale** button to reach 1, 2 and 3 held sales (and resumes one for the M-Pesa and Card panels), seeds six discarded held sales through the real IPC for End of Day, and uses a new probe: **content clipped by an `overflow: hidden` box**, which the old census (page scroll and `auto`/`scroll` containers only) cannot see. A held state fails if it clips anything the no-held baseline did not, pushes Complete Sale off screen, makes the strip taller than 72 px, shows the wrong number of cards, or puts the cart footer lower than the baseline.

At 1366×768 @150% (the tightest size):

| State | Cards | Strip | Cart rows | Complete Sale bottom | Hold sale row bottom |
| --- | --- | --- | --- | --- | --- |
| Held 0 (baseline) | 0 | 0 px | 7 | 665 / 772 | 801 |
| Held 1 | 1 | 65 px | 6 | 665 / 772 | 795 |
| Held 2 | 2 | 65 px | 6 | 665 / 772 | 795 |
| Held 3 | 3 | 65 px | 6 | 665 / 772 | 795 |

Resumed sale on the M-Pesa and Card panels: banner "Customer 1 · Ksh 710.65", nothing newly clipped. The same pattern holds at all 9 sizes. **Hold sale row bottoms are below the window even in the baseline: see section 8.**

**End of Day:** the list is shown only when a held sale was discarded that day, first on the page (above the per-cashier totals, so the approving manager sees it), three rows a page. With none discarded it is absent and the page is exactly what it was; with six seeded it shows 3 rows and "Page 1 of 2", fully on screen.

**Fixes to `check:fit` itself, found on the way:** it never populated the cart (it clicked `.cursor-pointer`; the search bar picks a result on mouse down); it looked for an Admin card by exact text, so "Needs Attention" with its count badge ("1Needs Attention") was never found; and it looked for "Printer" under Integrations, which moved to Peripherals in phase 205 (and missed "Store Details"). Those lookups are fixed, and `CHECK_FIT_ONLY=<part of a case name>` runs one case while iterating (a real run leaves it unset). The newly reached screens fit.

## 7. Not verified

- **Paper and a real till.** Nothing was printed; the first real use is a sale held and resumed on the Enjoy till. No version was built, so nothing reached any till.
- **The real M-Pesa flows with a customer's phone:** the Daraja push and the manual code were driven by test stubs only.
- **A resumed sale on the Daraja STK tab shows no banner** (it has no code field).
- **A Daraja push that has already failed or timed out does not block a hold** (rule 7 names a push waiting). A customer who pays after the timeout is an existing risk of that screen, not new.

## 8. Observed, not changed

Recorded in `docs/KNOWN_GAPS.md`:
- **The End of Day page already runs past the design box when it has data:** on this PC's data at 1366×768 @150% the Approve button is at y 857 of 772 with nothing discarded. The old census could not see it.
- **A full cart page runs past the window when "Cached catalog (offline)" shows:** with 7 lines the cart footer is at 801 of 772. The strip keeps it no worse (795).

Also:
- The comment in `authStore.ts` saying Log Out closes the shift was wrong and is corrected (no behaviour change).
- A held sale's `total` is stored for display and for the discard record; the real total is recomputed when the sale is checked out.
- If a stored held cart cannot be read when resumed, the row is left `resumed` and the screen says to restart the till, which returns it to the strip. Not seen in use.
- Hold, resume, rename and discard do not appear in any log other than `held_sales` itself.

## 9. Affected files, impact, rollback

- **Main process:** `services/database.ts` (table, methods, the one `UPDATE` in `settleCartForOrder`, startup recovery), `services/held-sales.ts`, `lib/heldSaleRules.ts`, `lib/ipcValidator.ts`, `index.ts` (handlers; `shifts:close` calls `closeShiftUnlessHeld`), preload and `window.d.ts`.
- **Renderer:** `App.tsx`, `HeldSalesStrip`, `LogoutHeldWarning`, `PosCartTable`, `PosCheckoutPanel`, `PaymentModal`, `CardEntryPanel`, `AdminScreen`, `EndOfDayPage`, `cartStore`, `heldSalesStore`, `paymentActivityStore`, `lib/heldSale.ts`, `lib/toastTimeouts.ts`, `authStore.ts` (a comment), `types/shopify.ts`.
- **Tests and tooling:** `heldSales.test.ts`, `heldSalesUi.test.ts`, `scripts/check-fit.mjs`, `docs/KNOWN_GAPS.md`.
- **Impact:** a till with no held sales behaves as before, except that the cart's customer fields now live in the cart store and the cart footer has a Hold button. No fiscal request, payment-gate rule, Shopify call, trader number or receipt changed.
- **Rollback:** revert `cb776de` and this phase's commit. The `held_sales` table stays in an upgraded database and is never read by the older build, so it is harmless.
