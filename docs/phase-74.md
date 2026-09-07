# Phase 74 — Never-file-twice, Part A: prove and lock the stable invoice number

Part A of the "never file a tax invoice twice" step (see the master
brief and `docs/phase-70.md`'s audit facts). Small and foundational —
Parts B ("read the device before concluding failure") and C (retry
reclassification + manual resend) both depend on `TraderSystemInvNum`
staying identical across every attempt of the same sale.

## 1. Audit (read-only)

`RealFiscalizationProvider.buildTraderSystemInvNum`
(`real-etims-provider.ts:961-967`):

```ts
private buildTraderSystemInvNum(request: FiscalInvoiceRequest): string {
  const raw =
    typeof request.localId === 'number'
      ? `INV-${String(request.localId).padStart(9, '0')}`
      : request.clientOrderUuid.replace(/-/g, '')
  return raw.slice(0, MAX_TRADER_SYSTEM_INV_NUM_LENGTH)
}
```

Confirmed pure: it reads only `request.localId` (preferred) or
`request.clientOrderUuid` (fallback) — both fields already stable per
sale, set once by `runCheckout` when the fiscal request is first built
(`checkout.ts#buildFiscalRequest`) — and computes deterministically, no
counter, no timestamp, no randomness. Called from
`buildOpenInvoiceArgs` (`:939-952`), itself called fresh on every
`submitInvoice` invocation — so nothing caches or increments a value
across calls; it's recomputed from the request every time, and always
lands on the same string for the same `localId`.

Confirmed a queued retry resubmits the **identical stored request**:
`RubisDatabase.queueFiscalInvoice(localId, request)` serializes the
exact `FiscalInvoiceRequest` `runCheckout` built (`localId`/
`clientOrderUuid` included) into `sync_queue.payload_json`.
`fiscal-engine.ts#tick` reads it back via `getPendingFiscalQueue` and
calls `submitInvoice(item.payload)` — the parsed object, unmodified, on
every attempt. Nothing rebuilds `localId`/`clientOrderUuid` per retry;
nothing regenerates the request at all.

**Conclusion: already correct.** No fix needed — the number was already
guaranteed stable across attempts before this step. This matches
`real-etims-provider.ts`'s own class doc comment, which already states
the same intent (`:474-478`).

## 2. Applied

No production code changed — the audit found nothing to fix. Per this
step's own instruction ("If it's already correct, add nothing but the
tests"), only tests were added.

## 3. Tests (`tests/realEtimsProvider.test.ts`)

Two new tests, next to the existing `TraderSystemInvNum` coverage:

- **`produces the SAME TraderSystemInvNum across two submissions of the
  same sale (original + retry)`** — calls `submitInvoice` twice with the
  literal same request object (`localId: 7`), exactly mirroring what
  `fiscal-engine.ts#tick` does with a queued retry's `item.payload`;
  asserts both posted `OpenInvoiceWithFreeCustomerData` calls carry the
  identical `TraderSystemInvNum` (`'INV-000000007'`).
- **`produces DIFFERENT TraderSystemInvNum values for two different
  sales`** — `localId: 7` vs `localId: 8` → different numbers.

Both call the public `submitInvoice` API against a mocked HTTP client
(the existing pattern in this file) rather than reaching into the
private method — `buildTraderSystemInvNum` has no separate exported
surface, and shouldn't need one for this.

## 4. Verification

- `npx vitest run`: **58 files / 872 tests** (850 baseline going into
  phase-73 + 20 phase-73 `runCheckout.test.ts` tests + 2 new here),
  0 failures.
- `npm run typecheck` (node + web): clean.

## VERIFY-ON-DEVICE

None introduced — this part only adds tests against the existing,
already-correct pure function.

---

**STOP for review**, per this step's brief — Part B (detect an
already-filed sale) does not start until reviewed.
