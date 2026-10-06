# Phase 249-1 — The checkout key survives a crash restore

- **Date:** 2026-10-06
- **Asked by the owner:** the 20:40 go. A cart restored from its saved draft after a crash got a new checkout key, so a sale already written could be made again. Save the key in the draft and put it back on restore; a draft with no key restores with none; held sales unchanged.
- **Status:** built and tested in one commit. No version bump, no installer.

## Audit, and a correction to phase 249's note

Phase 249's "observed but not changed" said: "If the crash came after the order was written, the cart comes back and a second sale is possible." **That was too broad.**
- **Phase 197 already deletes the saved draft inside the sale's own write transaction:** `settleCartForOrder`, `DELETE FROM cart_drafts`, [database.ts](../src/main/services/database.ts) (called from `queueOrder`).
- **The screen does not save the draft while a checkout is in flight:** `saver.cancel()` while `checkoutStatus === 'submitting'`, [App.tsx](../src/renderer/src/App.tsx).

So after a sale that completes normally there is no draft to restore.

**The gap is real on one path only.** The order is written, but the screen is told the checkout failed: an exception after the write, the case `runCheckout.test.ts` pins in "a throw after queueOrder succeeds … still reports failure". The status then changes from `submitting` to `error`, and the saver writes the cart's draft again. Before this phase that draft held no key, so a crash after it restored the cart as a new checkout. This phase closes that path.

**Held sales:** unchanged. Hold is refused while a payment is in progress (phase 217), and resuming a held cart clears the key, as in 249.

## What changed

| Where | What |
| --- | --- |
| [cartDraft.ts](../src/renderer/src/lib/cartDraft.ts) | **Saving:** the draft holds the cart's `checkoutKey` once there is one; a cart with no key is saved exactly as before (no key field). **Restoring:** `restoreCartDraft` returns `checkoutKey`, the saved key or `null`. |
| [cartStore.ts](../src/renderer/src/stores/cartStore.ts) | `restoreCart(items, cartToken, checkoutKey?)` puts the key back (default `null`). |
| [App.tsx](../src/renderer/src/App.tsx) | **Saving:** the draft saver is given the key and saves again when the key changes. **Restoring:** the restore passes the saved key to the cart. |
| [ipcValidator.ts](../src/main/lib/ipcValidator.ts), [preload](../src/preload/index.ts), [window.d.ts](../src/preload/window.d.ts) | `cart:save-draft` takes an optional `checkoutKey` shaped like the screen makes it; a malformed key is refused. |

**Not changed:**
- the main process's draft table and its delete in the sale's transaction;
- held sales;
- checkout itself.

**A restored cart is repriced from today's catalogue** (phase 197). If today's price differs, the resubmit's total differs from the written sale. Phase 249's rule then refuses it, naming the sale, rather than answering with it: the sale exists, and the cashier is told so.

## Tests

[checkoutKeyDraft.test.ts](../tests/checkoutKeyDraft.test.ts), 5 tests. The round trip uses the real pieces: the draft saver, `cart:save-draft`'s schema, the `cart_drafts` table on a real `:memory:` SQLite, the draft restore, the cart store, `orders:checkout`'s schema and `runCheckout`.

- **A cart restored after its sale was written:**
  - the sale is written;
  - the draft is saved again with its key, as on the error path;
  - the till restarts and the draft is restored;
  - the cart is submitted again.

  The answer is the first order: one order, one fiscal call.
- **A draft saved with no key** restores with no key; its sale is made with a new key, normally.
- **A cart with no key is saved with no key field,** exactly as before; with a key, the key is saved.
- **`cart:save-draft`** takes a well-formed key or none, and refuses a malformed one.
- **The wiring in `App.tsx`:** the key is saved, a change of key saves again, and the restore passes the key.

### Mutation checks (each restored; the file compared byte for byte afterwards)

| # | Mutation | Failing tests |
| --- | --- | --- |
| A | The key dropped from the saved draft | 2: the restore round trip, the save shape |
| B | The key not put back on restore | 1: the restore round trip |

## Existing tests changed

| Test | Old | New |
| --- | --- | --- |
| `cartDraft.test.ts`, the `restoreToastMessage` fixture | a restored cart with no key field | `checkoutKey: null` added (old/new note in the file); no assertion changed |

## Rollback

Revert the commit. Drafts saved with a key keep a field that the reverted code ignores.

## Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| Full suite | 233 files passed, 1 skipped (the rehearsal); 3,817 tests passed, 9 skipped |
| `npm run build` | passed, `verify-no-mock-provider` confirmed |
