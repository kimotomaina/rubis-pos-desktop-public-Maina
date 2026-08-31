# Phase 36 — Connectivity Monitoring & Status Badges

**Date:** 2026-08-31 · **Branch:** `main` · **Previous:** [Phase 35](./phase-35.md)

## 1. Objective

Add live reachability monitoring for M-Pesa (Daraja sandbox), the
local fiscal device (ZFPLabServer), and the receipt printer, surfaced
as compact status badges next to the existing "Online" indicator, with
a details modal per integration and debounced toast notifications on
state changes. The barcode scanner gets its own badge too, but per the
accepted default (Q2: "assume keyboard-wedge, add a Test Scanner
button") it is never passively probed — there's no reliable way to
detect a USB-HID keyboard-wedge scanner without it actually being
used.

## 2. Main process (`src/main/services/connectivityMonitor.ts`, new)

Mirrors `network.ts`'s conventions (kept free of Electron imports so
it's importable in tests) but differs in one deliberate way: it emits
the **full status set on every check pass**, not just on transition —
a details modal showing live "last checked"/"response time" needs
fresh data even when nothing changed, unlike the binary online/offline
signal `network.ts` reports.

- `createConnectivityMonitor({ checkMpesa, checkFiscal, checkPrinter, emit, intervalMs })` — each checker is injected so production wiring and tests differ only in what they pass in. `start()` runs an immediate check then polls every `intervalMs` (30s default); `checkNow()` coalesces overlapping calls into one in-flight run; `stop()` cancels the timer.
- `checkHttpReachable(url, timeoutMs)` — any HTTP response (even 4xx/5xx) counts as reachable; only a transport-level failure (DNS, refused, timeout) counts as disconnected. Used for M-Pesa and the fiscal device.
- `checkTcpReachable(interfaceString, timeoutMs)` — parses `tcp://host:port` (the existing `VITE_PRINTER_INTERFACE` format, confirmed as a raw unparsed string at `printer.ts:30-32`) and opens/closes a raw socket. Used for the printer.
- `mockedConnectivityResult()` — a zero-I/O "always connected" result for a mocked integration, so a demo/dev environment never fires a real network probe at Safaricom or a nonexistent fiscal device.

Wired in `src/main/index.ts`: `checkMpesa` short-circuits to
`mockedConnectivityResult()` when `mockMpesaEnabled` (from Phase 34),
otherwise probes `https://sandbox.safaricom.co.ke` (Q3's sandbox
default — no production/sandbox toggle exists yet, that's Phase 37's
concern). `checkFiscal` short-circuits when `mockEtimsEnabled`,
otherwise probes `etimsConfig.baseUrl`. `checkPrinter` short-circuits
when `printerSettings.mock`, otherwise probes
`printerSettings.interfaceName`. The monitor starts at app launch and
stops in the existing `will-quit` handler alongside the sync/fiscal
engines.

Two new IPC handlers: `connectivity:get-status` (synchronous read of
the last-known status, for a component mounting after the first check)
and `connectivity:test-all` (forces an immediate check, used by the
modal's "Test Connection" button). A `connectivity:status` broadcast
fires after every check pass.

## 3. Preload / renderer contract

`ConnectivityCheckPayload`/`ConnectivityStatusPayload` added to both
`src/preload/index.ts` and `src/preload/window.d.ts`, duplicated
rather than shared — the established pattern this codebase already
uses for `NetworkStatusPayload`. Three new `window.api` methods:
`getConnectivityStatus`, `testAllConnectivity`, `onConnectivityStatus`
(subscribe, returns an unsubscribe function), mirroring the
network-status trio exactly.

## 4. Renderer

- **`src/renderer/src/stores/connectivityStore.ts`** (new) — a Zustand
  store mirroring `networkStore.ts`'s `init()`-is-idempotent pattern:
  reads the initial status over IPC, then subscribes to broadcasts.
- **`ConnectivityBadges.tsx`** (new) — four compact pill badges (✓/✗
  for M-Pesa/fiscal/printer, ✓/? for the barcode scanner since it has
  no "disconnected" state, only "unknown") with a `title` tooltip and
  an `onSelect` callback, rendered next to the "Online" badge in
  `App.tsx`'s header. Also exports the shared `ConnectivityStatusPayload`
  type (duplicated locally per the preload-layer convention, not
  imported from preload — no renderer component previously imported
  preload types directly, so this keeps that boundary intact).
- **`ConnectivityModal.tsx`** (new) — per-integration details: status,
  last-checked time, latency, error message, and a "Test Connection"
  button (calls `testAllConnectivity` — there's no per-integration test
  channel, so it re-checks everything). For the barcode scanner, the
  button is instead "Test Scanner", which arms the **existing**
  `useBarcodeScanner` hook (already built for real barcode scanning,
  with the exact rapid-keystroke-then-Enter detection Q2 asked for) for
  a 10-second window; a detected scan flips the badge to "Connected"
  for the rest of the session (there is nowhere to persist "a scanner
  exists" outside the renderer, and no need to — it's a one-time
  per-session confirmation, not a live health check).
- **`ConnectivityToast.tsx`** (new) — subscribes to
  `connectivity:status` and shows a toast only when
  `nextToastDebounceState` (below) says a transition is toast-worthy.
  Mirrors `UpdateToast.tsx`'s standalone-component-mounted-in-App
  pattern rather than an imperative `toast.success(...)` call, since no
  unified toast library exists in this codebase.
- **`src/renderer/src/lib/connectivityToasts.ts`** (new) — pure,
  unit-tested debounce logic: `nextToastDebounceState(prev, connected,
  failureThreshold=3)` only fires a "disconnected" toast after 3
  consecutive failures, and a "connected" recovery toast only if a
  disconnected toast was actually shown first (so a blip that never
  crossed the threshold recovers silently instead of announcing a
  reconnection nobody was told about). Idempotent by construction —
  feeding the same `connected` value repeatedly after a toast has
  fired never re-fires one.

## 5. Also fixed in passing (from the prior conversation turn, logged here since Phase 35's report predates it)

- `OrderHistory.tsx`: added an `EtimsLogo` component rendering
  `resources/logos/logo-etims.png` (copied into
  `src/renderer/src/assets/` — Vite's renderer bundle can only import
  assets from within its own project root, not the top-level
  `resources/` directory reserved for electron-builder's
  main-process-only `extraResources`) next to the fiscal QR code, with
  an `onError` fallback to plain "eTIMS" text.
- `App.tsx`: the header's role badge is now hidden whenever it's
  redundant with the staff name (case-insensitive) — fixes the
  seeded default admin account (`name: 'Admin'`, `role: 'admin'`)
  visually reading as "Admin Admin", without removing the role badge
  for any other staff member.

## 6. Testing

- `tests/connectivityMonitor.test.ts` (12 tests) — fake-timer coverage
  mirroring `networkMonitor.test.ts`'s conventions: immediate check on
  start, periodic polling, full-status emission on every pass (not
  just transitions), `stop()` cancelling the timer, `checkNow()`
  coalescing overlapping calls, the "not yet checked" placeholder, and
  `checkHttpReachable`/`checkTcpReachable`'s reachable/unreachable/
  malformed-input paths (the TCP case connects to a real closed local
  port rather than mocking `node:net`, since the wrapper has almost no
  logic of its own to mock around).
- `tests/connectivityToasts.test.ts` (8 tests) — every debounce
  transition: no toast on the first success, no toast below threshold,
  toast exactly at the 3rd consecutive failure, no re-toast on further
  failures, recovery toast only after a disconnected toast fired, no
  duplicate recovery toast, silent recovery from a sub-threshold blip,
  and a custom `failureThreshold`.
- No test added for `connectivityStore.ts` — matches the existing
  precedent that `networkStore.ts` (the pattern it mirrors) has no
  test file either; the store is thin IPC wiring around already-tested
  logic.

## 7. Verification

- `npm test` — 555/555 passing (44 files; +20 from this phase).
- `npx tsc --noEmit` on both `tsconfig.node.json` and
  `tsconfig.web.json` — no new errors (only the pre-existing,
  unrelated cross-project `TS6307` noise confirmed harmless since
  Phase 28).

## 8. Follow-ups

- Q3's sandbox/production M-Pesa environment toggle doesn't exist yet
  — the connectivity check is hardcoded to the sandbox host until
  Phase 37 adds real Daraja configuration.
- The printer/fiscal/M-Pesa "Test Connection" button re-checks *every*
  integration at once (`connectivity:test-all`) rather than just the
  one the user clicked, since there's no per-integration test channel.
  Cheap to add a `connectivity:test-one` handler later if the shared
  re-check ever causes confusing UI (e.g. a M-Pesa retest visibly also
  refreshing the printer badge).
- Barcode "connected" status resets on every app restart by design (no
  persistence) — worth confirming this matches operator expectations
  once this ships to a real till.
