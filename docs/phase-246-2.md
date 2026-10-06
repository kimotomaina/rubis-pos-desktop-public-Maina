# Phase 246-2 — Open Shift: the M-Pesa balance starts blank

- **Date:** 2026-10-06
- **Asked by the owner:** the item still open from the 246 ruling. Open Shift shows the M-Pesa balance at the start **blank**, not pre-filled with 0. Starting cash stays pre-filled with 0.
- **Status:** built and tested in one commit. No version bump or installer.
- **Layout:** not checked by `check:fit` (owner's rule). For the owner to check on the till.

## Audit

- Phase 246 (a), R4, set both Open Shift fields from one constant, `OPEN_SHIFT_FIGURE_DEFAULT = '0'`, in [openShiftFloat.ts](../src/renderer/src/lib/openShiftFloat.ts). Two forms use it:
  - the cart's [OpenShiftDialog.tsx](../src/renderer/src/components/OpenShiftDialog.tsx), at the initial state;
  - the Admin screen's Open Shift form in [AdminScreen.tsx](../src/renderer/src/components/AdminScreen.tsx), at the initial state and the two resets (after an open and after a cancel).
- A blank M-Pesa field already meant "not recorded" everywhere downstream ([previewOpenFloat](../src/renderer/src/lib/openShiftFloat.ts), the third argument `undefined`). Phase 246 recorded the two consequences of the 0: an opening balance nobody counted, and Confirm held whenever earlier M-Pesa sales were in the window. Both go away with a blank field.

## What changed

| Where | What |
| --- | --- |
| [openShiftFloat.ts](../src/renderer/src/lib/openShiftFloat.ts) | New `OPEN_SHIFT_MPESA_DEFAULT = ''`. `OPEN_SHIFT_FIGURE_DEFAULT = '0'` now governs the drawer count only. |
| [OpenShiftDialog.tsx](../src/renderer/src/components/OpenShiftDialog.tsx) | The M-Pesa field starts from `OPEN_SHIFT_MPESA_DEFAULT`. |
| [AdminScreen.tsx](../src/renderer/src/components/AdminScreen.tsx) | The M-Pesa field starts from `OPEN_SHIFT_MPESA_DEFAULT` and returns to it after an open and after a cancel. |

Nothing else changed: the main process, the S6 rule (earlier sales join, float = drawer less their cash), the close form and the reports are all untouched.

## Tests (existing tests changed, each with an old/new note in the file)

| Test | Old (phase 246) | New |
| --- | --- | --- |
| `adminShiftMpesaBalance` "shows the field as optional, empty…" | the field read `0` | it reads `''`, placeholder "Not recorded" |
| `adminShiftWindows` "sends no shift type…" | `[1, 250, 0]` | `[1, 250, undefined]` |
| `shiftCaptureUi`, the admin and the cashier-with-PIN opens | M-Pesa `0` | M-Pesa `undefined` |
| `shiftCaptureUi` "starts the drawer and the M-Pesa balance at 0" | `['0', '0']` | renamed; `['0', '']` |
| `shiftCaptureUi` "holds Confirm while a pre-filled M-Pesa 0…" | a pre-filled 0 held Confirm until counted or cleared | renamed; blank does not hold Confirm, and a typed 0 below the earlier M-Pesa sales does, until 500 is typed |

Two older comments in `shiftCaptureUi` that cleared the M-Pesa 0 are annotated: the clearing is kept and changes nothing.

### Mutation check (restored; the file compared byte for byte afterwards)

| Mutation | Failing tests |
| --- | --- |
| `OPEN_SHIFT_MPESA_DEFAULT` back to `'0'` | 6, all the tests in the table above |

## For the owner to check on the till

Open Shift, from the cart and from Admin: starting cash shows 0 and M-Pesa is blank, marked "Not recorded". With M-Pesa sales already in the window, Confirm is not held by the blank field.

## Rollback

Revert the commit.

## Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| Full suite | 231 files passed, 1 skipped (the rehearsal); 3,794 tests passed, 9 skipped |
| `npm run build` | passed, `verify-no-mock-provider` confirmed |
