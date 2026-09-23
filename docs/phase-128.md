# Phase 128 — Item 1 (VITE_TAX_RATE=0.16) applied, Item 2 (void guard) audited

> Skill-structured report, moved from the retired `tracker/2026-09-23-2029-vat-config-and-void-guard-audit.md`. Companion: [phase-123](./phase-123.md).

- **Date:** 2026-09-23 20:29
- **Requested:** Item 1: set VITE_TAX_RATE=0.16 and rebuild the exe. Item 2: a voided order can never be fiscalized by Resend or the engine, and void needs a PIN. Audit first, then STOP.
- **Outcome:** Partially implemented (Item 1 config applied, rebuild blocked). Item 2 is audit only.
- **Branch / base commit:** staging @ 8871592. The tree is NOT clean: `package.json` has an unexplained modification (see section 7).

## 1. Audit

### What was examined
- voids.ts
- the `orders:void` handler (index.ts:2081-2103)
- `voidOrderSchema` (ipcValidator.ts:86) and tests/ipcValidator.test.ts:136-150
- `db.voidOrder` (database.ts:1639-1665)
- the whole of fiscal-retry.ts and fiscal-engine.ts
- OrderHistory.tsx:79-97 and `App.tsx` `requestManagerPin` (167-170)
- tests/voids.test.ts
- `.env` and `.env.example`

### How it currently works
The PIN is checked in the renderer only; the main process accepts a bare `localId`. Void deletes the queue rows but leaves `fiscal_status` alone. Resend and correct-PIN never check `status`, and they can re-queue a voided order into the engine. See docs/phase-123.md for routes R1–R4.

### Dependencies found
- **Inbound:** the `orders:void`, `fiscal:resend` and `fiscal:correct-pin-and-resend` IPC channels; the fiscal engine's `tick`.
- **Outbound:** `requireAdminPin` (the pattern to reuse), `db.getOrder`.
- **String-based:** the IPC channel names above, and `VITE_TAX_RATE` (read at runtime, index.ts:513).

### Risks and constraints identified
- `fiscal-retry.ts` is fiscal-engine code. The guard must keep the engine and retry tests unmodified, so the new field is an optional `status`.
- `ipcValidator.test.ts` asserts that `voidOrderSchema` rejects an object. A new request schema that reuses it keeps that test unmodified.

## 2. Changes made
- `.env`: added `VITE_TAX_RATE=0.16` with a comment. The file is untracked and is bundled into the exe.
- `.env.example`: the default went from 0 to 0.16, and the comment was corrected.
- `docs/phase-123.md`: the Item 2 audit and plan.
- `tracker/2026-09-23-2045-…` renamed to `…-2025-…`. The earlier filename carried a wrong time.

## 3. Affected files and functionality

| File | Change | Functionality affected |
| --- | --- | --- |
| .env | Modified | The VAT rate filed on class-A lines, and the tax printed on receipts and reports |
| .env.example | Modified | The template default for new installs |
| docs/phase-123.md | Added | Documentation only |

## 4. Possible impact
- **Direct:** once the till restarts, or the exe is rebuilt, class-A lines send `VATGrRate="16.00"` instead of `"0.00"`.
- **Indirect:** receipts, the Z-report and the daily summary show tax on top, e.g. `Total: 1.16` on a 1.00 sale. Accepted for the POC; Item 3 fixes it.
- **Data / schema / contract:** none.
- **Security posture:** unchanged.
- **Idempotency / re-run safety:** a static config value, safe to re-run.
- **Residual risk:** that the device accepts `"16.00"` is VERIFY-ON-DEVICE (GO_LIVE_READINESS.md:430 says to try `"16"` if it is rejected).

## 5. Verification
- Confirmed `.env` is git-ignored and `.env.example` is tracked.
- Tests and typecheck NOT run: `package.json` currently has no `scripts`.

## 6. Rollback
- Remove the `VITE_TAX_RATE` line from `.env`, or from `resources/.env` on the till, and restart.
- `git checkout -- .env.example`.

## 7. Observed but not changed
- **`package.json`:** the working copy lost all of `scripts` and `devDependencies` (mtime 20:03 today). It is not part of this work; awaiting a decision to restore it from git.
- **R4:** the inline first-submit void race in `runCheckout` (docs/phase-123.md).
- A filed sale can be voided (decision 2 in docs/phase-123.md).
- Voided sales stay in the unfiled count (decision 3 in docs/phase-123.md).
