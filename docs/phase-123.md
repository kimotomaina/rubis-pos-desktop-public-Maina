# Phase 123 — Item 1 applied, Item 2 audited: VAT config and the void guard

**Date:** 2026-09-23 · **Branch:** `staging` @ `8871592` · **Status:** Item 1 config applied (not yet rebuilt). Item 2 audit only.

## ⚠ Blocker: `package.json` was modified and not by this work

The working-copy `package.json` has lost its entire `scripts` block and its
entire `devDependencies` block. It was last written at 2026-09-23 20:03, and
`git diff package.json` shows only deletions.

It is not an intended change. With it in place, `npm test`, `npm run typecheck`
and `npm run dist` do not exist. No build and no verification can run until it
is restored. The committed version at `8871592` is intact.

It happened while four read-only investigation agents were running for the
POC assessment. None was asked to write, and this session made no edit to the
file. But one of them causing it cannot be ruled out. **Awaiting a decision
before it is touched.**

## Item 1 — `VITE_TAX_RATE=0.16` (applied, config only)

| File | Change |
| --- | --- |
| `.env` (untracked, bundled into the exe as `resources/.env`) | Added `VITE_TAX_RATE=0.16`, with a three-line comment |
| `.env.example` (tracked) | The default went from `0` to `0.16`, and the comment now says what the rate feeds and what "unset" means |

**Effect.** Class-A lines send `VATGrRate="16.00"`
([real-etims-provider.ts:1503](../src/main/services/integrations/real-etims-provider.ts#L1503)).
No code changed.

**Known side effect, accepted for the POC.** The printed receipt, the
Z-report and the daily summary add tax on top, so a 1-KSh sale prints
`Total: 1.16` ([printer.ts:214-215](../src/main/services/printer.ts#L214-L215)).
Item 3 fixes this.

**Rollback.** Delete the line, or edit `resources/.env` on the till, and
restart.

**Not done yet.** The exe rebuild is blocked by `package.json`, and it should
come after Item 2 anyway, so there is only one rebuild.

## Item 2 — void guard (audit)

### How void works today

1. **The screen asks for a PIN.** `OrderHistory.handleVoid` opens the manager
   PIN prompt, then calls `window.api.voidOrder(localId)` with the id **only**
   ([OrderHistory.tsx:79-97](../src/renderer/src/components/OrderHistory.tsx#L79-L97)).
   The PIN is checked on screen but never reaches the main process.
2. **The main process does not check it.** `orders:void` validates a bare
   positive integer (`voidOrderSchema`,
   [ipcValidator.ts:86](../src/main/lib/ipcValidator.ts#L86)) and calls
   `voidLocalOrder` without any role check
   ([index.ts:2081-2103](../src/main/index.ts#L2081-L2103)). Its own doc
   comment says it relies on the renderer for that.
3. **Only unsynced orders can be voided.** `voidLocalOrder` refuses anything
   that isn't `pending_sync` ([voids.ts:37-66](../src/main/services/voids.ts#L37-L66)).
   **It never looks at `fiscal_status`.**
4. **Voiding clears the queues.** `db.voidOrder` sets `status='voided'` and
   deletes the order's `order` and `etims_invoice` queue rows in one
   transaction ([database.ts:1639-1665](../src/main/services/database.ts#L1639-L1665)).

### Every route by which a voided order can still be filed

| # | Route | How it gets through |
| --- | --- | --- |
| R1 | **Resend** button (`fiscal:resend`) | `resendFiscalization` checks for the order, the `fiscalized` state and a stored request. **Never `status`** ([fiscal-retry.ts:128-165](../src/main/services/fiscal-retry.ts#L128-L165)). |
| R2 | **Correct PIN & resend** (`fiscal:correct-pin-and-resend`) | `correctPinAndResend` rewrites the stored request, then calls R1 ([fiscal-retry.ts:208-225](../src/main/services/fiscal-retry.ts#L208-L225)). |
| R3 | **The retry engine** | Void deletes the queue row, so the engine can't see it directly. But if R1 or R2 fails *retryably*, it **re-queues** the order ([fiscal-retry.ts:173-179](../src/main/services/fiscal-retry.ts#L173-L179)), and the engine then files it on a later pass ([fiscal-engine.ts:126](../src/main/services/fiscal-engine.ts#L126)). |
| R4 | **A sale still being fiscalized when it is voided** | `runCheckout` waits for the first submission inline. A sale can show in Order History while it waits, since the device may take several seconds. A void in that window loses the race: `setOrderFiscalInfo` lands on a voided order. |

**All three resend routes pass through `attemptFiscalRetry`**
([fiscal-retry.ts:57-75](../src/main/services/fiscal-retry.ts#L57-L75)). That
function is the one place to put the guard.

### Two more consequences of void that are not about filing

- **A voided sale still counts as unfiled.** A sale voided while `waiting` or
  `needs_fixing` stays in `getUnfiledOrderCount` and in Needs Attention
  permanently ([database.ts:1548-1576](../src/main/services/database.ts#L1548-L1576)).
  Neither query filters on `status`, so the unfiled badge would never return
  to 0, and it would show the voided sale's Resend button (R1).
- **A filed sale can still be voided.** A sale that is `fiscalized` and still
  `pending_sync` can be voided. The KRA invoice stays, and the till then says
  the sale never happened. There is no credit note to reconcile the two.

### Proposed build

1. **The guard, at the choke point.** Add `status` to `FiscalRetryOrder` as an
   **optional** field, so the existing fiscal-engine and retry test fakes still
   typecheck unmodified. If `attemptFiscalRetry` sees `status === 'voided'`, it
   returns `{ ok: false, kind: 'system', retryable: false }` with a plain
   reason, and makes no device call.
2. **An early refusal.** `resendFiscalization` refuses a voided order *before*
   any write. That stops R1 and R2 from re-queuing it or stamping it
   `needs_fixing`. `correctPinAndResend` refuses before rewriting the request.
3. **A PIN checked on the main side for void.** Add `voidOrderRequestSchema =
   { localId: voidOrderSchema, managerId, managerPin }`. It reuses the existing
   schema, so `ipcValidator.test.ts` stays unmodified.
   - `orders:void` calls `requireAdminPin` before `voidLocalOrder`, the same
     pattern as `mpesa:reconcile`.
   - The preload `voidOrder(localId, managerId, managerPin)`.
   - `OrderHistory` passes along the ids it already receives from
     `requestManagerPin` ([App.tsx:167-170](../src/renderer/src/App.tsx#L167-L170)).
4. **Tests.** A new `tests/voidGuard.test.ts` against a real in-memory
   database:
   - R1, R2 and R3 each make no device call on a voided order;
   - nothing is re-queued and the status is not rewritten;
   - a non-voided order behaves exactly as before;
   - void is refused with no or a wrong PIN, and with a cashier's PIN.

**Out of scope:** the fiscal engine, the routing, the real provider and
`mpesaPaymentGate.test.ts`.

**R4 is left open.** It is a narrow race in the inline first submit. Closing
it means touching `runCheckout`'s fiscal block. It is recorded here, not fixed.

### Decisions needed before BUILD

1. **`package.json`.** Restore it from git (`git checkout -- package.json`)?
   Recommended, unless you made that change on purpose.
2. **Refuse to void a sale that is already filed?** `voidLocalOrder` would
   refuse when `fiscal_status === 'fiscalized'` with *"This sale is already
   filed with KRA. It needs a credit note, which the till can't issue yet."*
   **Recommended.** Otherwise void creates a disagreement between KRA and the
   till that nothing can resolve. It is a one-condition change in `voids.ts`,
   outside the fiscal engine.
3. **Exclude voided sales from the unfiled count and from Needs Attention?**
   Add `AND status != 'voided'` to both queries. **Recommended.** Otherwise
   one void makes the unfiled badge wrong permanently, and it keeps showing
   the Resend button that (1) is disabling.
