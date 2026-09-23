# Phase 131 — Item 2 build: void removed, voided orders can never be filed

- **Date:** 2026-09-23
- **Requested:** Build the plan approved in [phase-130](./phase-130.md): remove the Void action, keep `orders:void` as an unconditional refusal, add one defensive guard so a voided order can never be filed, and exclude voided orders from the unfiled count and Needs Attention. Then run one `npm run dist`.
- **Outcome:** Implemented
- **Branch / base commit:** staging @ ca21459. Build commit **`57e4010`**.
- **Previous:** [phase-130](./phase-130.md) (audit)

## 1. Audit

As recorded in [phase-130](./phase-130.md) §1. No new findings came up during
the build.

## 2. Changes made

| File | Change |
| --- | --- |
| [OrderHistory.tsx](../src/renderer/src/components/OrderHistory.tsx) | Removed the Void button, `handleVoid`, the `voidError`/`voidingId` state, the void error banner and the `requestManagerPin` prop. The **"Voided" badge is kept** for historical rows. |
| [App.tsx](../src/renderer/src/App.tsx) | No longer passes `requestManagerPin` to `OrderHistory`. The other three components still receive it. |
| [preload/index.ts](../src/preload/index.ts), [window.d.ts](../src/preload/window.d.ts) | Removed the `voidOrder` bridge method and its type. |
| [index.ts](../src/main/index.ts) | `orders:void` is still registered. It ignores its input and returns `{ success: false, error: VOID_DISABLED_MESSAGE }`. The now-unused `voidLocalOrder` and `voidOrderSchema` imports are dropped. |
| [voids.ts](../src/main/services/voids.ts) | **One added export:** `VOID_DISABLED_MESSAGE`. Nothing else changed. |
| [fiscal-retry.ts](../src/main/services/fiscal-retry.ts) | `FiscalRetryOrder` gained an optional `status?: string`. `attemptFiscalRetry` refuses `status === 'voided'` **before** the fiscalized short-circuit: `kind: 'system'`, `retryable: false`, reason `VOIDED_ORDER_NOT_FILED_REASON`, and no device call. The file doc now lists this as safeguard 0. |
| [database.ts](../src/main/services/database.ts) | `getUnfiledOrderCount` adds `AND status != 'voided'`. `getOrdersNeedingAttention` wraps its `OR` in parentheses and adds `AND o.status != 'voided'`. Both doc comments are updated. |
| [tests/voidRemoval.test.ts](../tests/voidRemoval.test.ts) | **New.** 7 tests against a real in-memory SQLite database. |

**Why the constant lives in `voids.ts`, not `index.ts`.** The brief asked for
`VOID_DISABLED_MESSAGE` to be exported so a test could assert it. `index.ts`
is the Electron main entry point, and importing it from a test would start the
app. `voids.ts` is the void service module, so the constant sits there and
`index.ts` imports it. That one export is the only change to `voids.ts`.

**Deliberately not changed:**
- `voids.ts` (apart from that export) and `db.voidOrder`
- `voidOrderSchema`
- `reports.ts` and `excludeVoided`
- `runCheckout`
- the fiscal engine, routing and provider

## 3. Affected files and functionality

| File | Change | Functionality affected |
| --- | --- | --- |
| OrderHistory.tsx | Modified | The Void action is gone. Print, Retry Sync, the status badges and the expand view are unchanged. |
| App.tsx | Modified | One prop is no longer passed |
| preload/index.ts, window.d.ts | Modified | The renderer API no longer has `voidOrder` |
| index.ts | Modified | `orders:void` always refuses |
| voids.ts | Modified (one export) | none |
| fiscal-retry.ts | Modified | Every resubmission route (Resend, Correct PIN & resend, the retry engine) refuses voided orders |
| database.ts | Modified | The unfiled count and Needs Attention exclude voided orders |
| tests/voidRemoval.test.ts | Added | Coverage |

## 4. Possible impact

- **Direct: cashiers and managers can no longer void a sale at the till.** A
  mistaken sale that hasn't synced is now handled **in Shopify**, plus **a
  credit note on the device or the KRA portal** for the KRA side. The till
  cannot issue credit notes.
- **Indirect:** none. The bridge method and its only caller were removed
  together, and no other code used either. A stale renderer that still calls
  `orders:void` gets the plain refusal.
- **Data / schema / contract:** no schema change. Rows voided before this
  change still show "Voided", and they are still left out of revenue and
  shift cash (`excludeVoided`, `database.ts:1795`).
- **Security posture:** improved.
  - The main-process void path, which had no role check, is closed.
  - No route remains that could file a sale that no longer exists.
  - Voiding during the first filing (R4 in phase-123) can no longer happen,
    because nothing can void.
- **Idempotency / re-run safety:** a read filter and a pure guard, safe to run
  any number of times.
- **Residual risk:** a Resend or Correct-PIN on a *historical* voided row
  still writes to that row. Resend marks it `needs_fixing`, and Correct-PIN
  rewrites the stored buyer PIN. Neither reaches the device or adds a queue
  row (both are tested), and both count queries hide the row. Stopping these
  writes would need a second guard, which the brief left out.

## 5. Verification

```
npm run typecheck   → clean (node + web)
npm test            → 90 files, 1391 tests, all passing (was 89 / 1384)
git diff --stat tests/ (before commit) → empty; the only test change is the new file
```

**What the new tests prove** (`tests/voidRemoval.test.ts`, 7 tests):
1. `VOID_DISABLED_MESSAGE` is exactly *"Sales cannot be voided on this till.
   A filed sale needs a credit note."*
2. `attemptFiscalRetry` on a voided `waiting` order returns `system`, not
   retryable, with the voided reason and **zero** `submitInvoice` calls.
3. **The guard runs before the fiscalized short-circuit.** A sale that was
   **fiscalized and then voided** is refused *as voided*, with zero device
   calls. Without the ordering it would have come back `ok: true` from the
   fiscalized branch. It is also excluded from both count queries.
4. `resendFiscalization` on a voided order makes no device call, adds no
   queue row and records no invoice.
5. `correctPinAndResend` on a voided order does the same.
6. A non-voided `waiting` order still resends as before: one call with
   `isRetry: true`, then `fiscalized` with the new invoice number.
7. Voided `waiting` and `needs_fixing` orders are excluded from
   `getUnfiledOrderCount` and `getOrdersNeedingAttention`. Live ones are still
   counted (2 of 4).
8. The renderer API has no `voidOrder`. This is a type-level fact, proven by
   typecheck.

**Tests that had to stay unmodified, and did:** `voids.test.ts`,
`reconciliation.test.ts`, `ipcValidator.test.ts`, the fiscal engine and
routing tests, and `mpesaPaymentGate.test.ts`. All pass and none was edited.

**The rebuild (`npm run dist`), run once, exit 0:**
- `verify-no-mock-provider`: *✓ Confirmed: neither mock provider is in out/main.*
- `verify-dist`: *✓ Confirmed: win-unpacked/resources/.env is bundled.*
- Output: `release/RUBIS POS Setup 2.0.0.exe` and `release/RUBIS POS 2.0.0.exe`
  (portable), both dated 2026-09-23 21:09, x64. This replaces the stale
  12-Sep build.
- The bundled `resources/.env` contains `VITE_TAX_RATE=0.16` (Item 1).
- `out/main/index.js` contains both new refusal strings.
- The build left the working tree clean.

**Not verified here:** the Order History screen was not driven by hand. Its
only change is removal, and typecheck confirms nothing still refers to the
removed code.

## 6. Rollback

`git revert 57e4010`, then rebuild. No data migration is involved, and
historical voided rows are untouched either way.

## 7. Observed but not changed

- **`voids.ts` and `db.voidOrder` can no longer be reached from the app.**
  They are kept for their tests. Deleting them later is a separate, test-only
  cleanup.
- **A Resend or Correct-PIN on a historical voided row writes to it** (see
  Residual risk). This is harmless.
- **The Retry Sync duplicate-order hazard remains.** Order History still
  offers Retry Sync on `pending_sync` orders
  ([POC_AS_BUILT_ASSESSMENT](./POC_AS_BUILT_ASSESSMENT.md) row K).
- **The installer is still unsigned**, so expect a SmartScreen prompt on the
  partner's machine.
- **`release/builder-effective-config.yaml` is still dated 12 Sep.**
  electron-builder did not rewrite it on this run. It is cosmetic.

**Next:** Item 2b, the first live 1-KSh cash sale from this build. It is run
by a person, and no code lands before it passes.
