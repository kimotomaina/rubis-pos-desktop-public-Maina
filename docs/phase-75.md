# Phase 75 — Never-file-twice, Part B: detect an already-filed sale without guessing error codes

Part B of the "never file a tax invoice twice" step, building on
`docs/phase-74.md`'s Part A (the invoice number is already stable across
attempts — confirmed, not touched here). This is the core Rule 1
guarantee: when a retry/resend's `OpenInvoiceWithFreeCustomerData` is
rejected, the device is asked what it actually has on file — via
`ReadCUinvoiceNumber` — before concluding the sale was never filed.

## 1. Audit (read-only)

- **Where a retry/resend re-attempts `OpenInvoiceWithFreeCustomerData`**:
  a single call site, `RealFiscalizationProvider.submitInvoice`
  (`real-etims-provider.ts`, Step 3/7). Both `fiscal-engine.ts#tick`'s
  queue drain and (from Part C onward) a manual resend reach it through
  the same `submitInvoice(request)` call — there is no separate
  "retry" code path in the provider today, only the one method every
  caller shares.
- **How an `OpenInvoice` rejection currently surfaces**: `openResult =
  await this.sendCommand(...)`; on failure (after the existing,
  unrelated STE1=52 "opened receipt" cancel-and-retry-once), it returned
  straight to `classifyDeviceFailure(openResult, 'Failed to open the
  fiscal invoice')` — mapped to `technical`/`data`/`system` per
  phase-69's STE tables, with **no distinction between "genuinely
  rejected" and "already filed, reply lost."** That's the gap this part
  closes.
- **`readCUInvoiceNumber()`'s exact shape** (confirmed from
  `tests/realEtimsProvider.test.ts`'s existing coverage, no live
  device): `Promise<ServiceResult<{ cuInvoiceNumber: string }>>` —
  success is `{ success: true, data: { cuInvoiceNumber } }`; **both**
  "device reports an error" and "`Res Code="0"` with no
  `<CU_InvoiceNumber>` element" collapse to the same
  `{ success: false, error }` shape. There is no separate
  "not-found vs. error" distinction to make — which matches this part's
  brief exactly: either the device hands back a real number, or it
  doesn't, and both non-number cases are treated identically (genuine
  failure).

## 2. Applied

### `FiscalInvoiceRequest.isRetry?: boolean` (`etims.ts`)

The flag `submitInvoice` uses to tell first attempts and retries/resends
apart, **without any DB access of its own** — the provider has never
touched the database and this doesn't start now. Set by the caller, not
inferred:

- `checkout.ts#buildFiscalRequest` (first attempts) never sets it —
  **unaffected**, exactly as required.
- `fiscal-engine.ts#tick` sets it via the new shared
  `attemptFiscalRetry` (below) — every queued item is, by construction,
  a retry (it only reached `sync_queue` because a first attempt already
  failed), so this is unconditional there.
- Phase-76's manual resend will do the same, through the same shared
  function.

### The recovery, gated on `isRetry` (`real-etims-provider.ts#submitInvoice`)

Inserted right after the existing STE1=52 retry-once block, before the
existing failure return:

```ts
if (!openResult.success && request.isRetry) {
  const recovery = await this.readCUInvoiceNumber()
  if (recovery.success && recovery.data?.cuInvoiceNumber) {
    return {
      ok: true,
      data: {
        invoiceNumber: recovery.data.cuInvoiceNumber,
        qrCode: '',                         // never returned outside CloseReceipt — left empty, not faked
        fiscalizedAt: new Date().toISOString(),
        fiscalizedAtSource: 'local-fallback',
        cuSerialNumber,
        defVerStatus
      }
    }
  }
  // not found / error → fall through, genuine failure
}
if (!openResult.success) {
  return classifyDeviceFailure(openResult, 'Failed to open the fiscal invoice')
}
```

**The two things you flagged, addressed directly:**

- **Never runs on a first attempt.** The `&& request.isRetry` guard is
  the only gate — on a first attempt this field is never set (see
  above), so the condition is false and execution falls straight
  through to the pre-existing `classifyDeviceFailure` return, completely
  unchanged from before this part. A sale that was never filed cannot
  be routed through `readCUInvoiceNumber` at all on its first attempt —
  there's no code path that reaches it. Tests: *"on a FIRST attempt
  (isRetry unset)… does NOT call ReadCUinvoiceNumber"* and *"an explicit
  isRetry:false behaves exactly like a first attempt"*
  (`realEtimsProvider.test.ts`).
- **"Device doesn't know this number" is a real failure, not swallowed.**
  `recovery.success && recovery.data?.cuInvoiceNumber` is the only path
  that returns `ok: true`. Both `recovery.success === false` (a device
  error answering the check itself) and `recovery.success === true` with
  no `cuInvoiceNumber` (the not-found shape) fail that condition and
  fall through unchanged to `classifyDeviceFailure(openResult, …)` —
  note it's the **original** `openResult`, not the recovery attempt's
  own result, so the sale's real rejection reason (e.g. "Wrong client
  PIN") is what gets reported, not an error about the recovery check.
  Tests: *"device does NOT know this invoice either… NOT falsely marked
  fiscalized"* and *"ReadCUinvoiceNumber itself errors… the ORIGINAL
  OpenInvoice rejection is still reported — not swallowed"*
  (`realEtimsProvider.test.ts`).

No guessing at error codes anywhere in this: the recovery triggers on
*any* `OpenInvoice` rejection during a retry, regardless of which STE
code it carried — exactly per the brief ("we don't need to know which
error code means duplicate — we ask the device").

### Recovered-sale QR — approved default, implemented as specified

`qrCode: ''`. No QR-fetch path was built. Documented inline (see the
excerpt above) that this is a structural absence — `QRcode` is only ever
returned by `CloseReceipt`, and a recovered sale's current attempt never
sends `CloseReceipt` — not a fake or guessed value.

### Safe-to-run-twice — `src/main/services/fiscal-retry.ts` (new)

A retry/resend is only ever safe to make if the order isn't *already*
fiscalized by the time it actually runs — otherwise a race between two
callers (the background queue and, from phase-76, a manual resend) could
each decide independently to resubmit. `attemptFiscalRetry(deps,
localId, request)` is the one shared gate both go through:

1. Re-reads the order's **current** `fiscal_status` immediately before
   doing anything. Already `'fiscalized'` → returns the stored
   invoice/QR/timestamp, **no device call at all**.
2. Otherwise, calls `fiscalizationProvider.submitInvoice({ ...request,
   isRetry: true })`.

`fiscal-engine.ts#tick` now calls this instead of `submitInvoice`
directly — `FiscalEngineDatabase` gained `getOrder` for it. Everything
downstream of the returned outcome (`markFiscalQueueItemSynced` /
`recordFiscalQueueFailure`) is **unchanged**: a device-recovered or
already-fiscalized outcome both look like a normal `ok: true` to that
existing code, so the queue row is cleared and the order marked
fiscalized through the exact same path a normal success always used —
no new plumbing needed there.

## 3. Tests

- **`tests/realEtimsProvider.test.ts`** (new `describe` block, 6 tests):
  device-recovers-as-fiscalized (no `SellPLU`/`CloseReceipt` resent, QR
  empty); device-doesn't-know-it (genuine `data`-kind failure, not
  fiscalized); `ReadCUinvoiceNumber` itself erroring (original rejection
  reported, not the recovery's own error); first-attempt unaffected
  (`isRetry` unset); explicit `isRetry: false` behaves like a first
  attempt; the pre-existing STE1=52 auto-retry-once still resolves
  first and doesn't trigger the new recovery unnecessarily.
- **`tests/fiscalRetry.test.ts`** (new file, 6 tests): already-fiscalized
  → no device call, returns the stored result; not-yet-fiscalized
  (`waiting`/`needs_fixing`/no row) → resubmits with `isRetry: true` in
  each case; **two rapid retries of the same sale file at most ONE
  invoice** (a stateful fake models the second retry landing after the
  first one's success reached the database — `submitInvoice` called
  exactly once, both calls return the same invoice number); the request
  object passed in is never mutated.
- **`tests/fiscalEngine.test.ts`** (2 new tests + `getOrder` added to
  every existing fake db): every resubmission is tagged `isRetry: true`;
  an order that's already fiscalized by the time `tick()` reaches it
  (the race scenario) makes **no device call** and still marks the
  queue item synced with the stored invoice number/QR.

## 4. Verification

- `npx vitest run`: **59 files / 886 tests** (872 going into this part +
  6 + 6 + 2 new), 0 failures, 0 loosened assertions.
- `npm run typecheck` (node + web): clean.

## VERIFY-ON-DEVICE

- The whole `request.isRetry` → `readCUInvoiceNumber` recovery path.
  No live duplicate-`TraderSystemInvNum` rejection has ever been
  captured against a real device — this is built entirely from
  `readCUInvoiceNumber`'s own doc comment and the protocol
  documentation's description of the command, not an observed device
  response. Confirm against a live device before trusting this path in
  production: (a) that a duplicate `TraderSystemInvNum` actually causes
  `OpenInvoice` to fail rather than silently succeeding again, and
  (b) that `ReadCUinvoiceNumber` reliably returns the correct prior
  invoice number in that situation.
- Recovered-sale QR: confirmed as a deliberate, approved gap, not a
  device fact to verify — flagged for receipt-wording handling in a
  later step (per the brief).

---

**STOP for review**, per this step's brief — Part C (retry
reclassification + manual resend) does not start until reviewed.
