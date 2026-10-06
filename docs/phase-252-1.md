# Phase 252-1 — Lock the cart while a split has a payment

- **Date:** 2026-10-06
- **Asked by the owner:** the 22:35 go. Phase 252 noted that the cart could change after a payment was recorded. The main process refused the mismatch, but the cashier was left with a split that no longer added up. Keep it simple: lock the cart.
- **Status:** built and tested in one commit. Screen only; nothing in the main process changed. No version bump, no installer.
- **Rulings recorded with it (22:35):**
  - **Phase 252:** accepted.
  - **D3** (a Checks line for M-Pesa payments no sale used): parked with the Daraja list. A typed code is written only when the sale completes, so only an STK payment can be left unused, and STK is not live. Added to the Daraja entry in `KNOWN_GAPS.md`.
  - **The split panel's size:** the owner checks it on the till.
  - **The split setting:** stays off on the live till until VIL answers D8.

## What changed

1. **The lock.** While the split panel holds one or more recorded payments, the cart cannot be changed. It is refused at three levels:
   - **The store.** Adding, a quantity change, removing, a price override and the line and cart discounts do nothing while `splitLocked` is set ([cartStore.ts:182](../src/renderer/src/stores/cartStore.ts#L182); refusals at [250](../src/renderer/src/stores/cartStore.ts#L250), [267](../src/renderer/src/stores/cartStore.ts#L267), [272](../src/renderer/src/stores/cartStore.ts#L272), [285](../src/renderer/src/stores/cartStore.ts#L285), [296](../src/renderer/src/stores/cartStore.ts#L296), [305](../src/renderer/src/stores/cartStore.ts#L305)). A scan or product tap therefore adds nothing.
   - **The guarded remove, reduce and clear** stop before a manager PIN is asked, so no removal is recorded for a change that cannot happen. They tell the cashier why (`lockedReason`, [guardedCartActions.ts:39](../src/renderer/src/lib/guardedCartActions.ts#L39), [84](../src/renderer/src/lib/guardedCartActions.ts#L84); passed by [App.tsx:336](../src/renderer/src/App.tsx#L336)).
   - **The cart table.** Its −, +, remove and Clear cart buttons are off ([PosCartTable.tsx:59](../src/renderer/src/components/PosCartTable.tsx#L59), [124-160](../src/renderer/src/components/PosCartTable.tsx#L124-L160)). One line shows under the cart: "Remove the recorded payments to change the cart." ([177](../src/renderer/src/components/PosCartTable.tsx#L177); text in [splitPayments.ts:17](../src/renderer/src/lib/splitPayments.ts#L17)).
2. **Who sets it.** The split panel sets the lock whenever it holds a payment and clears it when it holds none ([SplitPaymentPanel.tsx:52](../src/renderer/src/components/SplitPaymentPanel.tsx#L52)).
3. **What unlocks it:** removing every recorded payment, or cancelling the split, which closes the panel.
4. **A completed sale** clears the cart, and that also unlocks it ([cartStore.ts:318](../src/renderer/src/stores/cartStore.ts#L318)). `clearCart` itself is not locked, because that is how a completed sale empties the cart. The cashier's Clear cart goes through the guarded clear, which is locked.
5. **A sale paid one way is not affected.** The lock is set only by the split panel.
6. **Nothing in the main process changed.** Its refusal of payments that do not add up stays as the backstop.

**Two things beyond the four the ruling names.**
- **Price and discount.** "The cart cannot be changed" covers the price override and the discounts too, since they change the total the same way. On a live till those controls are hidden anyway (phase 161).
- **The Hold line.** While locked, the line under the cart shows the lock rather than Hold's own reason. Hold is refused either way (phase 252, S5).

## Tests

[splitCartLock.test.ts](../tests/splitCartLock.test.ts): 9 tests, real mount. The cart table and the checkout panel are mounted side by side, wired to the cart store through the same guarded actions `App.tsx` builds. One card payment is recorded through the card screen.

- **With one payment recorded:**
  - an add is refused;
  - a quantity change (up and down) is refused, with no PIN asked, and the buttons are off;
  - a remove is refused, with no PIN asked;
  - a clear is refused, with no PIN asked;
  - the line shows only then.
- **Unlocked:**
  - after the payment is removed: the add and the increase go through, and remove and clear ask for a manager as they always have;
  - after the split is cancelled;
  - an open split with no payment recorded does not lock.
- **A sale paid one way:** on the cash screen and on the M-Pesa screen the cart changes as before.

### Mutation check (restored; the file compared byte for byte afterwards)

| Mutation | Failing tests |
| --- | --- |
| An add let through with a payment recorded (the lock check removed from `addItem`) | 1: "an add is refused" |

## Existing tests changed

None.

## Rollback

Revert the commit. Nothing is stored; the lock lives only on the screen.

## Not verified

- **The layout, not measured:** no `check:fit`, by the standing rule. The lock line takes the place of Hold's line under the cart, so it adds no row.
- **Never run on the live till.**

## Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| Full suite | 237 files passed, 2 skipped (the copy rehearsals); 3,887 tests passed, 10 skipped. The tenth is the bundle-wording check, which skips itself while the build is older than the sources; it passed after the build |
| Mutation check | caught, file restored byte for byte |
| `npm run build` | passed, `verify-no-mock-provider` confirmed |
| Installer | not built |
