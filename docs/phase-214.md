# Phase 214 — the device's VAT group amounts are gross: the slip's VAT table and its reconciliation corrected

- **Date:** 2026-10-03
- **Found in:** [phase-210-3.md](phase-210-3.md) finding 4, from the first live filing.
- **Requested:** correct the device-figures VAT table and its reconciliation.
- **Outcome:** done. Full suite **191 files, 3071 tests, all passing**; typecheck clean; `npm run build` passes with the no-mock check. Nothing was sent to the device, Shopify or KRA.
- **Branch / base:** staging on `7bb81cd`.

## 1. The evidence

Order 2 on 2026-10-03: one AQUAMIST PINEAPPLE 500ML, charged 90.00, filed as CU invoice `0110605040001000810`.
- The command the device received (the local fiscal server's log): `SellPLUfromExtDB … ;A;90;pcs; … ;16.00*1`, a price of 90.
- The group amounts the till stored from `ReadCurrentReceiptInfo`, verbatim: `{"A":"90.00","B":"0.00","C":"0.00","D":"0.00","E":"0.00"}`.
- **KRA's public verification page for that invoice** (the URL printed on the slip), read 2026-10-03: total invoice amount **90**, total taxable amount **77.59**, total tax **12** (12.41, shown rounded), supplier RUBIS ENERGY KENYA PLC.
- The slip printed `A 16% 90.00 14.40 104.40` and "Device figures. Till VAT: 12.41.", and the till logged "the device's VAT groups add up to VAT 14.4 but the till's VAT is 12.41".

So the device's group A amount (90.00) is the **gross** subtotal: KRA holds 90 gross, 77.59 net. The slip read it as net, added 16% on top (14.40, gross 104.40) and reported a false mismatch. The filed invoice was correct throughout; only the till's printed table and its reconciliation were wrong.

## 2. The code already disagreed with itself

- The **reports** (phase 159 and 163: `deriveGroupVat`, `buildReconciliationRow`) already read the groups as **gross**: VAT is `amount × 16/116`, and the device total is the plain sum of the groups, compared with the amount charged.
- The **slip's VAT table** (phase 198) and the **slip's reconciliation** (`lib/vatReconcile.ts`, phase 198-1) read them as **net**. `vatReconcile.ts` said so: "The device's own contract does not say net or gross (docs/phase-194 section 2b), so this reading stands until the live test." The live test is the evidence above.

## 3. What changed

- **`lib/vatClass.ts`:** new `grossToVat(letter, gross)`: the VAT inside a gross amount (A: × 16/116, B: × 8/108, C, D, E: none), rounded to two places. **`netGroupTotals` removed** (it only existed for the net reading; its two users changed). `grossToNet` stays. The `compareVatGroups` comment now says group A is gross and is covered by the sale-level total check.
- **`lib/receiptLayout.ts`:** the VAT table row takes the stored amount as **gross**: VAT is `grossToVat`, taxable is gross minus VAT, and the gross column is the stored amount. A sale of 90.00 prints `A 16% 77.59 12.41 90.00`. The table built from the lines (used when no device groups are stored) now uses the lines' VAT-inclusive totals as they are, which gives the same printed rows as before.
- **`lib/vatReconcile.ts`:** a group's VAT is the VAT inside its gross amount (`grossToVat`), so a gross group that agrees with the till no longer prints a "Device figures" note or a warning, and one that is lower than the sale does.
- **`services/reports.ts`:** `deriveGroupVat` now calls `grossToVat` for A and B, so the slip, the reconciliation, the Needs Attention list and the reports compute one figure from one function (the old arithmetic was the same formula written slightly differently).
- **`mock-etims-provider.ts`:** the development mock reports its groups **gross** (60.00 for a 60.00 sale), as the real device does.
- **Not changed:** the filing itself, any command sent to the device, the stored group strings (they are the device's own, so older rows are read correctly by the new code), the receipt layout apart from the VAT table row values, and `compareVatGroups`' exclusion of group A (the total check covers it).

## 4. Tests

**Existing tests changed, each with an OLD/NEW note in the file:**
- `tests/vatClassReceiptReports.test.ts`: the golden scenarios' stored groups `{A:'1422.41'}` and `{A:'1280.17'}` (net) became `{A:'1650.00'}` and `{A:'1485.00'}` (gross). **The golden layout file is unchanged**: both inputs print the same rows (`A 16% 1,422.41 227.59 1,650.00`, `A 16% 1,280.17 204.83 1,485.00`).
- `tests/vatReconcile.test.ts`: the `netGroupTotals` test became `grossToVat` tests; the reconcile tests use gross groups (`60.00` agrees with 8.28; `51.72` now disagrees: VAT 7.13 against 8.28, difference -1.15); the slip tests print `A 16% 44.59 7.13 51.72` for a lower-than-sale group where they printed `A 16% 60.00 9.60 69.60`; the mock reports 60.00 and `{A:'100.00', C:'1.00'}`; the Needs Attention list agrees for `60.00` and lists `51.72`.

**New, `tests/vatGroupsGross.test.ts` (15 tests), built from the live capture:** the slip prints `A 16% 77.59 12.41 90.00` and never `104.40`; no "Device figures" note and no warning; the reconcile returns consistent with group VAT 12.41; the fiscal reconciliation report row is `matched` (device total 90.00 against 90.00 charged, group A VAT 12.41); and, for ten amounts from 0.01 to 99,999.99, the VAT printed on the slip row equals the report's VAT and `grossToVat`.

**Mutation checks (each run, file restored, hash compared):** the slip table reading the group as net again: 6 or more tests fail (the live-sale figures and the slip-versus-report tests); the reconciliation reading it as net again: 6 or more fail (the live-sale tests and the golden layouts).

## 5. Not verified

- **Only class A was observed live.** B (8%) is read gross by the same reasoning and by the reports' existing 8/108 arithmetic; C and E have no VAT, so net and gross agree; D has no fixed rate and is not compared. No B, C, D or E sale has been filed on a real device.
- **A discounted sale** is blocked on a live till ("Discounts cannot be filed with KRA yet"), so the discount case against the device was not exercised.
- That the device's group amount stays gross for every sale; one sale was observed.

## 6. Rollback

`git revert` the commit. Stored groups are untouched, so nothing in the data needs undoing; a reverted build would again print a wrong VAT table whenever a device group is stored.
