# Phase 126 — Change 1 audit — LIVE / DRY-RUN fiscal switch

> Skill-structured report, moved from the retired `tracker/2026-09-23-1956-fiscal-dry-run-audit.md`. Companion: [phase-122](./phase-122.md).

- **Date:** 2026-09-23 19:56
- **Requested:** Audit how the fiscal provider is selected and whether a packaged build can dry-run fiscalization against the mock without reopening the "mock can ship" hole. Propose the smallest safe route, then STOP.
- **Outcome:** No change needed (audit only; build awaits review)
- **Branch / base commit:** staging @ 8871592 (clean)

## 1. Audit

### What was examined
- `fiscal-provider-factory.ts`: the one selection point.
- `index.ts` 529–731: boot-time resolution, `applyEtimsConfigToProvider` (reconfigure), and `receipt:print`.
- `mock-etims-provider.ts` and `scripts/verify-no-mock-provider.cjs`: the phase-90 fence.
- `mock-zfplab-server/engine.ts`, `run.ts` and `tests/fixtures/wire/*.xml`: the mock server.
- `electron-builder.yml`: what the exe actually ships.
- `checkout.ts`: the fiscal block.
- `fiscal-retry.ts`: the resend guards.
- `database.ts`: `FiscalStatus`, the CHECK constraint, the unfiled count and the needs-attention queries.
- `printer.ts`: the fiscal block condition.
- `saleCompleteToast.ts` and `ConnectivityBadges.tsx`: what the screen shows.

### How it currently works
The provider is resolved once, at boot. A packaged build always gets `RealFiscalizationProvider`. The mock is dev-only: it is loaded through a dynamic import and stripped from the bundle, and `postbuild` asserts that it is gone. The mock ZFP server is a repo-only `vite-node` script on port 4444, which is the same port the real bridge uses. Its fixtures return a real-format 19-digit invoice number (`…042`) that is the same for every sale.

### Dependencies found
- **Inbound:** `index.ts` (boot, `applyEtimsConfigToProvider`, `fiscalEngine`, resend handlers), `tests/fiscalProviderFactory.test.ts`.
- **Outbound:** `RealFiscalizationProvider`, and the `import.meta.env.DEV` dynamic import.
- **String-based:** config keys `mock_etims_enabled`, `VITE_USE_MOCK_ETIMS`, `etims.baseUrl`; the guard's forbidden strings `KRA-MOCK-`, `MockFiscalizationProvider`, `MockMpesaProvider`.

### Risks and constraints identified
- The mock provider cannot be selected in the exe, by design.
- The mock-server route has four blockers: it is not shipped, it collides on port 4444, its invoice number looks real, and it returns the same number for every sale.
- The mock-server route also has a silent **label inversion** hazard: `dry-run` set with the URL still on the real bridge files a real invoice that is then hidden from the unfiled count.
- The `fiscal_status` CHECK constraint rules out adding a new status value without rebuilding the table.

## 2. Changes made
No code changed. The audit and proposal are written to `docs/phase-122.md`. The recommendation: dry-run means **do not fiscalize at all**. The sale is marked `fiscal_mode='dry-run'` and `fiscal_status` stays NULL. It is already excluded from the unfiled count and needs attention, and it cannot be resent because no request is stored. It prints a TEST banner, and the mode is read per sale, so no restart is needed. The factory, the guard, the fiscal engine and the real provider are all left untouched.

## 3. Affected files and functionality

| File | Change | Functionality affected |
| --- | --- | --- |
| docs/phase-122.md | Added | Audit and proposal only |

## 4. Possible impact
- **Direct:** none. Nothing changed.
- **Indirect:** none.
- **Data / schema / contract:** none yet. The proposal adds a nullable `orders.fiscal_mode` column.
- **Security posture:** unchanged. The proposal keeps the phase-90 guard intact.
- **Idempotency / re-run safety:** n/a.
- **Residual risk:** under the proposal, dry-run does not prove that the device accepts an invoice. Test Connection, ReadStatus and the first live sale cover that.

## 5. Verification
Read-only audit. No tests were run, because no code changed.

## 6. Rollback
Delete `docs/phase-122.md`.

## 7. Observed but not changed
- The PDF receipt fallback (`pdf-receipt.ts`) prints no fiscal block, even for real fiscalized sales.
- A live till can already be pointed at the mock server by URL, and nothing marks it.
- The `[DEBUG-ETIMS]` boot lines (`index.ts:592`, `:724`) log regardless of `fiscalDebugLogging`.
