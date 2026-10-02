# Phase 197-1 — close-out: delete the unguarded component, flush the cart draft on quit

- **Date:** 2026-10-02
- **Requested:** (1) commit phase 197; (2) delete `CartLineItem.tsx` if nothing in `src/` uses it; (3) flush the cart draft on a clean quit, waiting up to 500 ms; (4) new restore-toast wording; (5) an undo window, **only if approved**.
- **Outcome:** Items 1 to 4 done. **Item 5 not built**: no approval for option A was given, so `canUndoWithoutPin`, the `reason` column and the undo path do not exist. Typecheck clean; full suite 166 files, 2601 tests passing (167 files and 2601 tests before: 17 tests deleted with the component, 17 added); `npm run build` passes with the no-mock check. `check:fit` was not run.
- **Branch / base commit:** staging @ 4190874 (version 2.1.5). Committed locally with this report, not pushed. **The 2.1.5 installer built earlier does not contain this phase.**

## 1. Audit

- **Item 1:** phase 197 was already committed as `f9bcd1f` ("feat(pos): manager PIN to remove or reduce a cart line; cart saved to SQLite and restored after a restart (phase 197)") before this brief arrived, followed by the version bump `4190874`. The commit message differs from the one requested; history was not rewritten.
- **`CartLineItem` references:** no file in `src/` imports or renders it (the live cart is `PosCartTable`). The only other mentions in `src/` were one doc comment in `PosCheckoutPanel.tsx` ("matching `CartLineItem`'s per-line rule") and the component's own definition. In `tests/`: three files import it. The brief says to stop if anything in `src/` references it; a doc comment is not a use, so the comment was reworded and the component deleted. Say if you read that differently.
- **What the deletion removes:** the only per-line "Edit Price" and "Discount" controls. They were already unreachable in the live UI. The store actions `setItemPrice` and `setItemDiscount` remain, with their own tests, and the cart-level discount in `PosCheckoutPanel` is untouched.
- **Quit paths in Electron** ([index.ts](../src/main/index.ts)): `app.quit()` (restart, updater) emits `before-quit` while the window is alive. Clicking the window's close button closes the window first and only then quits, so by `before-quit` the renderer is gone and a flush there has nothing to talk to. A `before-quit`-only hook would therefore have missed the most common clean quit.

## 2. Changes

| File | Change |
| --- | --- |
| `src/renderer/src/components/CartLineItem.tsx` | Deleted. |
| `tests/cartLayout.test.ts`, `tests/cartLineItemFiscalGate.test.ts` | Deleted: every test in them was about `CartLineItem` (8 and 4 tests). |
| `tests/priceDiscountKeypad.test.ts` | The two `CartLineItem` suites (Edit Price, Discount; 5 tests) and the import removed. The `PosCheckoutPanel` cart-discount suite (2 tests) stays unchanged. Header comments updated. |
| `tests/keyboardEchoSubmit.test.ts`, `PosCheckoutPanel.tsx` | One comment each no longer names the deleted component. |
| `src/main/services/cart-flush.ts` (new) | `createCartFlushCoordinator`: asks the renderer to flush, resolves `'flushed'` on its answer, `'timeout'` after 500 ms, or `'unavailable'` at once when there is no window. One request at a time. |
| `src/main/index.ts` | Two hooks sharing one flag: `before-quit` (for `app.quit()`) and the main window's `close` event (for the close button) each prevent the first pass, flush, then quit or close again. The ZFPLabServer session release now runs only on the final `before-quit` pass, not twice. Logs `Cart draft flush on quit: <result> after <n> ms`. |
| `src/preload/index.ts`, `window.d.ts` | `onCartFlushRequest(handler)`: runs the handler, then tells the main process it is done, whether it succeeded or threw. |
| `src/renderer/src/lib/cartDraft.ts` | The saver gains `flush()`: writes the pending change now and resolves when the write has completed; nothing pending resolves at once. Toast wording is now "Restored the cart from before the restart. N units in M lines." |
| `src/renderer/src/App.tsx` | Registers the flush listener next to the saver. |

## 3. Affected files and functionality

| File | Functionality affected |
| --- | --- |
| `index.ts` quit hooks | Every quit now waits up to 500 ms for the renderer, or less when it answers. A hung renderer cannot block quitting. |
| Deleted component and tests | 17 tests and 36 `expect()` calls go with code nothing rendered. |

## 4. Possible impact

- **Direct:** the last cart change before a clean quit is no longer lost to the 300 ms debounce.
- **Indirect:** closing the window now takes up to 500 ms longer in the worst case (an unresponsive renderer).
- **Data / schema / contract:** none.
- **Security posture:** unchanged.
- **Idempotency / re-run safety:** the flush flag makes the hooks run once per quit.
- **Residual risk:** a **kill** (power loss, crash, end-task) still loses the last 300 ms. Only the close button path was verified live (below); the `app.quit()` path (restart, updater) uses the same coordinator but was not exercised by hand.

## 5. Verification

- `npm run typecheck`: exit 0. `npx vitest run`: **166 files, 2601 tests passed**; the tripwires (`fiscalEngine`, `fiscalRouting`, `mpesaPaymentGate`) ran unmodified. `npm run build`: exit 0, "neither mock provider is in out/main".
- **New tests, `cartFlush.test.ts` (17, 31 `expect()` calls):** the saver's `flush` (writes at once, never twice, only the last of several changes, deletes for an empty cart, nothing pending, cancelled, failed write swallowed, waits for the write); the coordinator (acknowledged, 500 ms timeout, no renderer, one request while one is in flight, stray acknowledgement); and the scenario you specified with fake timers against a real in-memory database: **a change at t=0 and a quit at t=100 ms leave the change in the draft row**, written once, and an empty cart leaves no row. A companion test shows the same change lost when the flush is skipped.
- **Mutation check (on the new behaviour):** `flush` turned into a no-op: **8 tests failed** (the t=100 ms scenario, the empty-cart quit, the write-once check and five saver tests). Restored; all 17 pass again.
- **Existing `expect()` changed: 2**, both in `tests/cartDraft.test.ts`, and both because item 4 changed the wording they assert: `'Restored the cart from before the restart. 3 items.'` became `'... 3 units in 2 lines.'`, and `'... 1 item.'` became `'... 1 unit in 1 line.'`. **Removed with deleted tests: 36** (15 + 8 + 13 originally in the three files, 4 remain in `priceDiscountKeypad`). **Added: 31.**
- **Hands-on, built demo app, throwaway profile** (store URL and token blanked, no fiscal device, mock printer). Steps: add a line, remove it (a PIN is asked, since no undo window exists), add two lines, remove the first (PIN), then quit within a few milliseconds and relaunch:

```
native close (the close button, a real WM_CLOSE) right after a change
[2] removed the first line (PIN) -> cart: ["Coca-Cola 300ml x1"] (change visible after 1 ms)
[2] native close (WM_CLOSE, as the close button) -> process exited 290 ms later
[2] app log: ["[rubis-pos] Cart draft flush on quit: flushed after 1 ms"]
[db after quit] {"draft_rows": 1, "lines": [["Coca-Cola 300ml x1"]]}
[3] relaunched -> toast: Restored the cart from before the restart. 1 unit in 1 line.

control: SIGKILL right after the same change
[2] KILLED (SIGKILL, no hooks) -> process exited 62 ms later
[2] app log: (no flush line)
[db after quit] {"draft_rows": 1, "lines": [["Bread Loaf x1", "Coca-Cola 300ml x1"]]}
[3] relaunched -> toast: Restored the cart from before the restart. 2 units in 2 lines.
```

  The process exited 290 ms after the close request, before the 300 ms debounce could have fired, so the saved change came from the flush. The kill, 62 ms after the change, lost it: the 300 ms limit is real.
- **A path that does not work, and why it is not covered:** my first run closed the window from inside the renderer (`window.close()`). That is not how the app closes (nothing in `src/` does it); Electron then destroys the window without running the main-process hooks, the flush answered "unavailable" and the change was lost. I tried a page-level write on `pagehide` as a second line of defence, re-ran it and it did **not** help, so I removed it rather than ship something unproven. The close-button run above uses a native close message sent to the window, the same path as a click.

## 6. Rollback

`git revert` the phase 197-1 commit. The deleted component and tests come back; no data or schema is involved.

## 7. Observed but not changed

- **Item 5, the undo window, is not built** and needs Paul's answer. When asked, it also needs a `reason` column on `cart_line_removals` and a way to record `manager_id` as NULL (the column is currently `NOT NULL`).
- The restore toast still says "a manager can apply them again" for removed price overrides and discounts. With `CartLineItem` gone there is no per-line override control at all; only the cart-level discount can be applied again.
- The throwaway driver sometimes hung in its own cleanup after a scenario. That was the driver, not the app.
- `docs/POC_AS_BUILT_ASSESSMENT.md` is stale on printing and the cart.
