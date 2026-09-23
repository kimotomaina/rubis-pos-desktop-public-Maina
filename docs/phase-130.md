# Phase 130 — Item 2 audit: remove void, plus a defensive refusal to file

- **Date:** 2026-09-23
- **Requested:** Remove void, not guard it. Keep one defensive refusal so a voided order can never be filed. Exclude voided orders from the unfiled count and Needs Attention. Audit first, then STOP.
- **Outcome:** Audit only; nothing changed
- **Branch / base commit:** staging @ 693dd05 (clean)
- **Previous:** [phase-123](./phase-123.md) (the void-guard audit this replaces) · [phase-129](./phase-129.md)

## 1. Audit

### What was examined

The void UI:
- [OrderHistory.tsx](../src/renderer/src/components/OrderHistory.tsx):
  - `voidError`/`voidingId` state (:54-55)
  - `handleVoid` (:79-97)
  - the error banner (:185-189)
  - the Void button (:232-244)
  - the `requestManagerPin` prop (:36-40, :50)
- [App.tsx:537-540](../src/renderer/src/App.tsx#L537-L540), which passes `requestManagerPin` to `OrderHistory`.

The bridge and IPC:
- [preload/index.ts:654-665](../src/preload/index.ts#L654-L665)
- [window.d.ts:234](../src/preload/window.d.ts#L234)
- the `orders:void` handler ([index.ts:2081-2103](../src/main/index.ts#L2081-L2103)) and its imports (`voidLocalOrder` at :122, `voidOrderSchema` at :126)

The services and data:
- [voids.ts](../src/main/services/voids.ts)
- `db.voidOrder` ([database.ts:1616-1668](../src/main/services/database.ts#L1616-L1668))
- `voidOrderSchema` ([ipcValidator.ts:85-86](../src/main/lib/ipcValidator.ts#L85-L86))
- `attemptFiscalRetry` and `FiscalRetryOrder` ([fiscal-retry.ts:30-75](../src/main/services/fiscal-retry.ts#L30-L75))
- `getOrdersNeedingAttention` and `getUnfiledOrderCount` ([database.ts:1548-1576](../src/main/services/database.ts#L1548-L1576))

The tests:
- `tests/voids.test.ts`
- `tests/reconciliation.test.ts` (four `db.voidOrder` calls: :65, :91, :150, :175)
- `tests/ipcValidator.test.ts:136-150`

I also searched all tests for anything that pins the SQL of the two count queries. There is none.

### How it currently works
- **The screen.** Order History shows **Void** on every `pending_sync` order. It asks for a manager PIN on screen, then calls `window.api.voidOrder(localId)`.
- **The main process.** It validates the id and calls `voidLocalOrder` without any role check.
- **The data.** `db.voidOrder` sets `status='voided'` and deletes the order's Shopify and fiscal queue rows. It never touches `fiscal_status`.
- **What happens afterwards.** A voided sale:
  - can still be filed through Resend or Correct-PIN, and through the engine if a resend re-queues it (routes R1–R3 in [phase-123](./phase-123.md));
  - stays in the unfiled count and in Needs Attention permanently.

### Dependencies found
- **Inbound:**
  - `window.api.voidOrder` is called only by `OrderHistory.handleVoid`.
  - The `orders:void` channel is called only by the preload bridge.
  - No test renders the Void button or calls the channel.
- **Outbound:**
  - `voidLocalOrder` calls `db.getOrder` and `db.voidOrder`.
  - `attemptFiscalRetry` calls `db.getOrder`, which returns an `OrderRow` that already carries `status`.
- **String-based / indirect:**
  - The `'orders:void'` channel name.
  - `status = 'voided'`, which appears in the `orders` CHECK constraint (database.ts:367), in `excludeVoided` (reports.ts:54), in the shift cash reconciliation (database.ts:1795), and in the OrderHistory "Voided" badge (:140-143).

### Risks and constraints identified
- **`noUnusedLocals` / `noUnusedParameters` are on** (`@electron-toolkit/tsconfig`). Removing the button leaves some code unused, and it must be removed with it:
  - `handleVoid`, `voidError` and `voidingId`;
  - the `requestManagerPin` prop, which only void used;
  - the `voidLocalOrder` and `voidOrderSchema` imports in `index.ts`.
- **Tests that must stay unmodified:**
  - `voidOrderSchema` stays exported, because `ipcValidator.test.ts` tests it.
  - `voids.ts` and `db.voidOrder` stay, because `voids.test.ts` and `reconciliation.test.ts` exercise them.
  - `FiscalRetryOrder.status` must be **optional**. The fiscal-engine and retry test fakes build that type without a `status` field.
- **A side effect of the guard.** It makes a Resend of a historical voided order come back `system`, not retryable. `resendFiscalization` then writes `needs_fixing` onto that voided row ([fiscal-retry.ts:171-172](../src/main/services/fiscal-retry.ts#L171-L172)).
  - This is harmless: nothing reaches the device, nothing is queued, and the two count queries filter voided rows out.
  - Stopping the write would take a second guard inside `resendFiscalization`. The brief asks for one defensive line, so I have **not proposed it**.
- **The historical "Voided" badge and `excludeVoided` in reports stay.** Rows that were voided before this change must still read and total correctly.

## 2. Plan

| File | Change |
| --- | --- |
| `OrderHistory.tsx` | Remove the Void button, `handleVoid`, `voidError` and `voidingId`, the error banner, and the `requestManagerPin` prop. Keep the "Voided" badge for historical rows. |
| `App.tsx` | Stop passing `requestManagerPin` to `OrderHistory`. |
| `preload/index.ts`, `window.d.ts` | Remove the `voidOrder` bridge method and its type. |
| `index.ts` | The `orders:void` handler ignores its input and returns `{ success: false, error: 'Sales cannot be voided on this till. A filed sale needs a credit note.' }`. It stays registered, because a stale renderer calling a missing channel is worse than getting a refusal. Drop the `voidLocalOrder` and `voidOrderSchema` imports. |
| `fiscal-retry.ts` | `FiscalRetryOrder` gets `status?: string`. `attemptFiscalRetry` returns `{ ok: false, kind: 'system', retryable: false, reason }` for `status === 'voided'` **before** the fiscalized short-circuit, and makes no device call. |
| `database.ts` | Add `AND status != 'voided'` to `getUnfiledOrderCount`. In `getOrdersNeedingAttention`, wrap the `OR` in parentheses and add `AND o.status != 'voided'`. |
| `tests/voidRemoval.test.ts` (new) | Uses a real in-memory database. See section 5. |

**Deliberately not changed:**
- `voids.ts` and `db.voidOrder`, which become unreachable.
- `voidOrderSchema`.
- `reports.ts` and its `excludeVoided`.
- `runCheckout`.
- The fiscal engine, routing and provider.
- `mpesaPaymentGate.test.ts`.

With the Void action gone, R4 (voiding during the first filing) can no longer happen.

## 3. Affected files and functionality

| File | Change | Functionality affected |
| --- | --- | --- |
| OrderHistory.tsx | Modified | The Void action goes; history, print and retry are unchanged |
| App.tsx | Modified | One prop is no longer passed |
| preload/index.ts, window.d.ts | Modified | The renderer API loses `voidOrder` |
| index.ts | Modified | `orders:void` always refuses |
| fiscal-retry.ts | Modified | All resubmission routes refuse voided orders |
| database.ts | Modified | The unfiled count and Needs Attention exclude voided orders |
| tests/voidRemoval.test.ts | Added | Coverage |

## 4. Possible impact
- **Direct:** cashiers and managers can no longer void a sale. A mistaken sale that hasn't synced is now handled outside the till: in Shopify, and with a credit note on the device or portal for the KRA side.
- **Indirect:** none of the inbound callers break, because the bridge method and its only caller are removed together.
- **Data / schema / contract:** no schema change. The IPC contract keeps the `orders:void` channel, which now only refuses.
- **Security posture:** improved. An unauthenticated main-process void path is closed, and a filing route for sales that don't exist is closed.
- **Idempotency / re-run safety:** a read-side filter and a pure guard; safe to re-run.
- **Residual risk:** a historical voided row can be marked `needs_fixing` by a Resend attempt (section 1). It is invisible in the counts and never filed.

## 5. Verification plan

**New tests**, against a real in-memory database:
1. `orders:void`'s refusal message is exported as a constant and asserted.
2. A voided order passed to `attemptFiscalRetry` returns `system`, not retryable, with **zero** `submitInvoice` calls.
3. `resendFiscalization` and `correctPinAndResend` on a voided order make zero `submitInvoice` calls and add no queue row.
4. A non-voided `waiting` order still resubmits exactly as before.
5. A voided order that is `waiting` or `needs_fixing` is left out of `getUnfiledOrderCount` and `getOrdersNeedingAttention`. Non-voided orders are still counted.
6. `window.api` has no `voidOrder`. This is a type-level fact, and typecheck proves it.

**Existing checks:**
- `npm run typecheck` and `npm test`.
- `voids.test.ts`, `reconciliation.test.ts`, `ipcValidator.test.ts`, the fiscal engine and routing tests, and `mpesaPaymentGate.test.ts` must all pass **unmodified**, confirmed with `git diff --stat tests/`.

**Then, after review,** one `npm run dist`, confirming the `verify-no-mock-provider` and `verify-dist` guards pass.

## 6. Rollback
The build is one commit, so `git revert <sha>` undoes it. No data migration is involved.

## 7. Observed but not changed
- `voids.ts` and `db.voidOrder` stay as unreachable code, so the existing void tests don't churn.
- **A Retry Sync duplicate-order hazard remains.** Order History still offers Retry Sync on `pending_sync` orders, and that can create a duplicate Shopify order ([POC_AS_BUILT_ASSESSMENT](./POC_AS_BUILT_ASSESSMENT.md) row K).
- A Resend of a historical voided row writes `needs_fixing` to it (section 1). This is harmless.
