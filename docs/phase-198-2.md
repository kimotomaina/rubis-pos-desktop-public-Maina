# Phase 198-2 — fiscal slip start and end markers; staff names in title case

- **Date:** 2026-10-02
- **Requested:** centred "START" and "END" markers on a filed fiscal slip; staff names displayed in title case (display only); tests, mutation checks, goldens quoted.
- **Outcome:** Implemented. Typecheck clean; vitest **177 files, 2794 tests, all passing** (175 and 2738 before); `npm run build` passes with the no-mock check. `check:fit` not run; no device calls; no new dependency.
- **Branch / base commit:** staging on top of `b576464`.

## 1. Markers

- **Constants** (in `receiptFiscalBlock.ts`, beside the other fiscal wording): `- START OF FISCAL RECEIPT -` and `- END OF FISCAL RECEIPT -`.
- **Where, in `buildReceiptLayout`** ([receiptLayout.ts](../src/main/lib/receiptLayout.ts)), centred, normal weight, filed sales only:
  - **START:** directly after the header block and the rule that closes it, directly before the "FISCAL RECEIPT" label.
  - **END:** after the control unit block (including the QR and "Scan to verify this receipt with KRA", or without them when the sale has no QR), after that block's closing rule, directly before the footer ("Thank you...").
  - I read "after the header block" and "after the QR and Scan lines" as including the rule that closes each block, so each marker sits just below a rule. If you wanted START above that rule or END above the closing rule, it is one line to move.
- **Original and duplicate alike.** A duplicate's top "*** DUPLICATE ***" stamp stays above the header and its bottom stamp below the footer, so both are outside the markers.
- **Never on** the sale record (the branch is gated on a filed sale) or the Enjoy slip (a separate builder; tested for a filed, a pending and a duplicate sale).
- **The mock's TEST banner stays outside:** it wraps the whole layout after the markers are in, so it is above START and below END, with only the footer between END and the bottom banner (tested).
- The thermal and PDF renderers walk the same layout, so both get the markers.

## 2. Title case

- **`titleCaseName`** in the new [src/main/lib/text.ts](../src/main/lib/text.ts). There was no existing string-helper file to extend. It trims, collapses runs of spaces, lower-cases, then upper-cases the first letter of each word, where a word starts after the beginning of the text, a space, a hyphen or an apostrophe (straight or curly). Letters are matched as Unicode letters, so "émile zola" gives "Émile Zola". Digits and other characters are untouched. Empty or blank input gives an empty string.
- **Renderer twin** [src/renderer/src/lib/text.ts](../src/renderer/src/lib/text.ts). Every existing renderer import from `main/` is `import type` only (the same reason `vatLabel.ts` is a copy), so the screens cannot import the main one. `tests/titleCaseName.test.ts` runs both over the same names, so they cannot drift apart.
- **Applied to:**
  - the fiscal slip's "Cashier:" line (and, since it is the same line, the sale record's);
  - the Enjoy slip's "Served by:", first name only as before, title-cased ("MARY-ANNE WANJIKU" gives "Mary-Anne");
  - Admin screen staff list ([AdminScreen.tsx](../src/renderer/src/components/AdminScreen.tsx));
  - the other Admin-tab screens that show a staff name: Reports ([ReportsPage.tsx](../src/renderer/src/pages/ReportsPage.tsx), one helper feeding shift history and the invoice list), End of Day ([EndOfDayPage.tsx](../src/renderer/src/pages/EndOfDayPage.tsx), four places), Needs Attention ([NeedsAttentionPage.tsx](../src/renderer/src/pages/NeedsAttentionPage.tsx), three places; the "Unknown staff" placeholder is left as it was) and the Z-report window ([ZReportModal.tsx](../src/renderer/src/components/ZReportModal.tsx)).
- **Order History shows no staff name at all** (it shows the sale's lines, totals and status), so there was nothing to change there.
- **Not changed:** stored names, `staff.name` in the database, the order payload's `staffName`, login (it matches on the staff id and PIN, not the name). Not applied, since not on your list: the signed-in name in the top bar, the login screen's name picker, and the printed Z-report's "Cashier:" line. Say if you want those too.

## 3. Goldens: every change quoted

`tests/fixtures/receipt-class-a-golden.json` is the only golden that changed. The change is **insertions only**: 100 lines added, 0 removed or changed, i.e. two entries (`{ "text", "align": "centre", "style": "normal" }`, 5 lines each) in each of the **10 filed layouts**. The two `slip` layouts (the sale record) are untouched. I inserted them by rule, before the "FISCAL RECEIPT" entry and before the "Thank you for shopping at Enjoy!" entry, independently of the builder, and the golden test then compared them against what the builder prints; it passes, so the builder puts them in exactly those places. The inserted entries, as they read in each layout:

```
        "text": "- START OF FISCAL RECEIPT -",
        "align": "centre",
        "style": "normal"
        ...
        "text": "- END OF FISCAL RECEIPT -",
        "align": "centre",
        "style": "normal"
```

| Layout | The line above, START, the line below | The line above, END, the line below |
| --- | --- | --- |
| filedWithGroups@48 | rule (48) / **START** / `FISCAL RECEIPT` | rule (48) / **END** / `Thank you for shopping at Enjoy!` |
| filedWithGroups@32 | rule (32) / **START** / `FISCAL RECEIPT` | rule (32) / **END** / `Thank you for shopping at Enjoy!` |
| filedNoGroups@48 | rule (48) / **START** / `FISCAL RECEIPT` | rule (48) / **END** / `Thank you for shopping at Enjoy!` |
| filedNoGroups@32 | rule (32) / **START** / `FISCAL RECEIPT` | rule (32) / **END** / `Thank you for shopping at Enjoy!` |
| filedNoClassOnItems@48 | rule (48) / **START** / `FISCAL RECEIPT` | rule (48) / **END** / `Thank you for shopping at Enjoy!` |
| filedNoClassOnItems@32 | rule (32) / **START** / `FISCAL RECEIPT` | rule (32) / **END** / `Thank you for shopping at Enjoy!` |
| duplicate@48 | rule (48) / **START** / `FISCAL RECEIPT` | rule (48) / **END** / `Thank you for shopping at Enjoy!` |
| duplicate@32 | rule (32) / **START** / `FISCAL RECEIPT` | rule (32) / **END** / `Thank you for shopping at Enjoy!` |
| discounted@48 | rule (48) / **START** / `FISCAL RECEIPT` | rule (48) / **END** / `Thank you for shopping at Enjoy!` |
| discounted@32 | rule (32) / **START** / `FISCAL RECEIPT` | rule (32) / **END** / `Thank you for shopping at Enjoy!` |
| slip@48, slip@32 | no change (sale record) | no change |

**Cashier line in the goldens: no change.** The only name in the goldens' fixtures is "Mary W.", which is already title case, so the pre-approved Cashier change had nothing to apply to (`Cashier:                                 Mary W.` at 48 columns, `Cashier:                 Mary W.` at 32, both as before). The golden file is rewritten with the same formatting, which is why the diff is pure additions.

**Phase 171 layout tests (`tests/receiptLayout.test.ts`): no change needed.** They find lines by content rather than position, so they pass untouched.

## 4. Tests

- **New: 2 files, 56 tests** ([fiscalSlipMarkers.test.ts](../tests/fiscalSlipMarkers.test.ts), 32 `expect()` calls; [titleCaseName.test.ts](../tests/titleCaseName.test.ts), 14 call sites, several inside `it.each`).
  - **Markers:** each marker once, centred, on an original and a duplicate, at 48 and 32 columns; START right after the header rule and PIN line and before the label; END after the QR and "Scan to verify" and before the footer, with and without a QR; a duplicate's stamps outside; absent on the sale record and its reprint; absent on the Enjoy slip for filed, pending and duplicate sales; the mock banner above START and below END with only the footer between END and the bottom banner; both markers in the fiscal printer job and neither in the Enjoy job.
  - **`titleCaseName`:** the two examples you gave, a single name, upper-case input, extra spaces, trimmed input, digits left alone, a hyphenated name, an accented name, empty and blank input, stability when applied twice, the renderer twin agreeing on every case, and the slips: fiscal "Cashier:" in title case and the order itself untouched, the same on the sale record, "Served by:" first name only and title-cased, hyphenated first name.
- **Changed existing `expect()`: zero.** The only existing-test file touched is the golden JSON above.
- **Mutation checks, restored afterwards:**
  - **END marker removed: 20 failed.** The ten filed golden layouts (`filedWithGroups`, `filedNoGroups`, `filedNoClassOnItems`, `duplicate` and `discounted`, each at 48 and 32); in `fiscalSlipMarkers`, "carries each marker once, centred" (original and duplicate) and "puts END after the QR and Scan to verify lines" and "still puts END before the footer when the sale has no QR", each at 48 and 32; "has nothing between END and the bottom banner but the footer"; and "prints both markers in the fiscal job and neither in the Enjoy job".
  - **`titleCaseName` returning its input: 29 failed.** The twelve name cases that change under title case and the digits test, the renderer-twin agreement on the same twelve cases, and the four slip tests (the fiscal "Cashier:" line, the sale record, "Served by:" and the hyphenated first name). The cases that are already in title case, such as "Mary W.", and the empty string still pass, as they should.

## 5. Verification

- `npm run typecheck`: clean. `npx vitest run`: 177 files, 2794 tests passed. `npm run build`: exit 0, "neither mock provider is in out/main".
- **Not run:** `check:fit`; a real printer.

## 6. Flags

- The sale record's "Cashier:" line is title-cased too, because it shares the line with the fiscal slip. Its golden has the title-case fixture name, so it did not move.
- A name like "McDonald" displays as "Mcdonald", and "van der Merwe" as "Van Der Merwe", by the rule as written (lower-case everything, capitalise each word). Stored names are untouched, so this can be revisited without a data change.
- The earlier flag in `docs/phase-198-1.md` about the top bar and login picker showing names as typed still stands; see section 2.

## 7. Rollback

`git revert` the phase 198-2 commit. Nothing is stored or migrated: the markers and the name casing are print and display only.
