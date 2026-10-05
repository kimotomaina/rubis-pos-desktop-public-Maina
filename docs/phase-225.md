# Phase 225 — Order History: the list scrolls, the title stays

- **Date:** 2026-10-05
- **Requested:** make the orders list scrollable, just the list, following the End of Day change (docs/phase-220).
- **Status:** built and tested.
- **Layout: to be checked by the owner on the till.** `check:fit` was not run and not extended (standing rule). Layout is covered by unit tests only.
- **Not changed:** what an order shows, Print Receipt, Print ETR copy, Retry Sync, the 50-order load (`getLocalOrders(50, 0)`), every other screen.

## 1. Audit

- [OrderHistory.tsx](../src/renderer/src/components/OrderHistory.tsx) paged its orders 10 at a time (`ORDER_HISTORY_PAGE_SIZE`, `paginate`, `Pager`) because the Orders wrapper in [App.tsx](../src/renderer/src/App.tsx) is `overflow-hidden` (docs/phase-166 E4).
- The no-scroll rule is `tests/noUnexpectedScroll.test.ts`; it has an exact-count allow-list, so no stop was needed. `OrderHistory.tsx` was in `ZERO_SCROLL_FILES`.

## 2. What changed

| Where | Change |
| --- | --- |
| [OrderHistory.tsx](../src/renderer/src/components/OrderHistory.tsx) | Root is `relative flex min-h-0 flex-1 flex-col`. The orders sit in one `touch-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto pr-2` region (`data-testid="order-history-scroll"`). Pagination removed: `paginate`, `Pager`, the page state and `ORDER_HISTORY_PAGE_SIZE` are gone; all loaded orders render. The same fade as End of Day (`useMoreBelow`) shows while more is below. Loading, error and empty states are unchanged. |
| [App.tsx](../src/renderer/src/App.tsx) | The Orders `<main>` is now `flex flex-col` (still `overflow-hidden`) and the "Order History" title is `shrink-0`, so only the list scrolls. No scroll class added to App.tsx. |
| [noUnexpectedScroll.test.ts](../tests/noUnexpectedScroll.test.ts) | `OrderHistory.tsx` moved from `ZERO_SCROLL_FILES` to `ALLOW_LIST` at 1. Old: expected 0. New: expected 1. No other entry changed. |

## 3. Tests

- `tests/orderHistoryPagination.test.ts` deleted: all three of its tests asserted the 10-a-page pager that no longer exists.
- New `tests/orderHistoryScroll.test.ts`, 4 tests: all 50 orders render with no pager or Next button; every order is inside the scroll region, which is `flex-1 min-h-0` with the visible-scrollbar class; it is the only vertical-overflow element in the list; the fade shows only while more is below (sizes set by hand, jsdom has no layout).

## 4. Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean (node and web) |
| `orderHistoryScroll` | 4 passed |
| `noUnexpectedScroll` | 24 passed |
| `screensFitDesignBox`, `belowLgUnreachable`, `etrCopy` | 8, 12, 5 passed |
| Full suite | **204 files, 3388 passed, 1 skipped** |

### For the owner to check on the till

1. Orders tab with many orders: the "Order History" title stays; only the list moves when swiped.
2. Scroll to the last order: nothing is cut off at the bottom.
3. Expanding an order (tap) grows it inside the list and the list still scrolls.

## 5. Rollback

Revert this commit. Order History goes back to 10 a page with a pager; `noUnexpectedScroll` lists it as zero again. Nothing stored, no setting, no IPC and no schema changed.
