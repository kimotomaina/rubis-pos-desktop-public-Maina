# Phase 226 — Fix: opening a shift's Z report said "Invalid input: expected object, received number"

- **Date:** 2026-10-05
- **Reported:** after creating a shift by hand (start 0, end 3790) and closing it, tapping the shift in Shift History shows `request: Invalid input: expected object, received number`.
- **Status:** fixed and tested. **Not checked on the till**, not released.

## 1. Cause

`reports:z-report` validates its request with `zReportRequestSchema`, which is `{ shiftId }` (docs/phase-158). The preload's `getZReport` still sent the bare number (`ipcRenderer.invoke('reports:z-report', shiftId)`), so the schema refused every call. Every screen that calls `getZReport` was affected: Shift History (opening a shift), Admin's Close Shift (which loads the report after closing) and the Z-Report modal's reload. It was not specific to a manual shift.

## 2. What changed

| Where | Change |
| --- | --- |
| [preload/index.ts](../src/preload/index.ts) | `getZReport` sends `{ shiftId }`. The renderer API (`getZReport(shiftId: number)`) is unchanged. |
| New [zReportRequestShape.test.ts](../tests/zReportRequestShape.test.ts) | Loads the real preload with `electron` mocked, calls `getZReport(5)`, asserts the invoke payload is `{ shiftId: 5 }`, that `zReportRequestSchema` accepts it, and that the bare number `5` is refused. |

Not changed: the schema, the handler, the report, printing (`receipt:print` already sent an object).

## 3. Checked

- Other preload calls that send a bare value were compared with their handlers: `mpesa:query-status` (schema is a string), `mpesa:get-logs`, `config:get-all`, `integrations:get-config` and `secrets:set-shopify-token` (no object schema) all agree. `reports:z-report` was the only mismatch found.
- `npm run typecheck` clean; full suite **205 files, 3389 passed, 1 skipped**.

## 4. For the owner to check on the till

1. Reports, Shift History, tap the manual shift: the Z report opens with starting cash 0 and ending cash 3790.
2. **Print Z-Report** sends it to the printer.

## 5. Rollback

Revert this commit. Opening a Z report fails again with the same message. Nothing stored changed.
