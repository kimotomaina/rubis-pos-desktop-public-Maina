# Phase 203 — Shopify store URL and Admin API token on one row

- **Date:** 2026-10-03
- **Requested:** on the Shopify card, the connection (store URL) and the token side by side in a row.
- **Outcome:** Implemented. Typecheck clean; vitest **183 files, 2935 tests, all passing** (2932 before); `npm run build` passes with the no-mock check. `check:fit` not run; no device calls.
- **Branch / base commit:** staging on top of `387295f` (phase 202).

## 1. What changed

In [AdminScreen.tsx](../src/renderer/src/components/AdminScreen.tsx), the Shopify card's store URL and Admin API token were stacked, the token under a rule. They are now two columns of one grid row:

- **Left:** a `Store URL` heading, the field, its message and `Save Store URL`.
- **Right:** the `Admin API Token` heading, the field, its message and `Save Token`.
- The token's `Status: Configured / Not configured` line moved up to sit beside its heading (right-aligned, same colours), so both columns start their fields at the same height. The word "Status:" is dropped from it; the wording is otherwise unchanged.
- Store Details stays below the row, as phase 202 left it.
- Handlers, keyboard modes (the token still masks), messages and save buttons are unchanged.

## 2. Tests

- **Added to `tests/adminStoreDetails.test.ts`, 3 tests:** the store URL and the token are the two children of one two-column row; each half keeps its own save button and the token status sits with its heading; Store Details is below the row, not in it.
- **Changed existing `expect()`: zero.** The existing Shopify field and save tests pass untouched (they find fields by label and buttons by text).

## 3. Flags

- Not seen on a screen. Each half is about half the card's width, so a long store URL scrolls inside its field rather than wrapping.
- The left column's heading repeats its field label ("Store URL"), as the right column's heading sits above "New Token".

## 4. Rollback

`git revert` the phase 203 commit. Nothing is stored or migrated.
