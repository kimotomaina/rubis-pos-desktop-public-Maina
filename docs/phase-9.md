# Phase 9 — Gap Analysis, Integration Architecture, and Placeholder Implementation

**Date:** 2026-08-25 · **Branch:** `main` · **Previous:** [Phase 8](./phase-8.md)

## 1. Objective

Step back from feature-by-feature building and check RUBIS POS against a
real POS benchmark (Shopify POS), scope the two Kenya-specific
integrations the 1-week trial ultimately needs — M-Pesa and eTIMS — and
land the architectural placeholders for both so Phase 10 can wire in
real HTTP calls without touching the checkout flow's shape.

## 2. Task 1 — Gap Analysis vs. Shopify POS

Compared against Shopify POS's feature set (Omnichannel, Inventory,
Staff, Checkout, Products, Customers, Reporting, Hardware, Marketing),
scoped to what a single-till RUBIS store trial actually needs.

### POC Critical — must have for the 1-week trial

| Feature | Why it's critical | Status |
| --- | --- | --- |
| Returns / Voids | A cashier *will* ring a wrong item or a customer *will* return something within the first hour. No workaround exists today — the only escape is closing the till and reopening it, which corrupts the Z-report. | **Missing** — Phase 10 scope |
| M-Pesa payment (STK Push + manual code) | M-Pesa is the dominant payment rail in Kenyan retail; cash-only is not a realistic trial. | **Placeholder landed this phase** (§3); UI is Phase 10 |
| Line-item / order discounts | Manager overrides, damaged-goods markdowns, and loyalty comps are routine at a physical till. | **Missing** — Phase 10 scope |
| Manual/PLU price override | Not every item has a clean barcode on day one of a new integration. | **Missing** — Phase 10 scope |
| Cash drawer reconciliation | **Already shipped** — Phase 7 shift open/close + Z-report (`shifts:*`, `reports:z-report`). | Done |
| Offline sale + deferred sync | **Already shipped** — Phase 3 (`sync_queue`, `sync-engine.ts`). | Done |
| Receipt printing | **Already shipped** — Phase 5 (`printer.ts`). | Done |

### Post-POC Essential — needed before a permanent rollout, not before the trial

| Feature | Why it can wait a week | Notes |
| --- | --- | --- |
| Customer profiles / lookup | Trial can run as pure walk-in retail; loyalty tracking isn't the thing being validated. | Would hang off Shopify's `customers` API, same client already in use |
| Digital receipts (SMS/email) | Printed receipt is table stakes; digital is a nice-to-have once volume proves the printer path is stable. | |
| Low-stock alerts | One week of data isn't enough signal to act on. | Cached inventory already visible per-item |
| eTIMS live fiscalization | KRA compliance matters for permanent operation, not a bounded internal trial — but the plumbing should exist so it's not a rewrite later. | **Placeholder landed this phase** (§3) |
| Multi-till / multi-till sync | Trial is explicitly single-till. | Schema already allows it (shifts are store-wide, not per-device) — no redesign needed later |
| Barcode label printing | Existing barcodes on stock are sufficient for a bounded trial. | |

### Enterprise / Nice-to-have — out of scope for RUBIS entirely at this stage

- Omnichannel order routing / BOPIS / shipping
- AI demand forecasting
- Staff commission tracking
- Multi-location transfer workflows
- Marketing/email campaign tools
- Third-party app marketplace equivalents

## 3. Task 2 — Integration Architecture (M-Pesa & eTIMS)

Both integrations are designed around the same constraint that shaped
Phase 3's Shopify sync: **a KRA or Safaricom outage must never block a
sale.** The till always finishes the transaction locally first; network
calls are either fire-and-forget-with-retry or an explicit, bounded
step the cashier can complete offline.

### 3.1 M-Pesa — hybrid STK Push / manual entry flow

```
┌─────────────┐     online?     ┌───────────────────┐
│  Cashier     │ ───── yes ────▶ │ STK Push (Daraja)  │
│  selects     │                 │ - push prompt to   │
│  M-Pesa      │                 │   customer's phone │
└─────┬────────┘                 │ - poll/callback for │
      │                          │   confirmation      │
      │ no / prompt fails/       └─────────┬───────────┘
      │ times out                          │ success
      ▼                                    ▼
┌────────────────────┐            ┌──────────────────┐
│ Manual code entry   │ ────────▶ │ verifyTransaction  │
│ - cashier reads SMS │            │ Code() — checked   │
│   confirmation code │            │ before order is    │
│   off customer phone│            │ persisted           │
└────────────────────┘            └──────────────────┘
```

- **Online path (STK Push):** `MpesaProvider.initiateStkPush()` pushes a
  prompt to the customer's phone via Daraja. Requires connectivity to
  Safaricom, so it's only attempted when the till is online.
- **Offline-capable path (manual entry):** the customer already has an
  SMS confirmation with a transaction code (M-Pesa itself worked over
  the cellular network even if the *till's* internet is down — this is
  the actual RUBIS store failure mode: shop Wi-Fi drops, phone signal
  doesn't). The cashier reads the code into the till,
  `verifyTransactionCode()` checks it, and — because verification is a
  local/mock lookup for now, becoming a queued reconciliation check
  against Safaricom's transaction log in a real implementation — the
  sale can complete without a live Daraja round trip.
- **Wired into checkout today:** `orders:checkout` (`index.ts`) calls
  `verifyTransactionCode()` before persisting the order whenever
  `paymentMethod === 'mpesa'` and a `referenceNumber` was supplied —
  an order is never recorded against an unverified code. STK Push and
  a standalone verify-before-committing check are also exposed as their
  own IPC channels (`integrations:mpesa-stk-push`,
  `integrations:mpesa-verify-code`) for the Phase 10 payment modal
  described in §5.

### 3.2 eTIMS — store-and-forward middleware

```
Checkout completes (order persisted, cash/stock committed)
                │
                ▼
     FiscalizationProvider.submitInvoice()
                │
      ┌─────────┴─────────┐
      │ online + KRA up?   │
      └─────────┬─────────┘
        yes ▼         ▼ no / timeout / KRA down
  ┌────────────────┐  ┌─────────────────────────┐
  │ Real KRA invoice │  │ Local provisional invoice │
  │ number + QR      │  │ number; queued for retry  │
  │ returned          │  │ (same backoff pattern as  │
  │                    │  │ Shopify's sync_queue)      │
  └────────────────┘  └─────────────────────────┘
                │                    │
                └────────┬───────────┘
                          ▼
              Attached to receipt as `fiscal`
              (invoice number + QR) if available;
              omitted, not blocking, if not
```

- Every sale is fiscalized **after** the cash/stock side is already
  committed — mirroring exactly how Phase 3 treats the Shopify
  `orderCreate` push: the sale is real the moment it's in `orders`,
  sync is a best-effort follow-up, not a gate.
- A real implementation queues unsent invoices the same way
  `sync_queue` already queues unsent Shopify orders (entity type,
  payload, attempt count, backoff) rather than adding a second queueing
  mechanism — Phase 10/11 scope.
- The QR code is the KRA-mandated proof-of-fiscalization printed on the
  receipt. **Q1 resolution:** the *wire contract* (`FiscalInvoiceResult
  .qrCode`) is a base64 string per the phase brief, matching what a real
  `qrcode`-generated PNG/SVG would look like on the wire; the *mock's*
  implementation is intentionally trivial — `base64(text placeholder)`
  — so the receipt template can render `<img src="data:image/png;base64,...">`
  today and swap in real QR bytes later without changing the interface
  or the renderer code that consumes it.

## 4. Task 3 — Code Implementation (Plug-and-Play Placeholders)

| File | Purpose |
| --- | --- |
| `src/main/services/integrations/mpesa.ts` | `MpesaProvider` interface, `MockMpesaProvider` (2 s simulated Daraja latency) |
| `src/main/services/integrations/etims.ts` | `FiscalizationProvider` interface, `MockFiscalizationProvider` (1 s simulated middleware latency) |
| `src/main/services/database.ts` | New `integrations` table + `getIntegrationConfig`/`setIntegrationConfig` (Q3) |
| `src/main/index.ts` | Instantiates both mock providers, gates them behind `VITE_USE_MOCK_INTEGRATIONS`, wires verification into `orders:checkout`, adds `integrations:mpesa-stk-push` / `integrations:mpesa-verify-code` IPC channels |
| `src/preload/index.ts`, `window.d.ts` | Exposes `initiateMpesaStkPush` / `verifyMpesaCode` to the renderer |
| `.env.example` | Documents `VITE_USE_MOCK_INTEGRATIONS` |

No real Daraja or KRA HTTP calls exist yet — both providers are pure
in-memory mocks, matching the brief's Task 3 constraint. **No HTTP
client, endpoint URL, or credential handling for either API was
written**, deliberately, so nothing here can be mistaken for a real
integration.

### Clarification defaults applied

- **Q1 (QR code mock shape):** wire contract is base64 (see §3.2); the
  mock's *content* is the placeholder text `[QR CODE]:<invoice-number>`
  base64-encoded — visibly a placeholder if ever inspected, but shaped
  exactly like the real thing will be.
- **Q2 (M-Pesa manual entry UI):** confirmed as a sub-option of one
  M-Pesa button/modal — not built this phase (no UI work was in scope),
  but the two IPC channels landed this phase are exactly the two calls
  that modal's two tabs ("STK Push" / "Manual Code Entry") will need.
- **Q3 (integration config storage):** a dedicated `integrations` table
  (`provider TEXT PRIMARY KEY, config_json TEXT`) rather than the
  generic `settings` key-value store, so a provider's Paybill/Till/URL
  fields stay grouped. Not yet populated by any UI — Phase 10 (or
  whichever phase builds the Admin "Integrations" panel) will call
  `setIntegrationConfig()`.

## 5. Task 4 — Phase 10 Roadmap Proposal

Scoped strictly to what makes the RUBIS trial *flawless*, drawn directly
from the POC Critical row in §2:

1. **Returns / Voids flow** — a new `orders:refund` (or `orders:void`)
   IPC handler, a `refunds` table (or a `status: 'refunded'` extension
   to `orders`), and a till-screen action to select a past order and
   reverse it. Must feed back into the Z-report's cash reconciliation
   math (`closeShift` in `database.ts` currently sums `payment_method
   = 'cash'` orders unconditionally — refunds need to net out).
2. **M-Pesa payment UI** — the two-tab modal from Q2, wired to the two
   IPC channels already shipped this phase
   (`initiateMpesaStkPush`/`verifyMpesaCode`), replacing today's
   free-text `referenceNumber` field on the checkout screen.
3. **Discounts** — a percentage/fixed-amount field at the line-item and
   cart level, PIN-gated for non-trivial amounts (reuses the existing
   staff role/PIN model from Phase 6).
4. **Manual price override** — PIN-gated per-line price edit for items
   without a clean barcode, same gating pattern as discounts.
5. **Integrations config UI** — a minimal Admin-screen panel to call
   `setIntegrationConfig('mpesa', {...})` / `setIntegrationConfig('etims',
   {...})` so Paybill/Till/middleware-URL don't have to be edited via
   raw SQL once real backends land.

Explicitly **not** in Phase 10: real Daraja/eTIMS HTTP clients. Getting
the trial's UX right with the mocks in place is higher-value than
building against live KRA/Safaricom endpoints under trial time pressure
— that's Phase 11+, once credentials and a KRA test environment are
available.

## 6. Testing Strategy

Same convention as every prior phase: the mock providers *are* the
integration boundary for this phase (there is no real HTTP client to
inject a fake in place of yet), so tests exercise them directly rather
than mocking axios.

- `tests/mpesa.test.ts` (6 tests) — STK Push success path, invalid
  phone-number rejection, the `0000`-suffix cancelled-prompt sentinel,
  manual-code verification success, empty-code rejection, and the
  `INVALID` sentinel's "verified: false" (not a service failure) shape.
- `tests/etims.test.ts` (7 tests) — invoice submission returns a
  `KRA-MOCK-` prefixed number and a decodable base64 QR placeholder,
  rejection of empty line items / missing `clientOrderUuid`,
  `getInvoiceDetails` read-back (including the not-found case), and
  `cancelInvoice` removing an invoice so it can no longer be read back.
- `tests/database.test.ts` (+3 tests) — `SCHEMA.integrations` is
  created on `init()`, `setIntegrationConfig` upserts JSON via the
  expected SQL/params, `getIntegrationConfig` parses a stored row and
  returns `{}` when unconfigured.

```bash
npm test           # vitest run — 22 files / 207 tests
npm run typecheck  # tsc --noEmit (node + web) — clean
```

## 7. Known Limitations (candidate backlog)

- **No real Daraja/eTIMS HTTP clients** — by design this phase; both
  providers are in-memory mocks with simulated latency only.
- **No renderer UI for M-Pesa manual entry / STK Push** — the checkout
  screen still uses a free-text reference-number field; the IPC
  channels are ready but nothing calls them from React yet.
- **`integrations` table has no writer UI** — `setIntegrationConfig`
  exists but nothing calls it outside tests; Paybill/Till/middleware
  URLs aren't configurable from the Admin screen yet.
- **Fiscalization runs on every checkout when the flag is on, with no
  UI feedback** — the `fiscal` field is returned on `CheckoutReceipt`
  but no screen renders it yet (no QR on the printed receipt either —
  `printer.ts`'s `renderReceipt` wasn't touched this phase).
- **eTIMS store-and-forward queueing is not implemented** — the mock
  always "succeeds" instantly; a real store-and-forward retry queue
  (mirroring `sync_queue`) is Phase 10/11 scope per §3.2.

---

## Phase 9 Completion Report

**Files created:**
- `src/main/services/integrations/mpesa.ts`
- `src/main/services/integrations/etims.ts`
- `tests/mpesa.test.ts`
- `tests/etims.test.ts`
- `docs/phase-9.md`

**Files modified:**
- `src/main/services/database.ts` — `integrations` table (`SCHEMA.integrations`), `IntegrationProviderName` type, `getIntegrationConfig`/`setIntegrationConfig` methods, `CheckoutReceipt.fiscal` field
- `src/main/index.ts` — provider instantiation gated by `VITE_USE_MOCK_INTEGRATIONS`, M-Pesa verification hook in `orders:checkout`, eTIMS fiscalization hook in `orders:checkout`, two new IPC handlers (`integrations:mpesa-stk-push`, `integrations:mpesa-verify-code`)
- `src/preload/index.ts`, `src/preload/window.d.ts` — `initiateMpesaStkPush`, `verifyMpesaCode`
- `.env.example` — `VITE_USE_MOCK_INTEGRATIONS`
- `tests/database.test.ts` — schema + config get/set coverage

**Tests:** `npm test` — **22 files / 207 tests passing** (25 new: 6
mpesa + 7 etims + 3 database + existing suite unaffected).
`npm run typecheck` — clean (node + web projects).

**Next steps:** Phase 10, scoped in §5 — Returns/Voids, the M-Pesa
payment modal UI wired to this phase's IPC channels, discounts, manual
price override, and a minimal Integrations config panel in Admin. No
real Daraja/eTIMS HTTP work until credentials and a KRA test
environment exist (Phase 11+).
