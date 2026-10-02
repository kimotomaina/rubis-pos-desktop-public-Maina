# Phase 202 — Store Details moves to the Shopify card

- **Date:** 2026-10-03
- **Requested:** move the Store Details block out of the Fiscal Device settings and into the Shopify tab, two fields per row. (Also told: the fiscal device IP is now 154.79.253.245.)
- **Outcome:** Implemented. Typecheck clean; vitest **183 files, 2932 tests, all passing** (182 and 2928 before); `npm run build` passes with the no-mock check. `check:fit` not run; no device calls.
- **Branch / base commit:** staging on top of `98d147d` (phase 201).

## 1. What changed

- In [AdminScreen.tsx](../src/renderer/src/components/AdminScreen.tsx) the whole Store Details block (heading, the six fields, its own message and its Save Store Details button) moved from the end of the Fiscal Device section to the end of the Shopify section, after the Admin API Token. Moved as it was, re-indented only: same fields, same keyboard modes, same `handleSaveStoreIdentity`, same message state.
- **Two to a row:** the block was already a two-column grid, so it is three rows of two: Store name, Store KRA PIN; Legal name, Shop name and address; Phone, Receipt footer message. A test pins the grid and the order.
- The Fiscal Device card now holds only its own fields, Test connection and Save Fiscal Device Settings.
- Store Details values load with the rest of the Integrations settings, so they are there when the Shopify card opens.

## 2. The fiscal device IP

Nothing to change in code. The IP is a saved setting, not a default: the Admin screenshot shows it saved as 154.79.253.245, and a read of the local settings (secrets excluded) confirms `deviceIp` is `154.79.253.245`, port `8000`, server `http://localhost:4444/`. The old address, 192.168.2.235, is not hardcoded anywhere in the source.

## 3. Tests

- **New: `tests/adminStoreDetails.test.ts`, 4 tests:** Store Details is on the Shopify card after the token with all six fields and its save button; it is gone from the Fiscal Device card, which keeps its own save; the six fields sit in a two-column grid in the stated order; the saved values load into them.
- **Existing tests changed, because the location changed (assertions about modes, secrets and the saved payload are untouched; each change carries an old/new note in the file):**
  - `tests/adminScreen.test.ts`: the six Store Details cases and the KRA PIN save test are now reached through the Shopify card instead of Fiscal Device (a `card` per case).
  - `tests/adminIntegrationsSections.test.ts`: "shows each Integrations section its own save message" now expects `{storeIdentityMessage &&` in the Shopify section and not in the Fiscal Device one; "folds Store Details into Fiscal Device" became "folds Store Details into Shopify" and also asserts the Fiscal Device section has neither the heading nor `storeKraPin`.
- No mutation check this time: the change is a move, and the new tests assert both ends of it.

## 4. Flags

- Not seen on a screen. The Shopify card is now taller (URL, token, then three rows of fields); layout guards pass.
- The Shopify section's Save Token and Save Store Details are separate buttons with separate messages, as the two were separate before.

## 5. Rollback

`git revert` the phase 202 commit. Nothing is stored or migrated.
