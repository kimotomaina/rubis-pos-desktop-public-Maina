# Phase 7 — Shift Management, Z-Reports, and Admin Polish

**Date:** 2026-08-24 · **Branch:** `main` · **Previous:** [Phase 6](./phase-6.md)

## 1. Objective

Give RUBIS managers and cashiers the daily operational workflows their
legacy NEX POS provided: a cash-drawer shift with reconciliation, a
Z-report summarizing a shift's financials, and a back-office Admin
screen for today's sales, staff management, and shift controls.

## 2. A Real Design Conflict, Resolved Before Building

Phase 6 already writes a `shifts` row on every login (`clock_in`) and
logout (`clock_out`) — pure staff attendance. Phase 7 asks for an
explicit "Open Shift"/"Close Shift" flow with starting/ending cash and
a strict **one shift per day** rule. A per-login row can't satisfy
"one shift" (multiple cashiers log in and out all day) — the till
shift has to be a **single, store-wide session**, independent of who's
logged in at any moment.

**Resolution (confirmed with the user):** `shifts` now means a
store-wide register/till session, not attendance. Login/logout are
authentication only — `authenticateStaff` no longer calls `clockIn`,
and `auth:logout` no longer calls `clockOut` (both removed from
`auth.ts`/`database.ts`, since nothing had ever consumed the
attendance data anyway — it was write-only bookkeeping per Phase 6's
own "Known Limitations"). Opening/closing a shift is now a deliberate
action from the Admin screen, available to any logged-in staff member,
with only one shift open at a time — which gives the "1 shift per day"
rule (Q3) "for free": the Admin screen just disables "Open Shift"
whenever `getOpenShift()` returns a row.

## 3. Decisions

| # | Decision | Value |
| --- | --- | --- |
| Shift model | Store-wide till session (see §2), not per-login | — |
| Q1 | Admin access | `currentStaff.role === 'admin'` shows an "Admin" nav tab; hidden (and the screen itself defensively re-checks the role) for `cashier` |
| Q2 | Expected cash | `startingCash + Σ(order.total WHERE payment_method = 'cash' AND shift_id = shift)`. Discrepancy = `endingCash − expectedCash` |
| Q3 | One shift per day | Enforced by "only one `open` shift at a time" — `openShift` throws if one is already open; the Admin screen also disables the button |

## 4. Shift State Machine

```
                 no open shift
                       │
        Admin taps "Open Shift", enters starting cash
                       │
                       ▼
              db.openShift(staffId, startingCash)
         throws if a shift is already open (defense
         in depth — the UI already disables the button)
                       │
                       ▼
               shifts row: status='open'
         every checkout while open stamps shift_id
    on the order (orders:checkout reads getOpenShift())
                       │
        Admin taps "Close Shift", enters counted cash
                       │
                       ▼
              db.closeShift(shiftId, endingCash)
   cashTotal = Σ cash-order totals for this shift
   expectedCash = startingCash + cashTotal
   discrepancy  = endingCash − expectedCash
                       │
                       ▼
          shifts row: status='closed', clock_out set,
          expected_cash / ending_cash / discrepancy stored
                       │
                       ▼
        generateZReport(shiftId) → ZReportModal
           (with a "Print Z-Report" button)
```

A checkout made with no open shift still succeeds (`shift_id` is
nullable) — Phase 6's checkout flow keeps working exactly as before
even before a manager opens the day's till.

## 5. Z-Report Math

`src/main/services/reports.ts`:

- **`totalsByMethod`** — orders for the shift (`getOrdersForShift`,
  *any* sync status — cash was physically collected regardless of
  whether the order has synced to Shopify yet) summed by
  `payment_method` into `{ cash, mpesa, card }`.
- **`totalRevenue`** — `Σ order.total` across all payment methods.
- **`totalTax`** — `totalRevenue × taxRate`. Orders don't store tax
  individually (Phase 5/6 never charged tax at checkout — the printed
  receipt's "Tax" line has always been informational math from the
  store's configured rate). The Z-report keeps that same convention
  rather than silently introducing itemized tax as a Phase 7 side effect.
- **`expectedCash`** — for a **closed** shift, the value persisted by
  `closeShift` at close time; for a **still-open** shift, computed live
  (`startingCash + totalsByMethod.cash`) so the report can be previewed
  mid-shift. `endingCash`/`discrepancy` are `null` until the shift closes.

`generateDailySummary` runs the same `totalsByMethod`/`totalRevenue`/
`totalTax` aggregation over `getOrdersForDateRange` (default: the
current UTC calendar day via `getUtcDayRange`), independent of shift
boundaries — this feeds the Admin screen's "Today's Sales" cards and
deliberately has no cash-reconciliation fields (there's no till concept
at the daily-summary level, only at the shift level).

## 6. Admin Security Model

- **Navigation-level gate**: `App.tsx` only renders the "Admin" tab
  button when `currentStaff.role === 'admin'`; a `cashier` never sees
  the entry point.
- **Screen-level gate**: `AdminScreen.tsx` re-checks
  `currentStaff.role === 'admin'` itself and renders an "Access
  restricted" empty state otherwise — defense in depth in case
  `uiStore.activeView` ever outlives a role switch (e.g. an admin
  leaves the Admin tab active, logs out, and a cashier logs in without
  the tab resetting).
- **No PIN-hash exposure**: `staff:list`/`getActiveStaff()` never
  include `pin_hash`; `staff:create`/`staff:resetPin` hash the PIN
  with the Phase 6 `hashPin` (pbkdf2) before it ever reaches SQLite.
- **Role stays simple**: per Q1's recommended default, only
  `'admin'` vs `'cashier'` — no separate `'manager'` role, no PIN
  override path.

## 7. Printing: Receipt vs. Z-Report on One Channel

Per the brief, the Z-report reuses the existing `receipt:print` IPC
channel rather than adding a new one. The handler now accepts
`{ localId?, shiftId?, isZReport? }`; the preload script exposes this
as two distinct typed methods so call sites stay simple and type-safe:

```ts
window.api.printReceipt(localId)      // → { localId }
window.api.printZReport(shiftId)      // → { shiftId, isZReport: true }
```

`printer.ts` factors the shared connect/mock/execute/error-translation
flow into `sendToPrinter(render, settings, factory, label)`, so
`printReceipt` and the new `printZReport` differ only in which
`render*` function draws onto the client — `renderZReport` prints
store name + "Z-REPORT", shift #/opened/closed/cashier, starting cash,
per-method sales, order count, total revenue + tax, and the
expected/counted/discrepancy block — no line items, per the spec.

## 8. IPC Contract (Phase 7 additions)

| Channel | Direction | Payload |
| --- | --- | --- |
| `shifts:current` | invoke | → `ServiceResult<ShiftRow \| null>` |
| `shifts:open` | invoke | `{ staffId, startingCash }` → `ServiceResult<{ shiftId }>` |
| `shifts:close` | invoke | `{ shiftId, endingCash }` → `ServiceResult<{ expectedCash, discrepancy }>` |
| `reports:z-report` | invoke | `shiftId` → `ServiceResult<ZReport>` |
| `reports:daily-summary` | invoke | → `ServiceResult<DailySummary>` |
| `staff:create` | invoke | `{ name, pin, role }` → `ServiceResult<StaffSummary>` |
| `staff:resetPin` | invoke | `{ staffId, pin }` → `ServiceResult<void>` |
| `receipt:print` | invoke (changed) | now `{ localId? } \| { shiftId?, isZReport? }` |
| `orders:checkout` | invoke (changed) | now stamps `shift_id` from `db.getOpenShift()` |

## 9. Files Created / Modified

| File | Action | Purpose |
| --- | --- | --- |
| `src/main/services/database.ts` | Modify | `shifts` gains cash/status columns; `orders` gains `shift_id`; `openShift`/`closeShift`/`getOpenShift`/`getShiftById`/`getOrdersForShift`/`getOrdersForDateRange`/`resetStaffPin`; `clockIn`/`clockOut` removed |
| `src/main/services/auth.ts` | Modify | `authenticateStaff` no longer clocks in |
| `src/main/services/reports.ts` | Create | `generateZReport`, `generateDailySummary`, `getUtcDayRange` |
| `src/main/services/printer.ts` | Modify | `renderZReport`, `printZReport`, shared `sendToPrinter` helper |
| `src/main/index.ts` | Modify | shift/report/staff IPC handlers, checkout stamps `shift_id`, `receipt:print` branches on `isZReport` |
| `src/preload/index.ts`, `window.d.ts` | Modify | `printZReport`, `createStaff`, `resetStaffPin`, `getCurrentShift`, `openShift`, `closeShift`, `getZReport`, `getDailySummary`; `printReceipt` now wraps its IPC payload in an object |
| `src/renderer/src/stores/uiStore.ts` | Modify | `ActiveView` gains `'admin'` |
| `src/renderer/src/components/AdminScreen.tsx` | Create | today's sales, shift controls, staff management |
| `src/renderer/src/components/ZReportModal.tsx` | Create | shift financial summary + print button |
| `src/renderer/src/App.tsx` | Modify | Admin nav tab (role-gated), renders `AdminScreen` |
| `tests/shifts.test.ts` | Create | 10 tests |
| `tests/reports.test.ts` | Create | 10 tests |
| `tests/auth.test.ts` | Modify | removed now-obsolete clock-in assertions |
| `docs/phase-7.md` | Create | this document |

## 10. Testing Strategy

Same rule as every prior phase: mock the database boundary, never
touch real SQLite. `reports.test.ts` uses a fake exposing only
`getShiftById`/`getStaffById`/`getOrdersForShift`/`getOrdersForDateRange`
(the auth.test.ts fake-db pattern). `shifts.test.ts` extends the
established recording-fake `better-sqlite3` connection (from
`database.test.ts`) with queued `.get()` results, since `openShift`/
`closeShift` issue multiple sequential reads/writes per call.

```bash
npm test           # vitest run — 17 files / 164 tests
npm run typecheck  # tsc --noEmit (node + web) — clean
```

| Suite | Coverage highlights |
| --- | --- |
| `shifts.test.ts` (10) | opens with starting cash, rejects opening when already open, `getOpenShift` present/absent, expected-cash math (starting + cash orders, mpesa excluded), positive and negative discrepancy, rejects closing an unknown/already-closed shift, `getOrdersForShift` query shape, `shift_id` persisted via `queueOrder` |
| `reports.test.ts` (10) | payment-method summation, tax computed from the store rate, closed-shift figures come from the persisted row, open-shift figures are computed live with a `null` discrepancy, staff-name resolution (+ "Unknown" fallback), throws for a missing shift, daily-summary aggregation + default UTC-day range, `getUtcDayRange` boundary math |

## 11. Known Limitations (candidate backlog)

- **UTC day boundaries** — `getUtcDayRange`/"Today's Sales" use UTC
  midnight, not the store's local timezone; a late-evening sale near
  midnight local time could land in the "wrong" day's summary.
- **No overnight-shift auto-close** — per Q3, a shift left open past
  midnight just stays open; there's no scheduled job to force-close it.
- **No shift history list** — the Admin screen shows only the
  currently open shift and today's aggregate; browsing *past* shifts'
  Z-reports isn't implemented yet.
- **`role` still only gates the Admin screen** — no per-feature
  permission model beyond that single boolean check.

---

*Phase 7 status: implementation complete — `npm test` (164/164) and
`npm run typecheck` both pass.*
