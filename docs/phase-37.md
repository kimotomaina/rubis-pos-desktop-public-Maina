# Phase 37 — Auto-Open PDF Receipt Fallback

*Note: this is unrelated to the "M-Pesa Daraja integration" originally
planned as Phase 37 in the Phase 35–37 roadmap — that work was
deliberately deferred pending real credentials (see
[Phase 36](./phase-36.md)'s closing note) and hasn't been built yet.
This phase number reflects actual chronological order instead.*

**Date:** 2026-08-31 · **Branch:** `main` · **Previous:** [Phase 36.1](./phase-36-1.md)

## 1. Objective

`printReceipt`/`printZReport` (`src/main/services/printer.ts`) already
fall back to saving a PDF (`mode: 'pdf'`, with a `filePath`) when the
configured thermal printer is unreachable — but the saved file was
never surfaced to the cashier beyond the print result's metadata. Per
request: after "Print Receipt" (Order History) saves a PDF instead of
reaching the printer, open it automatically — and only in that
fallback case, never when the physical printer actually printed.

## 2. Fix (`src/main/index.ts`)

Added `openPdfFallbackIfPresent`, a small wrapper around a
`ServiceResult<ReceiptPrintResult>`:

```ts
const openPdfFallbackIfPresent = (
  result: ServiceResult<ReceiptPrintResult>
): ServiceResult<ReceiptPrintResult> => {
  if (result.success && result.data?.mode === 'pdf' && result.data.filePath) {
    void shell.openPath(result.data.filePath)
  }
  return result
}
```

Applied to both branches of the existing `receipt:print` IPC handler —
the Z-report path (`printZReport`) and the order-receipt path
(`printReceiptToType`) — so both a receipt and a Z-report open their
saved PDF the same way; the check on `mode === 'pdf'` means a
successful thermal print never triggers it. `shell` was already
imported in `index.ts` (used elsewhere for `shell.openExternal`), so
no new import was needed.

## 3. Testing

No new test added — this codebase has no existing precedent of
testing `index.ts`'s `ipcMain.handle` wiring directly (confirmed: no
test file references `ipcMain.handle` or imports from
`src/main/index.ts`); `printer.ts`'s own `mode: 'pdf'`
fallback-generation logic was already covered before this phase and is
unchanged here. `shell.openPath` is a thin Electron API call with no
logic of its own to verify beyond "was it called," which would require
mocking `electron` for a one-line assertion.

## 4. Verification

- `npm test` — 557/557 passing (44 files), no regressions.
- `npx tsc --noEmit -p tsconfig.node.json` — no new errors (only the
  pre-existing, unrelated cross-project `TS6307` noise).

## 5. Follow-ups

None — this was a small, self-contained fix.
