# Phase 122 — Change 1 audit: a LIVE / DRY-RUN fiscal switch

**Date:** 2026-09-23 · **Branch:** `staging` · **Base:** `8871592` (tree clean) · **Status:** audit only, nothing changed

The question the brief asked: *can the mock provider be selected at runtime
by an admin flag in a packaged build?* **No. And the mock ZFP server is not a
workable substitute on the partner's machine either.** §4 proposes a smaller
dry-run that needs neither.

---

## 1. How the fiscal provider is chosen today

[fiscal-provider-factory.ts](../src/main/services/fiscal-provider-factory.ts)
`resolveFiscalizationProvider`, called **once at boot** from
[index.ts:671](../src/main/index.ts#L671):

| Input | Packaged exe | Dev (`npm run dev`) |
| --- | --- | --- |
| `mock_etims_enabled` / `VITE_USE_MOCK_ETIMS` unset or false | Real | Real |
| mock requested | **Real**, plus a warning | Mock, via a dynamic import |

The fence has three layers:

1. `isPackaged === true` makes the factory return the real provider whatever
   the config says.
2. The mock is reachable only through `import.meta.env.DEV && await import(...)`,
   so Rollup leaves `mock-etims-provider.ts` out of the production bundle
   completely.
3. [verify-no-mock-provider.cjs](../scripts/verify-no-mock-provider.cjs) runs
   as `postbuild` and fails the build if `KRA-MOCK-`, `MockFiscalizationProvider`
   or `MockMpesaProvider` shows up anywhere in `out/main`.

**So the mock provider is not in the exe.** An admin flag has nothing to
select. Shipping it would mean undoing layers 2 and 3.

## 2. Pointing the real provider at the mock SERVER: not workable for the POC

This is the brief's suggested fallback. [mock-zfplab-server/](../mock-zfplab-server/)
is a fake of the vendor bridge. It fails on the partner's machine for four
separate reasons, and any one of them would rule it out:

| # | Problem | Evidence |
| --- | --- | --- |
| 1 | **It is not shipped.** It runs with `vite-node` from the repo, and serves its XML from `tests/fixtures/wire/`. The installer only packages `out/**`, `package.json` and `node_modules`. | `package.json` `mock:zfplab`; `electron-builder.yml` `files:` |
| 2 | **It uses the same port as the real ZFPLabServer.** Both listen on `4444`. With the real bridge installed and running for the live sales, the mock cannot bind, unless someone stops the vendor service or picks a different port and repoints the till. | `DEFAULT_MOCK_PORT = 4444` |
| 3 | **Its invoice number looks real.** `CloseReceipt` returns `InvoiceNum="0000000000000000042"`, which is 19 digits in exactly the real format. Only the QR carries the `MOCK-QR-` prefix. A receipt that prints just the number could not be told apart from a real one. | `closereceipt-ok.xml` |
| 4 | **Every sale gets the same number, `…042`.** The provider's `lookupInvoice` recovery reads `getOrderByFiscalInvoiceNumber`. With several dry-run orders sharing one number, a duplicate-recovery lookup could return the wrong sale. | `index.ts:683`, `database.ts:1392` |

There is also a **Rule-2 inversion hazard** built into the idea. The mode flag
and the server URL would be two separate settings. If someone sets `dry-run`
but leaves the URL on the real bridge, the till files a **real KRA invoice** and
labels it `fiscal_mode='dry-run'`. That real filing is then left out of the
unfiled count and the needs-attention list. The reverse mistake, `live`
pointed at the mock, prints a fake invoice as if it were real. Both are silent.

## 3. What the rest of the system does with a sale that is never fiscalized

These answers are what make the proposal in §4 small:

- **`fiscal_status` can be NULL.** The column has a `CHECK` for `'fiscalized'
  | 'waiting' | 'needs_fixing'` ([database.ts:379](../src/main/services/database.ts#L379)),
  and NULL already means *never attempted*. Adding a fourth value would mean
  rebuilding the `orders` table. A separate `fiscal_mode` column, added the
  same way the other `orders` columns were ([database.ts:333-341](../src/main/services/database.ts#L333-L341)),
  avoids that.
- **Unfiled count:** `getUnfiledOrderCount` counts only `waiting` and
  `needs_fixing` ([database.ts:1571](../src/main/services/database.ts#L1571)).
  **Needs attention:** lists only `needs_fixing`, plus `waiting` sales older
  than the threshold ([database.ts:1556](../src/main/services/database.ts#L1556)).
  A NULL-status sale is excluded from both **without touching either query**.
- **Resend cannot file it later.** `resendFiscalization` refuses a sale that
  has no `fiscal_request_json` ([fiscal-retry.ts:154](../src/main/services/fiscal-retry.ts#L154)).
  If dry-run never stores a request, a dry-run sale can never be turned into a
  real filing by mistake, through the fiscal engine or a manual resend.
- **Thermal receipt:** the fiscal block prints only when an invoice number or
  QR code is present ([printer.ts:258](../src/main/services/printer.ts#L258)).
  A dry-run sale has neither, so no fiscal block can print. The TEST banner
  would be a new line keyed on `fiscal_mode`.
- **Toast:** a sale shows *"tax receipt issued"* only when the status is
  `'fiscalized'` ([saleCompleteToast.ts:26](../src/renderer/src/lib/saleCompleteToast.ts#L26)),
  so a dry-run sale already reads plain *"Sale complete."*.
- **Header badge:** `ConnectivityBadges` has no concept of a mode. A DRY RUN
  pill would be new.
- **Mode switching:** per-sale reads are cheap (`db.getSetting`). Reading the
  mode inside the checkout handler for each sale means **no restart and no
  reconfigure path is needed.** That is simpler than the brief's
  *reuse reconfigure* suggestion, and it takes effect on the next sale.

## 4. Proposal: dry-run means *do not fiscalize, and say so loudly*

Dry-run does not talk to any fiscal server, real or mock. The sale completes
as normal. The only differences are that the fiscal block is skipped and
the sale is permanently marked.

```
runCheckout(deps, input)
  … payment gate, queueOrder — UNCHANGED …
  if (deps.fiscalMode === 'dry-run') {
    db.setOrderFiscalMode(localId, 'dry-run')   // fiscal_status stays NULL, no request stored
    return { success: true, data: { …, fiscalMode: 'dry-run' } }
  }
  … existing fiscal block — UNCHANGED …
```

**Why this is the smallest safe option:**

- **No mock in the exe.** `verify-no-mock-provider.cjs` and the factory are
  not touched. The "mock can't ship" guard stays exactly as strong as it is.
- **No inversion hazard.** A dry-run sale **cannot reach a device at all**,
  whatever the URL setting says. So there is no configuration in which a
  "dry-run" label sits on a real filing.
- **The fiscal engine is untouched.** `fiscal-engine.ts`, `fiscal-retry.ts`,
  `fiscal-routing.ts` and the real provider are not edited. The fiscal engine
  tests should pass unmodified.
- **Rule 3 holds.** A dry-run sale is not a lost unfiled sale. It is a sale
  that was never meant to file, and it is recorded as such.
- **Default live, fail-safe.** `fiscalMode` is read as `'dry-run'` **only**
  when the stored value is exactly `'dry-run'`. A missing, blank or garbled
  value means live. It is PIN-gated to change, like the other Admin settings
  (`requireAdminPin`).

**The one thing it does not prove:** that a device accepts an invoice. That
is proven by **Test Connection and ReadStatus**, which already pass, and then
by the first live 1-KSh sale. So POC plan **step 1 changes**: a dry-run sale
shows the TEST banner and **no invoice number**, not a synthetic one.
Getting a synthetic number would mean minting fiscal-looking identifiers
in the shipped exe, which is the exact thing phase-90 removed.

**Files it would touch:** `checkout.ts` (one early branch, and one optional
dep, so the tripwire's `makeDeps` still typechecks), `database.ts` (the
`fiscal_mode` column, `setOrderFiscalMode`, and the field on `OrderRow` and
`CheckoutReceipt`), `index.ts` (the per-sale setting read, and one PIN-gated
`settings:set-fiscal-mode` handler), `ipcValidator.ts`, `printer.ts` (the
TEST banner), preload, `AdminScreen.tsx` (the toggle),
`ConnectivityBadges.tsx` or `App.tsx` (the DRY RUN pill), and one new test file.

### Rejected alternative: ship a marked dry-run provider

A `DryRunFiscalizationProvider` compiled into the exe, returning
`TEST-NOT-FILED-…` numbers, would print a fiscal-style block. This is a
deliberate, visible exception to the phase-90 guard, and it needs the guard
to allow-list it. It adds more code, puts synthetic invoice identifiers back
into production, and proves nothing more than §4 does. **Not recommended**
unless you specifically want the fiscal block's layout on paper before the
first live sale.

## 5. Decisions needed before BUILD

1. **Approve §4 (skip-fiscalization dry-run)** rather than the mock server or
   a shipped dry-run provider.
2. **Shopify sync of dry-run sales.** Today every sale, dry-run included,
   would push a real Shopify order and decrement stock. Options:
   - (a) sync normally (simplest, and the 1-KSh test sale shows up in
     Shopify);
   - (b) skip sync for dry-run sales, which touches the order-queue path.

   **Recommended: (a).** It is the least code on the sale path, and CSV and
   Order History carry `fiscal_mode` so the test sale can be identified.

## 6. Observed but not changed

- **The PDF receipt fallback prints no fiscal block at all.**
  [pdf-receipt.ts](../src/main/services/pdf-receipt.ts) has no fiscal fields.
  If the thermal printer is unreachable, a **real** fiscalized sale's fallback
  PDF has no invoice number or QR. Goes into GO_LIVE_GAPS.
- **A live till can already be pointed at the mock server by URL**, with
  nothing marking it. This is the §2 reverse hazard, and it exists today. It
  is low risk on the partner's machine because the mock is not installed
  there.
- **Boot logging includes `[DEBUG-ETIMS]` lines unconditionally**
  ([index.ts:592](../src/main/index.ts#L592), [:724](../src/main/index.ts#L724)).
  They are not gated by `fiscalDebugLogging`. The password is masked, so this
  is harmless noise.
