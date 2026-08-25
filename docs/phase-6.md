# Phase 6 — Staff Authentication, Shift Tracking, and Checkout Flow

**Date:** 2026-08-24 · **Branch:** `main` · **Previous:** [Phase 5](./phase-5.md)

## 1. Objective

Checkout has been anonymous and single-click since Phase 3, and the
printed receipt pulled "cashier name" and "payment method" from static
`.env` values set once at app startup. Phase 6 closes both gaps: staff
must PIN-authenticate before touching the POS, every sale records who
rang it up and how it was paid (cash with tendered/change, or M-Pesa/
card with a reference number), and the receipt prints that real
transaction data instead of placeholders.

## 2. Decisions

| # | Decision | Value |
| --- | --- | --- |
| Q1 | PIN hashing | `crypto.pbkdf2Sync` (100,000 iterations, sha512, 64-byte key) — zero extra native-module surface |
| Q2 | Shift tracking | Simple `shifts` table: one row per login (`clock_in`) closed on logout (`clock_out`). No Z-report reconciliation yet (Phase 7 candidate) |
| Q3 | Insufficient tender | "Complete Sale" stays disabled and red "Insufficient amount" text shows until tendered ≥ total |
| Session persistence | **In-memory only** — `authStore.currentStaff` is a plain (non-persisted) Zustand field; every app launch requires PIN re-entry, matching till/POS security practice |
| Seed PIN | Default admin account seeded on first run with PIN `1234` (`DEFAULT_ADMIN_PIN` in `main/index.ts`) — **change this after setup** |

## 3. Data Model

```sql
CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'cashier' CHECK (role IN ('admin', 'cashier')),
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id INTEGER NOT NULL,
  clock_in TEXT NOT NULL,
  clock_out TEXT
);

-- orders: + staff_id, payment_method, tendered_amount, change_due, reference_number
```

`pin_hash` stores a single `"<saltHex>:<hashHex>"` string — no
separate salt column, keeping the schema minimal (mirrors how
`payload_json` already bundles a data snapshot elsewhere in this
schema).

`OfflineOrderPayload` (`shopify-types.ts`) gained `staffId, staffName,
paymentMethod, tenderedAmount, changeDue, referenceNumber?` — a
**denormalized snapshot** taken at sale time. This means `receipt:print`
(including reprints) and the Shopify push read complete transaction
data straight out of `payload_json` with no join back to `staff`, so a
receipt still prints correctly even if the staff account is later
deactivated.

## 4. Auth Flow

```
Login screen (staff:list) ──► tap a name tile ──► PIN pad
                                                       │ submit
                                                       ▼
                                     auth:login { staffId, pin }
                                                       │
                          authenticateStaff(db, staffId, pin)
                        ┌──────────────────────────────┴───────────────┐
                        │ staff missing / inactive / wrong PIN          │ found + active + correct PIN
                        ▼                                               ▼
                "Incorrect PIN" (generic —                        db.clockIn(staffId)
                 doesn't reveal which failed)                            │
                                                                           ▼
                                                      authStore.currentStaff set
                                                      → App.tsx swaps LoginScreen
                                                        for the POS shell
```

`verifyPin`/`hashPin` are pure functions in `src/main/services/auth.ts`,
directly unit-tested with no database involved. `authenticateStaff`
orchestrates the DB lookup + PIN check + clock-in, and is tested
against a fake exposing only the two `RubisDatabase` methods it calls
— the same narrow-fake pattern used for `better-sqlite3` and the
Shopify axios client elsewhere in this codebase.

Logging out (`auth:logout`) clears `authStore.currentStaff` and calls
`db.clockOut(staffId)`, which closes that staff member's most recent
open shift row.

## 5. Checkout State Machine

The cart's existing "Checkout" button now opens `CheckoutModal`
(`uiStore.checkoutModalOpen`) instead of calling `checkout()` directly:

```
              tap "Checkout"
                    │
                    ▼
          pick payment method
        ┌───────────┼───────────┐
        ▼           ▼           ▼
      Cash        M-Pesa       Card
        │           │           │
   numpad for    text field for reference number
  "Amount Tendered"        (blank ⇒ disabled)
        │
   live "Change Due" = calculateChange(total, tendered)
   tendered < total ⇒ "Insufficient amount", disabled
        │
        ▼
     canCompleteSale(...) === true ⇒ "Complete Sale" enabled
                    │
                    ▼
     cartStore.checkout({ staffId, paymentMethod,
       tenderedAmount, changeDue, referenceNumber? })
                    │
        ┌───────────┴────────────┐
        ▼                        ▼
   success (synced /       failure (error)
   queued-offline)          │
   → modal auto-closes      → error shown inline,
                              modal stays open
```

`calculateChange`/`canCompleteSale` (`src/renderer/src/lib/checkoutMath.ts`)
are pure, dependency-free functions — directly unit-tested without
mounting `CheckoutModal`, the same rationale as Phase 5's barcode
timing logic being a pure function.

**Payment math:**
- Cash: `changeDue = max(0, round2(tendered - total))`; submission
  gated on `tendered >= total`.
- M-Pesa / Card: `tenderedAmount` is set to the total and `changeDue`
  to `0` (no change concept); submission gated on a non-blank
  reference number.

## 6. Receipt: Real Data Instead of Static Config

`printer.ts`'s `PrinterSettings` **dropped** `cashierName`/
`paymentMethod` — those were per-order, not store-level, and forcing
them through startup env vars was the Phase 5 placeholder this phase
removes. `ReceiptOrder` **gained** `cashierName, paymentMethod,
tenderedAmount, changeDue, referenceNumber?`, sourced by the
`receipt:print` handler straight from the order's stored
`OfflineOrderPayload` — no staff-table lookup needed at print time.

`renderReceipt`'s payment section now prints:
```
Payment: cash
Tendered: $50.00
Change: $1.41
```
or, for M-Pesa/Card:
```
Payment: card
Ref: TXN-9001
```

`orders.ts`'s `buildOrderInput` also appends the cashier name and
payment summary to the Shopify order's `note` field (additive only —
Shopify has no till-payment-method concept to map onto).

## 7. IPC Contract (Phase 6 additions)

| Channel | Direction | Payload |
| --- | --- | --- |
| `staff:list` | invoke | → `ServiceResult<StaffSummary[]>` |
| `auth:login` | invoke | `{ staffId, pin }` → `ServiceResult<StaffSummary>` |
| `auth:logout` | invoke | `{ staffId }` → `ServiceResult<void>` |
| `orders:checkout` | invoke (changed) | `CheckoutRequest` now includes `staffId, paymentMethod, tenderedAmount, changeDue, referenceNumber?` |

## 8. UI Integration

- **`LoginScreen.tsx`** — full-screen gate rendered by `App.tsx`
  whenever `authStore.currentStaff` is null. Staff-name tiles (from
  `staff:list`) → numeric PIN pad (dot indicator, backspace, Enter).
  A failed attempt shows the error and clears the pad.
- **`CheckoutModal.tsx`** — payment method → amount/reference → submit,
  as above.
- **`App.tsx`** header — shows the logged-in staff's name + role and a
  Log Out button; the barcode scanner hook is now also gated on
  `!!currentStaff` (no scanning at the login screen).

## 9. Files Created / Modified

| File | Action | Purpose |
| --- | --- | --- |
| `src/main/services/auth.ts` | Create | `hashPin`, `verifyPin`, `authenticateStaff` |
| `src/main/services/database.ts` | Modify | `staff`/`shifts` tables, `orders` columns, staff/shift CRUD methods |
| `src/main/services/shopify-types.ts` | Modify | `OfflineOrderPayload` payment/staff fields |
| `src/main/services/orders.ts` | Modify | `buildOrderInput` note includes cashier + payment summary |
| `src/main/services/printer.ts` | Modify | `PrinterSettings`/`ReceiptOrder` reshaped; receipt payment section |
| `src/main/index.ts` | Modify | admin seed, `printerSettings` trimmed, `staff:list`/`auth:login`/`auth:logout` handlers, `orders:checkout`/`receipt:print` updated |
| `src/preload/index.ts`, `window.d.ts` | Modify | `getStaffList`, `login`, `logout`, extended `checkout` |
| `src/renderer/src/stores/authStore.ts` | Create | non-persisted session store |
| `src/renderer/src/stores/cartStore.ts` | Modify | `checkout(params)` now takes payment details |
| `src/renderer/src/stores/uiStore.ts` | Modify | `checkoutModalOpen` |
| `src/renderer/src/lib/checkoutMath.ts` | Create | `calculateChange`, `canCompleteSale` |
| `src/renderer/src/components/LoginScreen.tsx` | Create | PIN login gate |
| `src/renderer/src/components/CheckoutModal.tsx` | Create | payment method + tender/reference collection |
| `src/renderer/src/App.tsx` | Modify | login gate, staff header, checkout button opens the modal |
| `tests/auth.test.ts` | Create | 11 tests |
| `tests/checkout.test.ts` | Create | 9 tests |
| `tests/cartCheckout.test.ts`, `tests/database.test.ts`, `tests/orders.test.ts`, `tests/syncEngine.test.ts`, `tests/printer.test.ts` | Modify | fixture/signature ripple from the new checkout & receipt fields |
| `docs/phase-6.md` | Create | this document |

## 10. Testing Strategy

Same rule as every prior phase: mock the boundary, never touch it for
real. `auth.test.ts` calls `hashPin`/`verifyPin` directly (real
`crypto`, no I/O) and exercises `authenticateStaff` against a fake
exposing only `getStaffById`/`clockIn`. `checkout.test.ts` calls the
pure `checkoutMath` functions directly — no React mounting needed.

```bash
npm test           # vitest run — 15 files / 144 tests
npm run typecheck  # tsc --noEmit (node + web) — clean
```

| Suite | Coverage highlights |
| --- | --- |
| `auth.test.ts` (11) | salted hash uniqueness, hash format, correct/incorrect PIN, malformed/mismatched-length hash never throws, successful login clocks in, wrong PIN / inactive staff / unknown id all fail without clocking in, identical generic error for wrong-PIN vs. unknown-id (no enumeration) |
| `checkout.test.ts` (9) | change math (over/exact/insufficient tender, floating-point rounding), cash gating, mpesa/card blank-vs-filled reference gating |
| `database.test.ts`, `orders.test.ts`, `syncEngine.test.ts`, `printer.test.ts`, `cartCheckout.test.ts` (updated) | new order/payload/receipt fields threaded through existing assertions; new `buildOrderInput` note-content and non-cash receipt-line tests |

## 11. Known Limitations (candidate backlog)

- **No Z-report / cash-drawer reconciliation** — `shifts` rows exist
  but nothing yet summarizes sales-per-shift or reconciles tendered
  cash against expected totals (explicitly deferred to Phase 7 per Q2).
- **No PIN-change UI** — staff PINs can only be set today via
  `db.createStaff`; there's no admin screen to add staff or rotate PINs.
- **`role` is stored but unenforced** — `admin` vs `cashier` doesn't
  yet gate any feature; it's recorded for future use.
- **Receipt tax rate stays store-level** — `PrinterSettings.taxRate`
  (env-configured) is unchanged; only cashier/payment/tender data
  moved to per-order.

---

*Phase 6 status: implementation complete — `npm test` (144/144) and
`npm run typecheck` both pass.*
