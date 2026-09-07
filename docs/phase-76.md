# Phase 76 — Never-file-twice, Part C: retry reclassification + manual resend

Part C of the "never file a tax invoice twice" step, building on
`docs/phase-74.md` (Part A — stable invoice number) and `docs/phase-75.md`
(Part B — device-side duplicate recovery, `attemptFiscalRetry`'s
already-fiscalized safety gate).

## 1. Retry reclassification (`fiscal-engine.ts`)

**Why this matters more than it looks**: with the device password wrong
(the POC's live blocker), *every* sale first fails on connectivity and
lands in `sync_queue` as `waiting`. Before this change, `tick()` treated
every retry failure identically — back off and try again — so a sale
whose real problem is a bad PIN or a missing HS code would retry forever
without ever being flagged for a person, only revealing itself once the
device actually became reachable.

`tick()`'s failure branch now reuses `routeFiscalOutcome` (not
re-encoded) to decide, on **every** retry outcome, not just the first:

```ts
if (result.ok) {
  db.markFiscalQueueItemSynced(item.id, result.data.invoiceNumber, result.data.qrCode)
} else {
  const { status, enqueue } = routeFiscalOutcome(result)
  if (enqueue) {
    db.recordFiscalQueueFailure(item.id, result.reason)          // still technical — back off, as before
  } else {
    db.setOrderFiscalFailure(item.entity_id, status, result.reason, result.kind)  // needs_fixing
    db.removeFiscalQueueItem(item.id)                             // stop retrying, leave the queue
  }
}
```

`RubisDatabase` gained `removeFiscalQueueItem(queueId)` — deletes one
`sync_queue` row without touching the order (unlike
`markFiscalQueueItemSynced`, which does both for a success). `FiscalEngineDatabase`
gained `removeFiscalQueueItem`/`setOrderFiscalFailure` alongside phase-75's
`getOrder`.

**Directly addressing what you flagged**: `tests/fiscalIntegration.test.ts`'s
new **Scenario H** seeds an order exactly as a connectivity failure
would have — `fiscal_status: 'waiting'`, queued — then runs a real
`fiscalEngine.tick()` against the real `RubisDatabase` where the device
now rejects it for `kind: 'data'` (e.g. a bad PIN). Confirmed
end-to-end, not just via a mocked DB call:

- `db.getOrder(localId)?.fiscal_status` → `'needs_fixing'`
- `db.getPendingFiscalQueue(Date.now())` → **empty** — the row is
  actually gone, not just backed off
- a second `tick()` makes **zero** additional `submitInvoice` calls —
  proves it isn't quietly still queued under a future `next_attempt_at`

A companion test in the same `describe` block confirms a still-technical
retry failure keeps backing off exactly as before (stays in the queue,
`fiscal_status` stays `'waiting'`). Unit-level coverage of the same
branch (mocked db, both `data`/`system` kinds via `it.each`, plus a
dedicated "stays technical" case) lives in `tests/fiscalEngine.test.ts`.

## 2. Manual resend entry point

### The stored-request problem, and how it's solved

The brief requires the resend function to load the sale's **stored**
request, never a freshly rebuilt one. That request already lives in
`sync_queue` for a `waiting` order — but a `needs_fixing` order is
**deliberately never queued** (phase-71's design, and now phase-76's
own reclassification also *removes* the queue row when moving to
`needs_fixing`). So there was nowhere to load a `needs_fixing` order's
request from.

Fixed at the source: `orders` gained a new column,
`fiscal_request_json`, and `RubisDatabase.setOrderFiscalRequest(localId,
request)` writes it. `runCheckout` (`checkout.ts`) now calls this right
after building the fiscal request — **before** calling
`submitInvoice`, so it's stored regardless of outcome (success, queued,
or `needs_fixing`) — and again in the thrown-exception fallback for the
rare case where the throw happened while building the request itself
(the one case the first write never ran). Every order that has ever
attempted fiscalization now carries its own last-used request on the
order row, independent of `sync_queue` state.

### `resendFiscalization` (`fiscal-retry.ts`)

```ts
export async function resendFiscalization(
  deps: { db: FiscalResendDb; fiscalizationProvider: FiscalRetryProvider },
  localId: number
): Promise<FiscalSubmitOutcome>
```

1. No order found → clean failure, no device call.
2. Already `'fiscalized'` → no-op success, no device call, no need to
   even look for a stored request.
3. No stored request yet (fiscalization never attempted) → clean
   failure, no device call.
4. Otherwise: parses `fiscal_request_json` and calls
   `attemptFiscalRetry` — **the exact same function `fiscal-engine.ts#tick`
   uses** — so Part B's device-side recovery and the already-fiscalized
   race guard both apply here automatically. On success, writes
   `setOrderFiscalInfo`; on a still-retryable failure, re-queues via
   `queueFiscalInvoice` (Rule 3 — never silently lose an unfiscalized
   sale); on a non-retryable failure, writes `setOrderFiscalFailure`
   and does **not** re-queue.

**Directly addressing what you flagged — "reuses the stored sale rather
than rebuilding it"**: this isn't just a design intent, it's structural.
`resendFiscalization`'s signature is `(deps, localId)` — there is no
parameter through which fresh cart/checkout data could flow in even if
the implementation wanted to use it. The only data source is
`fiscal_request_json`. `tests/fiscalResend.test.ts` proves this two ways:

- **`reuses the stored TraderSystemInvNum — proven against the REAL
  provider, not a mock`**: seeds a stored request, resends it through
  the real `RealFiscalizationProvider` (mocked HTTP transport only), and
  asserts the posted `OpenInvoiceWithFreeCustomerData` command's
  `TraderSystemInvNum` is `INV-<localId>` — exactly what Part A already
  proved is derived purely from `localId`, confirming the resend path
  feeds the provider the same stable request a first attempt would have.
- The `needs_fixing` re-attempt test asserts `submitInvoice` was called
  with `{ ...storedRequest, isRetry: true }` — the stored object's
  fields exactly, nothing added or substituted beyond the one
  `isRetry` tag `attemptFiscalRetry` adds.

Also tested: resend of an already-fiscalized order (no-op, no device
call, returns the stored invoice number); resend going through Part B's
recovery (device reports already filed → fiscalized, no second
`SellPLU`/`CloseReceipt`); a still-retryable resend failure re-queuing
the order; a still-non-retryable resend failure staying `needs_fixing`
and not queuing; the two clean-failure edges (no order / no stored
request).

## 3. `docs/KNOWN_GAPS.md`

No existing entry was literally titled "never file twice" or
"`ReadCUinvoiceNumber` not wired" in the current file to delete —
checked; the closest prior references were narrative text inside
`docs/phase-60.md`/`docs/phase-70.md`, not a standalone `KNOWN_GAPS.md`
entry. Added one consolidated entry, **"eTIMS: duplicate-filing
recovery (`ReadCUinvoiceNumber`) is wired but unverified against a live
device"**, recording: the mechanism is now closed (Phases 74–76); the
audit's original open question (which STE code signals a duplicate) was
resolved by the structural `isRetry`-gated approach rather than by
finding/guessing a code; and the two things that remain genuinely
`VERIFY-ON-DEVICE` — the recovery path itself (never observed against a
real device) and the recovered-sale-no-QR behavior (a deliberate,
already-approved design decision, not a device fact, flagged for
Step 5's receipt wording).

## 4. Verification

- `npx vitest run`: **60 files / 899 tests** (886 going into this part +
  5 from the reclassification work + 8 from `fiscalResend.test.ts`), 0
  failures, 0 loosened assertions.
- `npm run typecheck` (node + web): clean.

## Close-out — the four rules, and the test that guards each

1. **Never file a tax invoice twice.**
   - `TraderSystemInvNum` stable per sale, proven across attempts —
     `realEtimsProvider.test.ts` ("SAME TraderSystemInvNum…", phase-74).
   - Device-side recovery on any retry/resend `OpenInvoice` rejection —
     `realEtimsProvider.test.ts`'s "duplicate-filing recovery" `describe`
     block (phase-75).
   - Already-fiscalized race guard, shared by the queue and resend —
     `fiscalRetry.test.ts` ("makes NO device call…", "two rapid
     retries… at most ONE invoice", phase-75) and
     `fiscalEngine.test.ts` ("makes NO device call… race with a
     resend", phase-75).
   - Resend reuses the stored request, never rebuilds — `fiscalResend.test.ts`
     ("reuses the stored TraderSystemInvNum…", phase-76).
2. **Never print a valid-looking tax receipt for an unfiscalized sale.**
   Unaffected by this step — receipt printing already gates on
   `fiscalInvoiceNumber || fiscalQrCode` being present (phase-70's
   audit, §7); a recovered sale's empty `qrCode` is real, stored data,
   not a fake value, and `fiscal_status` only ever becomes `'fiscalized'`
   when a real invoice number exists (`setOrderFiscalInfo`'s single
   write path, unchanged).
3. **Never silently lose a completed-but-unfiscalized sale.**
   - A retry that's still retryable keeps backing off, never dropped —
     `fiscalEngine.test.ts` ("records a still-technical retry
     failure…", phase-76).
   - A retry that becomes `needs_fixing` is flagged for a person, not
     discarded — `fiscalIntegration.test.ts`'s Scenario H (phase-76).
   - A resend that's still retryable is re-queued, not dropped —
     `fiscalResend.test.ts` ("re-queues it rather than losing it",
     phase-76).
4. **Never block the till.**
   Unaffected by this step — `runCheckout`'s unconditional final
   `return` (phase-73) is untouched; this step only changed what
   happens to a sale *after* checkout already completed successfully
   for the customer, in the background retry/resend paths.

---

Full suite and typecheck green. This closes the "never file a tax
invoice twice" step (Parts A/B/C). Ready for the master brief's next
steps (3 — cashier notice + fix-and-resend, 4 — back-office list, 5 —
receipt wording) whenever you'd like to continue.
