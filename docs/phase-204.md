# Phase 204 — Store Details gets its own card

- **Date:** 2026-10-03
- **Requested:** give Store Details its own card (it had been moved under Shopify in phase 202).
- **Outcome:** Implemented. Typecheck clean; vitest **183 files, 2936 tests, all passing** (2935 before); `npm run build` passes with the no-mock check. `check:fit` not run; no device calls.
- **Branch / base commit:** staging on top of `8066a0f` (phase 203).

## 1. What changed

In [AdminScreen.tsx](../src/renderer/src/components/AdminScreen.tsx):

- **A sixth card on the Integrations grid:** `Store Details`, second after Shopify (Shopify, Store Details, Location, Fiscal Device, M-Pesa, Printer). It reuses the document-chart icon (the Reports card's); there was no dedicated icon.
- **Its own section** with an `h3` "Store Details", the same six fields in the same two-column grid (three rows of two), its own message and `Save Store Details`, moved verbatim out of the Shopify card. Fields, keyboard modes and `handleSaveStoreIdentity` are unchanged.
- The Shopify card is back to the connection row (store URL and token) alone; Fiscal Device is unchanged from phase 202.
- The breadcrumb reads `Admin › Integrations › Store Details` with no extra code.

## 2. Tests

- **`tests/adminStoreDetails.test.ts` rewritten for the new place (8 tests, was 7):** the card is on the grid and opens to the six fields and its save; neither the Shopify nor the Fiscal Device card has them or the save; two-column grid in the stated order; saved values load; the Shopify row keeps the store URL and token as its two halves.
- **Existing tests changed, because the place changed (modes, secrets and the saved payload are untouched; each change carries an old/new note in the file):**
  - `tests/adminScreen.test.ts`: the six Store Details cases and the KRA PIN save test are reached through the `Store Details` card (they went through `Shopify` after phase 202).
  - `tests/adminIntegrationsSections.test.ts`: the card-order test is now six cards in order; the save-message test expects `{storeIdentityMessage &&` in the Store Details section only; "folds Store Details into Shopify" became "keeps Store Details in a section of its own" and asserts neither Shopify nor Fiscal Device mentions it. The original wording of that test asked for no "unlisted sixth section"; this phase makes it a deliberate one.
- No mutation check: a move, with both ends asserted.

## 3. Flags

- Not seen on a screen: six cards in a three-column grid is two full rows.
- The icon is borrowed; a dedicated one is a small follow-up if wanted.

## 4. Rollback

`git revert` the phase 204 commit (Store Details returns to the Shopify card). Nothing is stored or migrated.
