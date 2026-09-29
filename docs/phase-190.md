# Phase 190 — The start-up sweep flags stuck sales; it never files them

- **Date:** 2026-09-29
- **Requested:** You said the stuck sales on the pilot till are most likely test sales. Filing them would turn test sales into real KRA invoices, so the sweep from phase 185 Part 2 must not file anything by itself.
- **Outcome:** Done. Every sale the sweep finds is flagged `needs_fixing` for a person. None is queued or filed.
- **Branch / base commit:** staging @ 2476a3a. No device calls.

## Change

- **`database.ts`, `sweepUnqueuedFiscalOrders`:**
  - A NULL-status sale **with a stored request** used to become `waiting` with a due queue row. It now becomes `needs_fixing`/`system` with no queue row.
  - Its request is kept, so Needs Attention's Resend files it exactly as originally built (`resendFiscalization`, retry path with `verifyAlreadyFiled`).
  - A sale **without** a request is flagged as before.
  - The return value is now `{ resendable, unsendable }`.
- **`INTERRUPTED_FILING_REASON`** now reads: check whether it was a real sale, then press Resend; nothing is sent automatically.
- **`index.ts`:** the log line and comment follow.

## Tests (`tests/fiscalCheckoutDurability.test.ts`)

- **Changed assertions:**
  - The sweep test now expects `needs_fixing`/`system` for the sale with a request, the request kept verbatim, and no fiscal row (it expected `waiting`/`technical` and one due row).
  - The return values changed from `{ queued, flagged }` to `{ resendable, unsendable }` in two places.
- **New:** after a sweep, a fiscal-engine pass makes **no device call**, and a manual resend files the swept sale once, with `isRetry: true`.
- **Mutation:** making the sweep queue again fails both sweep tests.
- **Full run:** type check clean, **153 files, 2,343 tests passing**, build succeeds.

## What this means for the till

- On the first start of the next build, each stuck sale appears in Needs Attention with the reason above and counts as unfiled.
- Real sales: a person presses Resend. Test sales: a person leaves them. Nothing reaches KRA unless someone presses Resend.
- The database-reset check (whether new sale numbers could reuse already-filed ones) still needs the till's data; phase 187 remains open for it.

## Rollback

`git revert` this commit. No schema or data change.
