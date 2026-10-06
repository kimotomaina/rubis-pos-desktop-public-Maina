# Phase 246 — One Reports tab scoped by shift or range; card at close; the windows usable at any length; Open Shift at 0

- **Date:** 2026-10-06
- **Asked by the owner:** the rules R1 to R7 of the order of 2026-10-06 17:50 Nairobi, with the amendment that End of Day approval is per shift, not per day.
- **Built in three commits**, each with the full suite green: **(a)** the shared window shell, the four windows moved onto it, Open Shift at 0 (R1, R4); **(b)** card counted at close, on the Z report and in corrections (R5); **(c)** the one Reports tab, scoped by shift or range, with End of Day approval per shift (R2, R3 and the amendment).
- **Status:** built and tested. Not released: no installer built. `package.json` stays at 2.2.9.
- **Layout: not checked by check:fit (owner's rule). For the owner to check on the till.**
- **First rule of the phase, kept:** every report keeps calling the function it calls today. No calculation moved or was rewritten.
- **Rulings applied** (the eight decisions of the audit, as the owner left them standing): both Open Shift figures pre-filled with 0; a shift scope is the span of the shift's own sales, with a count note; End of Day per shift (amendment); M-Pesa logs unscoped (latest 50); Export in the Detail section; a custom range typed as two date-times; the End of Day and M-Pesa Logs cards leave the Admin grid; card columns also on the adjustment ledger.

---

## Part (a): the shared shell, the four windows, Open Shift at 0

### Audit

- **Why a long Z report was out of view on the till:** `ZReportModal` was a `fixed inset-0` overlay with a centred box that had no maximum height and no scroll, and its Print and Correct figures buttons were the last thing in the body. A report with several adjustment and correction blocks grew past the 772 px screen, and since the overlay cannot scroll, the buttons were off screen. `WindowReportModal` and `ShiftCorrectionForm` had the same shape; Move a sale was a section that replaced the list.
- **Rules in the way:** phase 158 had chosen "no internal scroll" for the Z report, and `noUnexpectedScroll.test.ts` kept `ZReportModal` at zero scroll classes. R1 reverses that on purpose. The single scroll class now lives in one component, so the four windows stay at zero and the shell has one allow-listed entry.
- **Open Shift:** `OpenShiftDialog` (the cart's) and the Admin screen both started the cash and M-Pesa fields blank. One shared form, `OpenShiftForm`.

### What changed

| Where | What |
| --- | --- |
| [ModalShell.tsx](../src/renderer/src/components/ModalShell.tsx) (new) | `ShellPanel`: a header and a footer that never shrink, a body between them (`touch-scrollbar min-h-0 flex-1 overflow-y-auto`, the always-visible bar of phase 220). `ModalShell`: the backdrop and a box never taller than the screen (`max-h-full`) around a `ShellPanel`. The one place these windows scroll. |
| [ZReportModal.tsx](../src/renderer/src/components/ZReportModal.tsx) | On the shell: the report scrolls in the body; the print message and the Print Z-Report and Correct figures buttons are in the footer. No content change. |
| [WindowReportModal.tsx](../src/renderer/src/components/WindowReportModal.tsx) | On the shell, same dialog name; the table scrolls under a fixed header. |
| [ShiftCorrectionForm.tsx](../src/renderer/src/components/ShiftCorrectionForm.tsx) | On the shell: the fields scroll; Cancel, Record correction and the error message are in the footer, so an error is never scrolled out of sight. |
| [MoveSaleForm.tsx](../src/renderer/src/components/MoveSaleForm.tsx), [ReportsPage.tsx](../src/renderer/src/pages/ReportsPage.tsx) | On a `ShellPanel`: Cancel in the header; the form scrolls; Move sale and the error are in the footer. The page's wrapper for it is a column that fills the height it is given. |
| [openShiftFloat.ts](../src/renderer/src/lib/openShiftFloat.ts), [OpenShiftDialog.tsx](../src/renderer/src/components/OpenShiftDialog.tsx), [AdminScreen.tsx](../src/renderer/src/components/AdminScreen.tsx) | `OPEN_SHIFT_FIGURE_DEFAULT = '0'`: the drawer count and the M-Pesa balance both start at 0, editable, in the cart's dialog and on the Admin screen, and are put back to 0 after an open or a cancel. The S6 rule is unchanged: sales already made in the window join and the float is still the drawer less their cash. |

### Two consequences of "both at 0" the owner should know

1. **The M-Pesa field no longer means "not recorded" by default.** A shift opened by leaving the field alone now records an opening balance of 0, so its Z report shows the M-Pesa expected and the "Check against the M-Pesa statement" lines. To record "not recorded", clear the field.
2. **With earlier M-Pesa sales in the window, Confirm is held until the field is counted or cleared.** The existing S6 rule refuses an M-Pesa balance below the earlier M-Pesa sales (the float would be negative), and a pre-filled 0 is below them. The cashier must type the balance or clear the field. Cash behaves as before: a 0 drawer below earlier cash sales is refused until it is counted, or an admin ticks "start at 0".

### Tests

[modalShell.test.ts](../tests/modalShell.test.ts), 8 tests: the shell's body scrolls and the header and footer are outside it and do not shrink; the box is never taller than the screen; the scroll class appears in the shell and in none of the four windows; for each window, which parts are in the body and which in the footer (the Z report with twelve adjustment blocks keeps Print and Correct figures in the footer; the print message stays in the footer; the correction and Move a sale errors are in the footer).

In [shiftCaptureUi.test.ts](../tests/shiftCaptureUi.test.ts), two added tests: both figures start at 0, editable; and a pre-filled M-Pesa 0 holds Confirm below earlier M-Pesa sales until it is counted or cleared.

### Mutation check (restored; the file compared byte for byte afterwards)

| # | Mutation | Failing tests |
| --- | --- | --- |
| R1 | A modal body that does not scroll (`overflow-y-auto` removed from the shell's body) | 3: `the shell > scrolls its body, keeps the header and the footer outside it…`, `the shell > has the one scroll class of the four windows…`, `noUnexpectedScroll > ModalShell.tsx has exactly its allow-listed count` |

### Existing tests changed (each with an old/new note in the file)

| Test | Old | New |
| --- | --- | --- |
| `adminShiftMpesaBalance.test.ts` (2) | the M-Pesa field started empty; a blank one sent `undefined` | it starts at 0 (placeholder "Not recorded" when cleared); the blank test clears it first |
| `adminShiftWindows.test.ts` (1) | the call carried `undefined` for M-Pesa | it carries 0 |
| `shiftCaptureUi.test.ts` (5) | `undefined` for M-Pesa; a blank cash field gave "Enter a valid starting cash amount" | 0 for M-Pesa; the cash field is cleared first; the two earlier-sales tests clear the M-Pesa 0 |
| `noUnexpectedScroll.test.ts` | no entry for the shell | `ModalShell.tsx` allow-listed at exactly 1 |

Every other test, including all the Z report, correction, Move a sale and window report tests, passes unchanged.

### Verification (a)

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| Full suite | 226 files passed, 1 skipped (the rehearsal); 3,718 tests passed, 9 skipped (8 rehearsal, 1 build-freshness) |
