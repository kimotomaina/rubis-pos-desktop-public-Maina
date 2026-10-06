# Phase 253-1 — Sync button, sync at start and login, discount copy

- **Date:** 2026-10-07
- **Asked by the owner:** the 00:40 file. It asks for:
  - one catalogue sync (products, prices and stock, plus the automatic discounts);
  - a Sync button in the top bar;
  - a sync at start and after every login;
  - no change to any price.
- **Follows:** [phase-253-audit.md](phase-253-audit.md), rulings D1, D2, D7 and D8. 253-1 may ship alone.
- **Status:** built and tested in one commit. Not released. No version bump and no installer. 2.2.10 is left as it is.
- **Standing rules kept:**
  - nothing was sent to Shopify, the device or Safaricom; every Shopify reply in the tests is a fake;
  - the app was not launched;
  - no `check:fit`.

## What changed

| File | Change |
| --- | --- |
| [lib/autoDiscounts.ts](../src/main/lib/autoDiscounts.ts) (new) | `AutoDiscount`: an automatic Buy X get Y as the till stores it (`buysQuantity`, `getsQuantity`, `variantIds`, `productIds`, an amount or percentage `effect`, `usesPerOrderLimit`, `startsAt`, `endsAt`). `SkippedDiscount` is a title plus the reason |
| [shopify-discounts.ts](../src/main/services/shopify-discounts.ts) (new) | `AUTOMATIC_DISCOUNTS_QUERY` (`discountNodes`, 5 per page, paged) and `mapDiscountNode`, by D1 (table below). `fetchAutomaticDiscounts`: any failed page fails the whole read. A missing scope gives "Discounts not read: the Shopify token has no read_discounts access" |
| [catalog-sync.ts](../src/main/services/catalog-sync.ts) (new) | `createCatalogSync`, detailed below |
| [database.ts](../src/main/services/database.ts) | Table `auto_discounts (id, title, discount_json)`, created at start like every other table. `replaceCatalogue` replaces the products and/or the discounts and stamps `catalog_synced_at`, in **one transaction**. `getAutoDiscounts`, `getCatalogSyncedAt`. `cacheProducts` behaves exactly as before; its row writing moved into `writeProducts`, which both callers use |
| [shopify.ts](../src/main/services/shopify.ts) | **Observed item 2 fixed:** a stock page with errors or no levels now fails the whole stock read, where before it stopped there and returned part of the stock. `translateAxiosError` is exported for the discount reader |
| [index.ts](../src/main/index.ts) | The `catalog:sync` handler. Demo Mode answers with its own copy and never calls Shopify |
| `preload/index.ts`, `window.d.ts` | `catalogSync()` |
| [productStore.ts](../src/renderer/src/stores/productStore.ts) | `sync()`, `discounts`, `lastSyncedAt`, `syncing`. It never throws. When a sync fails and nothing is on screen yet, it shows the error |
| [SyncButton.tsx](../src/renderer/src/components/SyncButton.tsx) (new) | The top-bar button and "Last synced HH:MM" (Africa/Nairobi), or "Not synced yet". Disabled while the cart has items, while a payment is in progress (`isPaymentInProgress`), and while a sync runs. After a press, a toast shows "N products, M discounts.", then "Skipped: titles." and any part not refreshed |
| [App.tsx](../src/renderer/src/App.tsx) | The start-up fetch became the sync, and so did the "Try again" button. The Sync button sits before the status button |
| [authStore.ts](../src/renderer/src/stores/authStore.ts) | After a successful login: `void useProductStore.getState().sync()`. Not awaited |
| `toastTimeouts.ts` | `SYNC_RESULT_TOAST_TIMEOUT_MS` (8 s) |

**What `createCatalogSync` does:**
1. With a cart draft saved, it makes **no Shopify read**. It answers with the copy as it is and `refused: true`: "Not synced: a sale is in progress. Finish or clear the cart, then sync."
2. Otherwise it reads products and discounts together, and writes one transaction:
   - **products** are replaced only by a complete, non-empty read. **Observed item 1 is fixed** for the sync: an empty read keeps the copy and says so;
   - **discounts** are replaced only by a complete read;
   - the time is stamped only when products were replaced.
3. A sync asked for while one runs **joins** it: one read each.
4. A read that throws (a bad store URL) counts as a failed read.

**The discount shape the till accepts (D1).** Anything else is skipped and listed by title with the reason. An `EXPIRED` discount is left out of both lists.

| Must be | Field | Reason given otherwise |
| --- | --- | --- |
| an automatic Buy X get Y | `__typename` `DiscountAutomaticBxgy` | e.g. "amount off products: not applied by the till in version 1", "discount code: not applied by the till" |
| for all customers | `context` `DiscountBuyerSelectionAll` | "not for all customers" |
| one-time purchases | `customerBuys.isOneTimePurchase`, `customerGets.appliesOnOneTimePurchase` | "not for one-time purchases" |
| a quantity on both sides | `DiscountQuantity`, `DiscountOnQuantity` | "the customer must spend an amount, not buy a quantity" |
| an amount off **each**, or a percentage | `DiscountAmount` with `appliesOnEachItem`, or `DiscountPercentage` (0 < p ≤ 1) | "not an amount or percentage off each item" |
| the same specific products on both sides, each list complete in one read (≤ 20) | `DiscountProducts` | "not a short list of specific products", "the customer buys and gets different products" |

The "POS excluded" box is not read, because the API has no such field (D2).

## Tests

| File | Tests | What |
| --- | --- | --- |
| [catalogSync.test.ts](../tests/catalogSync.test.ts) (new, real `:memory:` SQLite) | 9 | a good sync replaces both copies and stamps the time; twice gives the same copy; a failed discount read keeps the discounts and refreshes products; the missing scope gives the message, the same way; a failed product read keeps the products and the old time and still refreshes discounts; an empty product read keeps the copy; a read that throws is a failure, not a crash; a cart draft refuses the reads and answers with the copy; a second sync while one runs joins it |
| [shopifyDiscounts.test.ts](../tests/shopifyDiscounts.test.ts) (new) | 20 | the pairs discount mapped; a percentage and a cap mapped; expired left out; each of the 7 other kinds skipped by title; 7 Buy X get Y shapes skipped with their reasons; every page read and listed; the missing scope; a failed later page fails the whole read |
| [syncButton.test.ts](../tests/syncButton.test.ts) (new, real mount) | 7 | enabled when empty, one press is one sync; disabled with items, and a press does nothing; disabled during a payment; "Last synced 09:05" in Nairobi time and the result message with the skipped title; login completes while the sync never answers; login goes on with Shopify unreachable, keeping the copy on screen |
| [pagination.test.ts](../tests/pagination.test.ts) | 2 added | a later stock page with no levels fails the read; a stock page with errors fails it |

### Mutation checks (each restored; the file compared byte for byte afterwards)

| # | Mutation | Failing tests |
| --- | --- | --- |
| 1a | A failed discount read replaces the copy | 2: the failed read and the missing scope |
| 1b | A stock read that stops part-way returns part of the stock | 1: "fails, rather than shrinking the catalogue…" |
| 2 | The button syncs with items in the cart | 1: "is disabled while the cart has items…" |
| 3 | Login awaits the sync | 1: "login completes without waiting for the sync" |
| 4 | An empty product read replaces the copy | 1: "an empty product read keeps the copy…" |

## Existing tests changed (each with a note in the file)

| Test | OLD | NEW |
| --- | --- | --- |
| `rehearsal/paulCopy.test.ts` table counts | no `auto_discounts` | `auto_discounts: 0`: opening the copy adds the empty table |

`pagination.test.ts` gained two tests; none of its existing ones changed. No other test changed. No test mounts `App`.

## Behaviour to know

- **At start, before anyone logs in,** the sync runs as the fetch did. After a crash with a saved cart it is refused, and the till sells from its copy until the next login or Sync press with an empty cart.
- **After every login** a sync runs in the background. A cashier who logs in with items in the cart keeps the cart unchanged, because the sync is refused.
- **"Last synced"** is the time the products were last read in full. A sync that refreshed products but not discounts (the missing scope, today) still moves it; the toast says what was not read.
- Until the owner adds `read_discounts` (D7), every sync says the discounts were not read. Products and stock refresh as before.
- **The location change and the stock take still use `products:fetch`,** unchanged. Observed item 1 still applies to them: an empty read shows an empty catalogue there.

## Rollback

Revert the commit:
- the start-up fetch and "Try again" go back to `products:fetch`;
- the button goes;
- the `auto_discounts` table stays, unread;
- the `catalog_synced_at` setting row stays, unread.

## Not verified

- **The query against Shopify:** no Shopify call in this run. Every field was checked offline against the store's saved 2026-07 schema (`__schema` reply of 2026-10-06), but the query cost and the real reply are not checked. The first sync after D7 is the check.
- **The top bar with the button and the label is not measured** (no `check:fit`).
- Whether Shopify sends `percentage` as 0–1. A value outside (0, 1] is skipped, not applied.

## Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| Full suite | 241 files passed, 2 skipped (the copy rehearsals); 3,933 tests passed, 10 skipped |
| Copy rehearsals on a temp copy of the 1606 copy | 9 of 9; the copy unchanged by SHA-256 |
| Mutation checks | 5 of 5 caught, every file restored byte for byte |
| `npm run build` | passed |
