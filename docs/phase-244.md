# Phase 244 — An admin can override the freeze of a closed shift that is not the latest

- **Date:** 2026-10-06
- **Asked by the owner:** phase 243's freeze stays the default; add ONE override, admin only, for Move a sale (out of and into a closed shift that is not the latest) and for Correct figures (a closed shift that is not the latest), enforced in the database methods and not only on screen.
- **Why now:** the repair of 5 Oct cannot be done in the app without it. Order #85 (M-Pesa 60.00, 17:34:57) sits in closed shift #1 and belongs to the Day shift #3, which is frozen: rehearsed on the exported copy, the move and the correction of #3 were refused by phase 243's two rules and nothing could be written.
- **Status:** built and tested. Not published. An installer was built as 2.2.8 (see 6), not released.
- **Layout: not checked by check:fit (owner's rule). For the owner to check on the till.** Two new tick boxes (Move a sale; Correct figures), and Correct figures is offered again on a Locked shift.
- **Not changed:** merges, `closeShift`, automatic assignment and the automatic merge, checkout, fiscal and Shopify code, payments, End of Day, printing.

## 1. The rule, as built

Phase 243 refuses by default. With `override: true` the database methods lift exactly these, and only for an active admin with a reason of 10 or more characters (trimmed):

| Request | Refused by default (phase 243) | Lifted by the override | Never lifted |
| --- | --- | --- | --- |
| `reassignSale` | a sale leaving a **closed** shift; a sale given to a closed shift that is not the latest | both | a voided sale, a missing order or shift, a sale with no shift, the same shift, a blank reason, the different-window tick |
| `addShiftCorrection` | a closed shift that is not the latest closed one | yes | an open shift, a missing shift, a blank reason, "nothing has changed" |

- **Enforced in the database:** `requireOverrideAllowed` runs inside the write transaction of both methods when `override === true`: the id must be an active `admin` row (`OVERRIDE_ADMIN_ONLY_MESSAGE`), and the trimmed reason 10+ characters (`OVERRIDE_REASON_MESSAGE`). A cashier, an unknown id and a deactivated admin are refused.
- **PIN:** `shifts:move-sale` and `shifts:correct` already call `requireAdminPin` before the database; unchanged, and a test pins that it comes first and that `override` is passed on.
- **The stored reason:** `OVERRIDE (closed, not latest): <reason>` on both adjustment rows of a move and on the correction row, so the Z report shows it was forced. The mark is written only when a rule was actually lifted; a move or correction that needed no override is stored as it always was.
- **The till never overrides:** `autoAssignUnattachedSales` and the automatic merge do not take or read the flag. A test files a late sale into a frozen shift and checks the record has no mark and names nobody, and that the automatic code contains no `override`.

### Two things to know

1. **Out of any closed shift, not only one "not the latest".** The request says to move a sale out of a closed shift that is not the latest, but its own rehearsal moves #85 **out of #1, which is the latest closed shift** (phase 243 refuses a sale leaving any closed shift). So the override lifts "a sale cannot leave a closed shift" for every closed shift. The label on the tick is the owner's wording.
2. **#85 needs the different-window tick.** Its time (17:34:57) is in the Night window, shift #3 is a Day shift that ended 17:30:59. The rehearsal passes the preview's `differentWindow`, as the screen's second tick does. The override does not lift that rule.

## 2. Audit

- **Callers:** `reassignSale` and `previewSaleMove` (IPC `shifts:move-sale`, `shifts:move-sale-preview`, `MoveSaleForm`), `addShiftCorrection` (IPC `shifts:correct`, `ShiftCorrectionForm`). No other caller; the automatic code and the merge use `recordAdjustment` and `performMerge` and are not affected.
- **Tests that pinned phase 243's source text and screens** were changed with a note in the file (see 5). No assertion about the database's behaviour without the override changed; two screen assertions did (below).
- **Schema:** none. The mark is part of the existing `reason` text; no column, no migration.
- **Prior art:** `docs/phase-243.md` §7 asked: "say if a way for an admin to lift the lock is wanted". This is it.

## 3. What changed

| Where | What |
| --- | --- |
| [shiftRules.ts](../src/main/lib/shiftRules.ts) | `OVERRIDE_REASON_PREFIX`, `OVERRIDE_REASON_MIN_LENGTH` (10), and the two refusal messages. |
| [database.ts](../src/main/services/database.ts) | `ReassignSaleInput.override`, `AddShiftCorrectionInput.override`. `previewSaleMove(orderId, toShiftId, override = false)`: the two closed-shift refusals are one value, returned as `problem` with `overridable: true` unless `override`, in which case the preview computes the figures and says `overridden: true`. `requireOverrideAllowed`. `reassignSale` and `addShiftCorrection` call it first, preview or check with the flag, and store the marked reason when a rule was lifted. |
| [ipcValidator.ts](../src/main/lib/ipcValidator.ts), [sale-moves.ts](../src/main/services/sale-moves.ts), [shift-corrections.ts](../src/main/services/shift-corrections.ts) | `override` as an optional boolean in `moveSalePreviewSchema`, `moveSaleSchema`, `shiftCorrectionSchema` and the two request types. The 10-character rule is in the database, not the schema. |
| [index.ts](../src/main/index.ts) | The two handlers pass `override`; the preview handler passes it; `reports:z-report` adds `frozenMessage` next to `frozen`. |
| [reports.ts](../src/main/services/reports.ts), [preload](../src/preload/index.ts), [window.d.ts](../src/preload/window.d.ts) | `ZReport.frozenMessage`; `previewSaleMove(orderId, toShiftId, override?)`. |
| [MoveSaleForm.tsx](../src/renderer/src/components/MoveSaleForm.tsx) | When the refusal is one an override would lift, the problem shows as before plus the tick **Override: this shift is closed and not the latest**. Ticking asks the main process for the preview with the rules lifted (so both shifts' figures and the different-window tick show); un-ticking goes back to the refusal; the move sends `override: true`. |
| [ShiftCorrectionForm.tsx](../src/renderer/src/components/ShiftCorrectionForm.tsx) | On a frozen shift: the refusal text, the same tick, and **Record correction** disabled until it is ticked; the PIN prompt follows as now; sends `override: true`. |
| [ZReportModal.tsx](../src/renderer/src/components/ZReportModal.tsx), [ReportsPage.tsx](../src/renderer/src/pages/ReportsPage.tsx) | The Correct figures button is offered on a Locked shift too, because it opens the form above. The Locked tag stays. A merged shift still has none. |

## 4. Tests

[shiftOverride.test.ts](../tests/shiftOverride.test.ts), 22 tests on real `:memory:` SQLite (yesterday morning frozen, yesterday night the latest closed, today open):
- without the override both rules refuse, the preview says `overridable`, nothing is written;
- with it: out of a closed shift and into a frozen one, both records marked, the Z report shows the marked reason; out of a frozen shift into the open one; a move that needed no override is not marked; the preview with the rules lifted;
- refused for a cashier, an unknown id and a deactivated admin, whether or not a rule would be lifted; a reason under 10 characters (after trimming) refused, exactly 10 accepted, blank still refused;
- still refused with it: a voided sale, a missing order, a sale with no shift, the same shift, a missing shift; an open shift and a missing shift for a correction;
- run twice: the second move is refused (`already in shift`) and changes nothing; a repeat correction is refused as nothing changed; all or nothing: a failure while recording leaves the sale where it was;
- a correction with the override, then a normal correction of the latest closed shift, both work; the latest shift's correction is not marked;
- the till's own assignment is not marked and names nobody; the automatic code contains no override;
- the handlers re-verify the PIN before the write and pass the flag; the database methods call the guard; the schemas take a boolean and nothing else.

[shiftOverrideUi.test.ts](../tests/shiftOverrideUi.test.ts), 7 tests: the refusal and the tick; no Move without it; ticking re-previews with the rules lifted and sends `override: true` with the PIN; un-ticking goes back; no tick for a refusal an override cannot lift; Correct figures disabled until ticked, sends `override: true`; no tick and no `override` key on the latest closed shift.

[tests/rehearsal/paulCopy.test.ts](../tests/rehearsal/paulCopy.test.ts), 8 tests, **skipped unless `RUBIS_COPY_DIR` is set** (CI unaffected). It copies the three files to a temp folder, never writes the copy, and through the real methods with the override moves #85 from #1 to #3, then corrects #3 and #1. Run on `rubis-db-copy-2026-10-06-1606`:

| Check | Result |
| --- | --- |
| Shift #3 | 42 orders, cash 3,790.00, M-Pesa 19,180.09, card 280.00, revenue 23,250.09; correction: counted 3,790, difference 0.00, M-Pesa check 0.00 |
| Shift #1 | 59 orders, cash 4,271.14, M-Pesa 13,445.00, card 0; correction: expected 4,271.14, counted 5,210, **+938.86**, M-Pesa check **−1,093.86** |
| Orders | 180, each in exactly one shift; the only change in the table is order #85's `shift_id` 1 → 3; no order in two Z reports |
| Shift #8 | byte-identical, open |
| Row counts | `shift_adjustments` +2, `shift_adjustment_sales` +2, `shift_corrections` +2; every other table, including `orders` and `shifts`, unchanged |
| Second run of the move | refused (`already in shift #3`), nothing changed |

Both final Z reports print as `renderZReport` lines in the test output (run with `RUBIS_COPY_DIR` set).

### Mutation checks (each restored; `database.ts` compared byte for byte afterwards)

| # | Mutation | Failing tests |
| --- | --- | --- |
| 1 | Override accepted without an admin id (role and active check removed) | 2: `Move a sale: with the override > is refused for an id that is not an active admin…`; `Correct figures: with the override > is refused for an id that is not an active admin` |
| 2 | Override accepted for an open shift | 1: `Correct figures: with the override > still refuses an open shift and a missing shift` |
| 3 | Reason prefix dropped | 4: the two override moves, `lets an admin correct a closed shift that is not the latest, and marks the stored reason`, and `works with a normal correction of the latest closed shift after it…` |
| 4 | Automatic assignment given the override mark | 2: `the till never uses the override > files a late sale into a frozen shift by its own rule…` and `has no override in the automatic code at all` |

### Existing tests changed (each with an old/new note in the file)

| Test | Old | New |
| --- | --- | --- |
| `frozenShifts.test.ts`, "is enforced in the main process" | pinned `if (this.isFrozenShift(shift)) {` and `if (this.isFrozenShift(to)) return` in `database.ts` | pins the same two refusals in their new form (`if (overridden && input.override !== true) {` and the `freezeProblem` expression) |
| `frozenShiftsUi.test.ts`, Shift History row and Z report | a Locked shift has **no** Correct figures | a Locked shift keeps the Locked tag **and** has Correct figures (it opens the override form) |
| `oneShiftPerWindowUi.test.ts` (setup only) | the preview fixture | gains `overridable: false, overridden: false` (marked `ADDED (docs/phase-244)`) |

## 5. Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| Full suite | 223 files passed, 1 skipped (the rehearsal); 3,692 tests passed, 9 skipped (8 rehearsal, 1 pre-existing build-freshness) |
| Rehearsal against the exported copy (`RUBIS_COPY_DIR` set) | 8 of 8 passed |
| `npm run build` | passed, `verify-no-mock-provider` confirmed |
| `npm run dist` | built, `.env` bundling verified; **not published** |

## 6. The installer

- **`RUBIS POS Setup 2.2.8.exe`**, SHA-256 `fe9270465d77a7ea5e36cf92b98c5cc2f30cffd59afac88b1168533b466268a0`; portable `RUBIS POS 2.2.8.exe`, SHA-256 `7c61abef0e5e21ac501f821a6c96808b1147c408974f844d4c24f9bef59c95aa`.
- **Why 2.2.8:** `release/` already holds a `2.2.7` build made this morning from phases 240 to 242. Building again as 2.2.7 would have overwritten it, and a till on 2.2.7 would never see a second "2.2.7" as an update. It was built with `npm run dist -- --config.extraMetadata.version=2.2.8`, so **`package.json` still says 2.2.7**; the 2.2.7 files are unchanged (hashes compared before and after). A version bump commit is for the owner to ask for.
- `release/latest.yml` now describes 2.2.8 (the 2.2.7 one is kept outside the repo).
- The `.env` bundled in it has `VITE_PRINTER_INTERFACE=tcp://192.168.1.50:9100`.

## 7. Possible impact

- **Admin:** a frozen shift shows Correct figures; its form shows why it is frozen and a tick. Move a sale shows the refusal as before and, when an override would lift it, a tick.
- **Reports:** a forced move or correction reads `OVERRIDE (closed, not latest): …` on both shifts' Z reports. The forced correction does not change the shift's own row: the Z report's headline block (expected, counted, difference) keeps the figures stored at close, and the corrected figures print in the "Corrected on" block under it. For #1 the headline stays Expected 0.00 / Counted 3,790.00 and the correction block shows Expected 4,271.14 / Counted 5,210.00 / +938.86.
- **Data:** none stored beyond the existing ledger rows. Ledgers stay append-only.
- **Safety:** the freeze is still the default and only a PIN-verified active admin with a written reason lifts it; every use is recorded with who, when and why.

## 8. Rollback

Revert the commit. Nothing stored changed shape; any move or correction already made with the override stays in the ledgers with its marked reason.

## 9. Observed but not changed

- A shift's own row cannot change, so #1's headline block still shows its original close figures (Expected 0.00, Counted 3,790.00, Discrepancy 3,790.00) above the corrected ones. A Z report that headlines the latest correction would be a printing change.
- `previewSaleMove` is reachable by any renderer call with `override: true` for a read; it only reads. The write checks the admin and the PIN.
- The tick label says "not the latest" for a sale leaving the latest closed shift too (see §1); the wording is the owner's.
- Two stale `tsconfig.*.tsbuildinfo` files were already modified before this phase; they were left out of the commit.

## 10. Not verified

Anything on a till; the layout of the two ticks and of the Correct figures button on a Locked shift.
