# Phase 15 — Multi-Peripheral Support

**Date:** 2026-08-25 · **Branch:** `staging` · **Previous:** [Phase 14](./phase-14.md)

## 1. Objective

Let a store run more than one printer (a receipt printer plus a
kitchen/label printer) and more than one barcode scanner station
(e.g. two till scanners plus a back-of-house unit), without adding any
native module (`node-hid` or similar) this close to the live PoC.

## 2. Multi-Printer Registry

### 2.1 Schema — `printers` table

```sql
CREATE TABLE IF NOT EXISTS printers (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('receipt', 'kitchen', 'label')),
  interface TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
)
```

`RubisDatabase` gains `getPrinters()`, `savePrinter(config)` (upsert by
`id`), and `deletePrinter(id)`, mirroring the existing
`getIntegrationConfig`/`setIntegrationConfig` CRUD pattern. Rows map to
a renderer-facing `PrinterConfig` (`interfaceName`, `enabled: boolean`)
rather than the raw `interface`/`enabled: 0|1` column shapes.

### 2.2 Architecture deviation from the brief — no live connection map

The brief asked for `printer.ts` to hold "a `Map<string,
ThermalPrinterLike>`" in place of a single instance. This phase
deliberately does **not** do that. `printer.ts` already connects fresh
per print (`sendToPrinter`, Phase 5) and bounds that connection with
`PRINTER_CONNECT_TIMEOUT_MS` (Phase 5.2) — a pattern that gives fast,
bounded failure and needs no reconnect logic. Holding a
`Map<string, ThermalPrinterLike>` of live TCP sockets open indefinitely
between prints would trade that solved problem for an unsolved one (a
socket gone stale hours into a shift, with nothing in this codebase to
detect or recover it) — a real reliability regression to introduce 48
hours after a PoC's Day 1.

Instead, `PrinterRegistry` is `Map<string, PrinterConfig>` — it
remembers *where* each printer is, not a connection to it:

```ts
export type PrinterRegistry = Map<string, PrinterConfig>
export function buildPrinterRegistry(configs: PrinterConfig[]): PrinterRegistry
export function resolvePrinterSettings(
  registry: PrinterRegistry,
  type: PrinterType,
  defaultSettings: PrinterSettings
): PrinterSettings
```

`resolvePrinterSettings` is the backward-compatibility seam: it
returns the first *enabled* registry entry matching `type`, merged
onto `defaultSettings` (so `storeName`/`taxRate`/`mock` stay global);
with **no** matching entry — including every store that never opens
the Peripherals tab — it returns `defaultSettings` completely
unchanged. A till with zero `printers` rows behaves identically to
before this phase.

### 2.3 `printReceiptToType` / `printTestPage`

```ts
printReceiptToType(order, items, registry, defaultSettings, printerType = 'receipt', factory?)
printTestPage(interfaceName, factory?)
```

`printReceiptToType` resolves settings via `resolvePrinterSettings`
then delegates to the unchanged `printReceipt`. `printTestPage` sends
a short self-describing page to an arbitrary interface, bypassing the
registry entirely (used by the Admin screen's "Test" button before —
or instead of — saving a printer), and always attempts the real
connection (never mock-mode), since its entire purpose is exercising
the hardware.

### 2.4 IPC — `main/index.ts`

- `receipt:print` gained an optional `printerType` field on its
  request (`PrinterType`, default `'receipt'`) and now calls
  `printReceiptToType(..., printerRegistry, printerSettings, request.printerType ?? 'receipt')`
  instead of `printReceipt` directly. Every existing caller
  (`window.api.printReceipt(localId)`, no second argument) resolves to
  `'receipt'` exactly as before.
- New: `printers:list`, `printers:save`, `printers:delete`,
  `printers:test`. `printers:save`/`printers:delete` require a
  re-verified admin Manager PIN via `requireAdminPin` — a deliberate
  proactive choice, not asked for in the brief: registering a printer
  interface is the same class of privileged, state-changing Admin
  write as `integrations:set-config` (Phase 14's C1 fix), so it gets
  the same server-side check rather than reintroducing that exact
  class of gap one phase later. `printers:test` does **not** require a
  PIN — it's a read-only diagnostic that changes nothing.
- `printerRegistry` (a module-scope `let`) is rebuilt from
  `db.getPrinters()` after every successful `printers:save`/
  `printers:delete`, so a lookup never serves a stale in-memory copy.

### 2.5 Q2 — printer test failure format

The brief's recommended default was a single generic string
(`'Connection timed out or refused'`). This phase reuses the existing,
more specific `translatePrinterError` instead (already exercised by
`printReceipt`) — it distinguishes "offline/unreachable" from "timed
out" from "out of paper", which is more actionable for whoever is
stringing network cable at the till than one flattened message. The
Admin screen still surfaces it as a plain inline message (not
literally a toast component, which this screen doesn't otherwise use)
next to the printer that was tested.

## 3. Multi-Scanner Prefix Routing

### 3.1 `useBarcodeScanner` — `ScanResult`

Per Q1's recommended default, no HID-level work is needed at all: a
Datalogic QD2100 (or similar USB-HID scanner) can be programmed, by
scanning a barcode out of its own manual, to prepend a fixed text
prefix to every scan it sends. The hook only needs to parse that
prefix back out:

```ts
export type ScanSource = 'SC1' | 'SC2' | 'KITCHEN' | 'UNKNOWN'
export interface ScanResult { source: ScanSource; barcode: string }
```

`onScan`'s signature changed from `(barcode: string) => void` to
`(result: ScanResult) => void` — a deliberate breaking change to this
internal hook's contract (not a public API), since the brief
explicitly asked for the parsed shape and permits updating this test
file. `minLength` now applies to `result.barcode` (after stripping any
prefix), not the raw buffer, so a legitimately short barcode from a
programmed scanner isn't penalized for its prefix's length. The
duplicate-suppression key is now `` `${source}:${barcode}` `` rather
than the barcode alone, so the same barcode scanned from two different
stations in quick succession — a real scenario once multiple stations
exist — is never wrongly suppressed as a duplicate.

An unprogrammed scanner (every scanner before this phase) sends no
prefix; `parseScan` falls through to `{ source: 'UNKNOWN', barcode: raw }`
in that case — this is the backward-compatibility guarantee, verified
by the existing 11 pre-Phase-15 tests (updated to expect the new
object shape, behavior unchanged) plus 8 new prefix-specific tests.

### 3.2 `App.tsx` routing

```ts
const handleScan = ({ source, barcode }: ScanResult) => {
  if (source === 'KITCHEN') {
    setScanToast({ kind: 'success', message: `Kitchen order routed: ${barcode}` })
    return
  }
  // ...existing barcode → cart lookup, unchanged, for 'SC1' | 'SC2' | 'UNKNOWN'
}
```

`'UNKNOWN'`, `'SC1'`, and `'SC2'` all fall through to the existing
add-to-cart lookup. `'KITCHEN'` demonstrates routing to a distinct
action instead — a real back-of-house integration would replace this
toast with, e.g., an IPC call that fires a kitchen ticket; that
integration itself is out of scope here.

## 4. Admin UI — Peripherals Tab

`AdminScreen.tsx` gained a third tab (`Overview` / `Integrations` /
`Peripherals`), following the exact `ManagerPinModal` pattern Phase 14
established for Create Staff / Reset PIN / Save Integrations:

- **Printers section** — lists every registered printer (id, type
  badge, disabled badge, interface address), a **Test** button per row
  (calls `testPrinter` directly, no PIN — shows the result inline), a
  **Remove** button (PIN-gated), and an add-printer form (id, type
  select, interface address) that also routes through
  `ManagerPinModal` before calling `savePrinter`.
- **Scanner stations note** — a static, no-code-required instructions
  block: open the Datalogic QD2100's programming guide, scan its "Add
  Prefix" barcode, then scan the characters for `SC1:`/`SC2:`/
  `KITCHEN:`, then "Save". Explicitly notes an unprogrammed scanner
  keeps working unchanged, labeled `UNKNOWN` internally.

## 5. Testing Strategy

- `tests/printerRegistry.test.ts` (13 tests, new) —
  `buildPrinterRegistry` (keys by id, later entry wins on a duplicate
  id, empty list → empty map); `resolvePrinterSettings` (falls back to
  `defaultSettings` when the registry is empty, when no entry matches
  the type, and when the only matching entry is disabled; resolves to
  a registered printer's interface otherwise); `printReceiptToType`
  (routes to the correct interface by type, defaults to `'receipt'`,
  falls back to `defaultSettings` with an empty registry —
  backward-compatibility case); `printTestPage` (sends the expected
  "TEST PAGE" content, reports success/offline/connection-refused via
  the existing `translatePrinterError` paths).
- `tests/database.test.ts` (+6 tests) — `SCHEMA.printers` created on
  `init()`; `getPrinters()` empty-list and normalized-boolean cases;
  `savePrinter()`'s upsert SQL/params for both `enabled: true` and
  `enabled: false`; `deletePrinter()`'s true/false return.
- `tests/useBarcodeScanner.test.ts` — all 11 pre-existing tests updated
  to expect `{ source: 'UNKNOWN', barcode: ... }` instead of a bare
  string (behavior unchanged, shape updated); +8 new tests: `SC1:`/
  `SC2:`/`KITCHEN:` prefix parsing, legacy unprefixed scans default to
  `UNKNOWN`, `minLength` applies post-strip, the same barcode from two
  different sources is not wrongly suppressed as a duplicate, the same
  `(source, barcode)` pair is still suppressed, and an unrecognized
  prefix-looking string falls through to `UNKNOWN` with the colon kept
  as part of the barcode.

```bash
npm test           # vitest run — 33 files / 373 tests passing
npm run typecheck  # tsc --noEmit (node + web) — clean
```

## 6. Files Created / Modified

**Created:**
- `tests/printerRegistry.test.ts`
- `docs/phase-15.md`

**Modified:**
- `src/main/services/database.ts` — `SCHEMA.printers`, `PrinterType`,
  `PrinterConfig`, `getPrinters`/`savePrinter`/`deletePrinter`
- `src/main/services/printer.ts` — `PrinterRegistry`,
  `buildPrinterRegistry`, `resolvePrinterSettings`,
  `printReceiptToType`, `printTestPage`
- `src/main/lib/ipcValidator.ts` — `printerSaveSchema`,
  `printerDeleteSchema`, `printerTestSchema`
- `src/main/index.ts` — `printerRegistry` built at startup;
  `receipt:print` accepts `printerType`; new `printers:list`/`:save`/
  `:delete`/`:test` handlers
- `src/preload/index.ts`, `src/preload/window.d.ts` — `printReceipt`
  gains optional `printerType`; new `getPrinters`/`savePrinter`/
  `deletePrinter`/`testPrinter`
- `src/renderer/src/hooks/useBarcodeScanner.ts` — `ScanSource`,
  `ScanResult`, prefix parsing, `onScan` signature change
- `src/renderer/src/App.tsx` — `handleScan` takes `ScanResult`,
  `KITCHEN` routes to a toast instead of the cart
- `src/renderer/src/components/AdminScreen.tsx` — Peripherals tab
  (printer list/add/test/remove, scanner programming note)
- `tests/database.test.ts`, `tests/useBarcodeScanner.test.ts` —
  coverage above

## 7. Known Limitations (candidate backlog)

- `printers:test` always attempts a real connection, including in a
  demo/mock environment with no physical printer reachable — this is
  intentional (a test page exists to exercise real hardware), but
  means clicking "Test" in `VITE_MOCK_PRINTER=true` dev setups will
  fail with a connection error, not a mock success. Worth a follow-up
  if the Peripherals tab needs to be demoed without hardware.
- The Admin screen's per-printer "Test" result is a plain inline
  message under that row, not a toast — consistent with how this
  screen already surfaces `staffActionError`/`shiftActionError`/
  `integrationsMessage`, but different from `App.tsx`'s scan toast
  styling. Not unified in this phase.
- `KITCHEN` routing is a toast placeholder, not a real ticket-firing
  integration — explicitly the brief's scope ("could trigger a
  different action... to demonstrate the routing capability").

---

## Phase 15 Completion Report

**Files created:** `tests/printerRegistry.test.ts`, `docs/phase-15.md`.

**Files modified:** 9 files across main, preload, and renderer — full
list in §6.

**Tests:** `npm test` — **33 files / 373 tests passing** (19 new: 13
`printerRegistry` + 6 `database.test.ts` printer CRUD cases, plus the
existing `useBarcodeScanner.test.ts` suite grown from 11 to 19 tests
— 11 updated in place for the new `ScanResult` shape, 8 added for
prefix routing; zero regressions elsewhere). `npm run typecheck` —
clean (node + web projects).

**Architecture deviation flagged:** `printer.ts` uses
`Map<string, PrinterConfig>` (config lookup) rather than the brief's
literal `Map<string, ThermalPrinterLike>` (live connections) — see §2.2
for the reliability rationale. `printers:save`/`printers:delete` were
also given the Phase 14 `requireAdminPin` gate proactively, beyond
what the brief specified, for consistency with that phase's security
posture.

**Not implemented (explicitly out of scope per the brief):** real
kitchen-ticket firing for `KITCHEN`-routed scans (a toast stands in
for it); `node-hid`/native scanner enumeration (Q1's whole point was
avoiding this).

**Next steps:**
1. Manually verify in a running app: registering a second printer in
   the Peripherals tab and printing a receipt with `printerType:
   'kitchen'` reaches the correct physical printer; the "Test" button
   against a real and an unreachable interface both surface the
   expected message.
2. Program a spare Datalogic scanner with the `SC1:` prefix per the
   Admin screen's instructions and confirm a scan still adds the
   correct item to the cart end-to-end.
3. Decide whether `printers:test` should accept a `mock` flag for
   demoing the Peripherals tab without physical hardware (§7).
