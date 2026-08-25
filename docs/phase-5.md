# Phase 5 — Hardware Integration (Receipt Printing & Barcode Scanner)

**Date:** 2026-08-24 · **Branch:** `main` · **Previous:** [Phase 4](./phase-4.md)

## 1. Objective

Give the POS its remaining store-floor hardware: an ESC/POS thermal
printer for customer receipts (with retry/reprint from Order History),
and a barcode scanner experience that adds a scanned variant straight
to the cart without a focused input field.

## 2. Decisions

| # | Decision | Value |
| --- | --- | --- |
| Q1 | Printer library | `node-thermal-printer@4.6.1` |
| Q2 | Scanner vs. manual typing | Time-delta buffering: consecutive keystrokes ≤50ms apart accumulate; any larger gap resets the buffer. Enter flushes the buffer as a scan if it's ≥3 characters. |
| Q3 | Missing/offline printer | `VITE_MOCK_PRINTER=true` skips hardware and logs the formatted receipt to the console with a success result |
| Receipt fields without a data model | Cashier name / tax rate / payment method are not tracked anywhere pre-Phase-5 (no auth, no tax calc, no payment-method capture). Sourced from static env vars (`VITE_CASHIER_NAME`, `VITE_TAX_RATE`) with `paymentMethod` hardcoded to `"Card"` — no changes to the checkout data model. |
| Printer interface | **TCP/IP** (`tcp://<ip>:9100`), not a named Windows printer share. `node-thermal-printer`'s `printer:<name>` interface throws unless a `driver` object is supplied — in practice the native `printer` addon, which would add a second fragile native build alongside `better-sqlite3`. TCP/IP needs no native dependency. |
| Barcode matching | Added `barcode` end-to-end (Shopify GraphQL field → `ShopifyVariant`/`VariantSummary` → SQLite `products.barcode` cache column) so a scanned code resolves to an exact, already-known variant — matching skips the variant modal entirely, since the scan already disambiguates which variant was sold. |

## 3. Receipt Printer Service

`src/main/services/printer.ts` wraps `node-thermal-printer` behind a
narrow injectable interface, `ThermalPrinterLike` (`isPrinterConnected`,
`alignCenter`/`alignLeft`, `bold`, `println`, `drawLine`, `cut`,
`execute`) — the same dependency-injection pattern used by the Shopify
axios client and the SQLite connection elsewhere in this codebase, so
`tests/printer.test.ts` asserts the exact ESC/POS call sequence with a
recording fake and never touches real hardware or a real socket.

`renderReceipt(client, order, items, settings)` issues the formatting
calls; `printReceipt(order, items, settings, factory?)` wraps it with
connectivity checking, mock-mode branching, and error translation, and
returns a `ServiceResult<{ printed: boolean; mock: boolean }>`.

**Layout:**

```
        RUBIS            ← centered, bold
      Order #42
  8/24/2026, 1:00:00 PM
    Cashier: Alex
--------------------------------
RUBIS Mug (Small) x2
  $25.00
RUBIS T-Shirt x1
  $19.99
--------------------------------
Subtotal: $44.99
Tax: $3.60
    Total: $48.59         ← bold
   Payment: Card
      Thank you!           ← centered
```

**Mock mode** (`settings.mock === true`): the factory is never called;
an in-memory sink records the same `println`/`drawLine` calls and the
joined text is logged as `[rubis-pos] MOCK PRINT — Order #<id>`, so the
exact receipt a real printer would produce is visible in the console.

**Error handling**: `isPrinterConnected()` returning `false` → "Printer
offline or unreachable"; `ECONNREFUSED`/`EHOSTUNREACH` → network
message; `ETIMEDOUT` → timeout message; any error message containing
"paper" → paper message; everything else → generic `Printer error — …`.
None of these throw past the service boundary — `receipt:print` always
resolves a `ServiceResult`.

## 4. Barcode Field (Shopify → Cache → Renderer)

The scanner can only resolve a scanned code to a product if a real
barcode is available to match against, so this phase threads
`barcode` through every layer that previously omitted it:

| Layer | Change |
| --- | --- |
| `PRODUCT_LIST_QUERY` (`shopify.ts`) | added `barcode` to the `variants` selection |
| `ShopifyVariant` (`shopify-types.ts`) | `barcode: string \| null` |
| `mapVariant` (`shopify.ts`) | passes `variant.barcode ?? null` through to `VariantSummary` |
| `VariantSummary` (renderer `types/shopify.ts`) | `barcode: string \| null` |
| `products` table (`database.ts`) | new `barcode TEXT` column; `cacheProducts`/`getCachedProducts` read/write it |

Offline-cached catalogs therefore keep scanning working even without a
live Shopify fetch.

## 5. Barcode Scanner Hook

`src/renderer/src/hooks/useBarcodeScanner.ts` listens on `window`
(not a specific input), so scanning works regardless of what has
focus. Detection is pure keystroke timing:

- Each character key resets the buffer if the previous keystroke was
  more than `maxIntervalMs` (default **50ms**) ago, otherwise appends.
- `Enter` flushes the buffer; if it's at least `minLength` (default
  **3**) characters, `onScan(barcode)` fires.

A human typist's naturally slower, irregular pace keeps resetting the
buffer, so by the time they press Enter only the last word or two is
buffered — almost always too short, and never confused for a scan. A
scanner's characters arrive as one uninterrupted fast burst, so the
whole code survives to the Enter flush.

`App.tsx` wires the hook (`enabled` only while `activeView ===
'catalog'`) to look up the scanned code across every product's
variants; on a match it's added straight to the cart (no modal — the
barcode already identifies the exact variant) and a green toast
("Added: …") appears for 2.5s; on no match, a red "Barcode not
recognized: …" toast appears instead.

## 6. IPC Contract (Phase 5 additions)

| Channel | Direction | Payload |
| --- | --- | --- |
| `receipt:print` | invoke | `localId: number` → `ServiceResult<{ printed: boolean; mock: boolean }>` |

The handler reads the order via `db.getOrder(localId)`, parses its
stored `payload_json` (`OfflineOrderPayload`), and maps `lineItems`
into `ReceiptLineItem[]` — no renderer-side `CartItem[]` is needed
since a local order's line items are already durable. `OfflineOrderLine`
gained a `variantTitle` field (populated in `queueOrder`) purely so
reprints show the correct variant, not just the product title.

## 7. UI Integration

- **OrderHistory** — every order row (regardless of sync status) now
  has a "Print Receipt" button next to its status badge and the
  existing "Retry Sync" button.
- **App.tsx** — a shared `scanToast` banner (bottom-center, 2.5s
  auto-dismiss) reports both barcode-scan outcomes and print outcomes
  ("Receipt sent to printer" / "Receipt printed (mock mode)" / error).

## 8. Files Created / Modified

| File | Action | Purpose |
| --- | --- | --- |
| `src/main/services/printer.ts` | Create | `renderReceipt`, `printReceipt`, `ThermalPrinterLike`/`PrinterFactory` DI, error translation |
| `src/main/services/shopify-types.ts` | Modify | `ShopifyVariant.barcode`, `OfflineOrderLine.variantTitle` |
| `src/main/services/shopify.ts` | Modify | `barcode` in `PRODUCT_LIST_QUERY` + `mapVariant` |
| `src/main/services/database.ts` | Modify | `products.barcode` column, `cacheProducts`/`getCachedProducts` updated, `queueOrder` populates `variantTitle` |
| `src/main/index.ts` | Modify | `printerSettings` resolution, `receipt:print` IPC handler |
| `src/preload/index.ts` + `window.d.ts` | Modify | `printReceipt(localId)` |
| `src/renderer/src/types/shopify.ts` | Modify | `VariantSummary.barcode` |
| `src/renderer/src/hooks/useBarcodeScanner.ts` | Create | timing-based scan detection hook |
| `src/renderer/src/components/OrderHistory.tsx` | Modify | `onPrint` prop, "Print Receipt" button |
| `src/renderer/src/App.tsx` | Modify | scanner wiring, `scanToast` banner, `handlePrintReceipt` |
| `package.json` | Modify | `node-thermal-printer` dependency |
| `.env.example` | Modify | `VITE_SHOPIFY_LOCATION_ID`, `VITE_MOCK_PRINTER`, `VITE_PRINTER_INTERFACE`, `VITE_STORE_NAME`, `VITE_CASHIER_NAME`, `VITE_TAX_RATE` |
| `tests/printer.test.ts` | Create | 8 tests |
| `tests/useBarcodeScanner.test.ts` | Create | 8 tests |
| `tests/setup.ts` | Modify | `IS_REACT_ACT_ENVIRONMENT = true` for the scanner hook's real-DOM mount |
| `tests/database.test.ts`, `tests/orders.test.ts`, `tests/syncEngine.test.ts`, `tests/pagination.test.ts`, `tests/shopifyService.test.ts`, `tests/productStore.test.ts` | Modify | fixture updates for the new `barcode`/`variantTitle` fields |
| `docs/phase-5.md` | Create | this document |

## 9. Testing Strategy

Same rule as every prior phase: mock the native/hardware boundary,
never touch it for real. `node-thermal-printer` is never imported by
name in a test — `printReceipt`'s `factory` parameter is swapped for a
recording fake. The scanner hook is mounted with `react-dom/client`
directly (no new `@testing-library` dependency) and driven with real
`KeyboardEvent`s on `window`, with Vitest's fake timers controlling
`Date.now()` so keystroke deltas are deterministic.

```bash
npm test           # vitest run — 13 files / 121 tests
npm run typecheck  # tsc --noEmit (node + web) — clean
```

| Suite | Coverage highlights |
| --- | --- |
| `printer.test.ts` (8) | exact ESC/POS call sequence (header/items/totals/footer), bold only on store name + total, successful send, offline detection, `ECONNREFUSED` and "out of paper" error translation, mock mode never calls the factory, mock mode logs the formatted receipt |
| `useBarcodeScanner.test.ts` (8) | fast keystrokes + Enter → scan, slow typing → ignored, too-short fast sequence → ignored, a slow prefix + fast suffix → only the suffix counts, custom `maxIntervalMs`/`minLength`, `enabled: false` → no-op, cleanup on unmount, exported timing constants |

## 10. Known Limitations (candidate backlog)

- **No real hardware validated** — TCP/IP send/error paths are unit
  tested via DI; an actual X-POS printer over Ethernet/USB-to-network
  adapter hasn't been exercised end-to-end. Set `VITE_PRINTER_INTERFACE`
  to the printer's IP and `VITE_MOCK_PRINTER=false` to test for real.
- **No Windows-printer-share support** — `printer:<name>` needs the
  native `printer` driver module, deliberately deferred (see §2) to
  avoid a second fragile native build.
- **Static receipt fields** — cashier name and payment method are
  fixed via env/hardcode, not captured per-sale; tax is a flat rate,
  not itemized/location-aware. Revisit once the POS has real
  auth/session and a payment-method selector.
- **Scanner focus scope** — `useBarcodeScanner` is only enabled on the
  Catalog view; scanning while on Order History does nothing (by
  design — there's nothing to add to a cart there).

---

*Phase 5 status: implementation complete — `npm test` (121/121) and
`npm run typecheck` both pass.*
