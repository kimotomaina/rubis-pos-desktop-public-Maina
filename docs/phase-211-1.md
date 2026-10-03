# Phase 211-1 — the trader system invoice number from the location id: built

- **Date:** 2026-10-03
- **Follows:** [phase-211.md](phase-211.md) (the audit), under the owner's "go on all your recommendations": D1 accepted and recorded, D2 as proposed, `.immediate()` taken.
- **Branch / base:** staging on `c18634f`.
- **Outcome:** built and tested. Full suite **189 files, 3039 tests, all passing**; typecheck clean; `npm run build` passes with "neither mock provider is in out/main". **Not yet exercised against the control unit**: the device has refused every `OpenInvoice` on this till since 2 October (phase 206), so no number in the new form has been sent to it. The format is within the field's 15-character limit (`Type=Text MaxLen=15`, phase 207), and nothing tests that the device accepts letters in it.

## 1. The format

`L` + the location id in base 36 (uppercase, no padding: 7 characters today, 8 once an id passes 36^7 = 78,364,164,096) + a 6-character base 36 sequence = **14 or 15 characters**. Never more: the builder **throws** over 15, it does not truncate.

The sequence is whole seconds since 2026-01-01T00:00:00Z, but never below `last_trader_seq + 1`. A clock before 2026 counts as 0, then the guard applies (D2). The value used is stored in `settings.last_trader_seq`.

Examples for a sale at 2026-10-03T00:00:00Z (seconds 23,760,000, `0E59C0`): Rubis Kisumu **`LZMO0VON0E59C0`**; Enjoy Haile Selassie **`LZZYNW4N0E59C0`**. The seven location ids and their codes were confirmed by a fresh read of the store's locations by curl on 2026-10-03 (same seven as in phase 211 section 4).

## 2. What changed

- **`lib/traderSystemInvoiceNumber.ts`:** `locationCode`, `nextTraderSeq`, `buildLocationTraderInvNum`, `resolveTraderSystemInvNum` beside the unchanged legacy `buildTraderSystemInvNum` (which still truncates, as its old tests pin).
- **`database.ts`:** `queueOrder` allocates the number **inside the sale's own transaction** (`allocateTraderInvNum`), writes it to `orders.fiscal_trader_inv_num`, passes it to `buildFiscalRequest(localId, traderInvNum)` and returns it on `QueuedOrder`. The transaction is now `.immediate()` (the sequence is read, advanced and written in it). A sale with no location gets no number. A location id that cannot build a number aborts the whole sale write. `getOrdersForDateRange` and `getOrderRowsForRange` now select `fiscal_trader_inv_num`.
- **`etims.ts`:** `FiscalInvoiceRequest.traderInvNum?`. It is stored with the sale and sent unchanged on every retry (the stored request and the queued row carry it).
- **`checkout.ts`:** the request for the immediate filing is built with `queued.traderInvNum`. **I caught a defect here before commit**: the immediate filing call rebuilt the request without the number, so the device would have received the legacy `INV-<id>` form while the order and the stored request held the new one. A test now pins it (mutation 4).
- **`real-etims-provider.ts`:** sends `request.traderInvNum` when present; the legacy form is built only for a request with none (a sale created before this phase), so a part-filed old sale keeps its number.
- **`mock-etims-provider.ts`:** records `resolveTraderSystemInvNum(...)`, the same function the readers use, so the recorder and the real path cannot drift.
- **The four readers** (`index.ts` invoice list, `reports.ts` reconciliation row, `reportsExport.ts` orders.csv and lines.csv) read the stored number first and use the legacy form only on NULL. The receipt already read the stored column.
- **`checkoutLocation.ts`:** a location id that is not `gid://shopify/Location/<digits>` now counts as unset, so a malformed id (an env override, say) is refused at checkout with the existing "no shop location" message instead of failing inside the number builder.
- **`docs/KNOWN_GAPS.md`:** the same-location collision, the wiped-database limit and the pre-2026 clock (D1 and D2).
- **Not touched:** `tests/traderSystemInvoiceNumber.test.ts` (the legacy helper and the provider's legacy form stay byte-identical), the single-instance lock, shift windows, the `0x32` notice, any device command.

## 3. Tests

**Existing tests changed (old/new note in each file):** the `transaction` fake in `tests/database.test.ts` and `tests/shifts.test.ts` now also exposes `.immediate` (OLD a plain function; NEW the same function with an `immediate` property). `tests/locationSlug.test.ts` gained two refused ids (a bare number, a product gid).

**New, `tests/traderNumberFromLocation.test.ts` (36 tests):**
- Both code lengths: `ZMO0VON` and `ZZYNW4N` (7), `10000000` at 36^7 (8, total 15).
- The ceiling: a 9-character code throws rather than truncating; a sequence over 6 characters, negative or fractional throws; a bad or empty location id throws.
- The sequence: consecutive for two sales in one second; never repeats after the clock is set back; a pre-2026 clock counts as 0 and the guard still applies.
- Inside the real database: the number is stored on the order, in the stored fiscal request and in the queued row; `last_trader_seq` is remembered; two sales in one second get `…E59C0` then `…E59C1`; a clock set back does not repeat; **a wiped database continues from the clock, not from 1**; a sale with no location gets no number and files under the legacy form; a bad location id aborts the whole sale write (no order row).
- **The real `runCheckout`:** the request handed to the device carries the same number that was stored on the order.
- The real provider sends the stored number unchanged, and the same number again on a retry; a 15-character number passes the sanitiser uncut; a sale with no stored number files as `INV-000000042`.
- The mock and the real provider agree, for a stored number and for none.
- The readers show the stored number and fall back only on NULL: orders.csv, lines.csv, the reconciliation row.

**Not tested directly:** the invoice list in `index.ts` (it needs Electron); it uses the same `resolveTraderSystemInvNum` as the tested readers, and the query that feeds it now selects the column. `tremolConformance` and the legacy trader-number tests pass unchanged.

## 4. Mutation checks (each run, file restored, hash compared)

| Mutation | Result |
| --- | --- |
| Sequence not padded | 8 tests fail (examples, lengths, padding, ceiling, and the four database allocation tests) |
| Monotonic guard not applied | 5 tests fail (consecutive, clock set back, pre-2026, and the two database equivalents) |
| Ceiling not enforced | 1 test fails (the throw rather than truncate) |
| Checkout files without the stored number (the defect above) | 1 test fails (the `runCheckout` request test) |

## 5. Not verified

- That the control unit accepts a trader number in this form. No `OpenInvoice` has been accepted since 2 October.
- Two-process behaviour of the allocation; `.immediate()` is there for it, and the single-instance lock is a separate item.
- The receipt layout and its tripwire tests against a 14-character number: the suite passes, but none of its fixtures hold a new-form number; the key/value line fits 32 columns and above (phase 211 section 1).
- The narrowest receipt width the till can be set to.

## 6. Rollback

`git revert` the commit. Sales created under it keep their stored numbers in `orders.fiscal_trader_inv_num`; after a revert the provider ignores `request.traderInvNum` and the readers recompute the legacy form, so such a sale would show and file under `INV-<id>`. Do not revert after a new-form number has reached the device.
