# Phase 79 — Cashier notice, Part C: fix-and-resend for a wrong PIN

Part C of Step 3, closing out the feature. Builds on `docs/phase-77.md`
(plumbing) and `docs/phase-78.md` (the notice). Adds the three actions
for a `fiscalDataIssue === 'wrong-pin'` rejection: correct the PIN,
remove it, or send the sale to the office — all on the same notice
Part B built, not a new one.

## Backend

### `correctPinAndResend` (`fiscal-retry.ts`)

```ts
export async function correctPinAndResend(
  deps: { db: FiscalResendDb; fiscalizationProvider: FiscalRetryProvider },
  localId: number,
  buyerPin: string | undefined
): Promise<FiscalSubmitOutcome>
```

Reads the order's STORED request (`fiscal_request_json`), rewrites
**only** `buyerPin` (`{ ...storedRequest, buyerPin }`), persists that
via the existing `setOrderFiscalRequest`, then calls
`resendFiscalization` — unchanged, the exact same function
`fiscal-engine.ts` and Step 4's future back-office resend will use. No
new submit path was built; correcting the PIN is purely a targeted
rewrite of already-stored data, so:

- **Part B's device-side recovery** (`isRetry` → `ReadCUinvoiceNumber`)
  still runs if `OpenInvoice` is rejected again.
- **The already-fiscalized race guard** still runs first — calling this
  on an order that's already fiscalized (e.g. the background queue won
  a race) makes no device call and reports the existing result.
- **Rule 1 holds** for the same structural reason every other resend
  holds it: one gate, one caller of `submitInvoice`, always tagged
  `isRetry: true`.

`buyerPin: undefined` (the "Remove PIN" action) is not stored as a
literal `undefined` — `JSON.stringify` drops it entirely when the
request is persisted, so the corrected stored request genuinely has no
`buyerPin` key at all, not a blanked one. Confirmed by a test that
checks the key's absence directly, not just its value.

### `buildFiscalResendResult` (`fiscal-retry.ts`)

Wraps a `FiscalSubmitOutcome` into `FiscalResendResult` (new type,
`database.ts` — the same fiscal-outcome fields `CheckoutReceipt`
carries, minus `mode`/`shopifyOrderId`, which a resend has no opinion
on) by reading the order back from the database, same pattern
`checkout.ts#runCheckout` already uses for its own return value.

### IPC — `fiscal:correct-pin-and-resend`

New schema `correctPinAndResendSchema` (`ipcValidator.ts`): `localId`
(positive int), `buyerPin` (non-blank string, or `null` to remove — a
blank string is rejected outright, forcing the caller to be explicit).
No PIN *format* check here — the renderer already gates the Save button
on `isValidKraPinFormat`, and `submitInvoice`'s own pre-send validation
(`fiscal-validate.ts`) is the existing backstop either way, so
duplicating it in the IPC layer would just be a second copy of the same
rule.

Handler calls `correctPinAndResend` with the real `db`/
`fiscalizationProvider`, then `buildFiscalResendResult`, returning
`ServiceResult<FiscalResendResult>`. Exposed to the renderer as
`window.api.correctPinAndResend(localId, buyerPin)`.

## Frontend

### `cartStore.ts` — `applyFiscalResendResult`

Merges a resend's new fiscal fields into `lastReceipt` (only if it's
still the same `localId` — a no-op if the till has since moved on to a
different sale), leaving `localId`/`mode`/`shopifyOrderId` untouched.
`FiscalNotice` re-derives from the updated `lastReceipt` automatically —
a fiscalized result makes the notice disappear with no extra wiring.

### `fiscalNotice.ts` — `fixableAs`

`FiscalNotice.fixableAs?: 'wrong-pin'`, set only when
`fiscalStatus === 'needs_fixing'`, `fiscalErrorKind !== 'system'`, and
`fiscalDataIssue === 'wrong-pin'` — a pure, tested function, not a
condition buried in the component. This is what gates the buttons:
`FiscalNotice.tsx` only renders them when `notice.fixableAs ===
'wrong-pin'`, so any other data rejection (bad HS code, missing item,
…) shows the plain message from Part B with no buttons at all.

### `FiscalNotice.tsx` — the three actions

On the same banner Part B built, appended below the message when
`fixableAs === 'wrong-pin'`:

- **Correct PIN** → reveals an inline text input (reusing
  `isValidKraPinFormat`/`KRA_PIN_MAX_LENGTH` from `lib/kraPin.ts`, the
  same validator `PosCheckoutPanel` already uses) plus Save & Resend /
  Cancel. Save is disabled until the entered PIN passes the format
  check.
- **Remove PIN & Resend** → calls `correctPinAndResend(localId, null)`
  directly, no extra confirmation step (removing a PIN is reversible —
  a walk-in B2C sale with no PIN is valid, and nothing is lost).
- **Send to Office** → dismisses the notice, same as the existing ×
  button. No resend call. Leaves the order `needs_fixing` for Step 4's
  back-office list.

All three (and the Save/Cancel pair) disable while a resend is in
flight, and an inline error line appears if the IPC call itself fails
(network/IPC issue, not a fiscal rejection — that case updates the
notice via `applyFiscalResendResult` instead).

## Tests

- **`tests/fiscalResend.test.ts`** (+11 tests): `correctPinAndResend` —
  correcting updates *only* `buyerPin` on the stored request (every
  other field, including `items`/`total`/`companyName`, asserted
  unchanged) and resends successfully; removing the PIN clears the key
  entirely (not just blanks it) and resends; a resend that still fails
  the same way stays `needs_fixing`/`data`, never falsely fiscalized;
  calling it on an already-fiscalized order makes no device call
  (Rule 1, via the shared guard); a clean failure when there's no
  stored request to correct. `buildFiscalResendResult` — the fiscalized
  and still-failing shapes.
- **`tests/fiscalNotice.test.ts`** (+4 tests): `fixableAs` is
  `'wrong-pin'` only for the exact combination
  (`needs_fixing`/`data`/`wrong-pin`); a different data reason,
  a system rejection, and `waiting` all leave it `undefined` even when
  fed a `fiscalDataIssue: 'wrong-pin'` value that shouldn't apply —
  proving the gate checks `fiscalStatus`/`fiscalErrorKind` too, not
  just the marker in isolation.
- **`tests/ipcValidator.test.ts`** (+6 tests): the new schema's accept/
  reject cases, including that a blank-string `buyerPin` is rejected
  (must be `null` to remove) and a missing `buyerPin` field is rejected
  (must be explicit).
- **`tests/cartCheckout.test.ts`** (+3 tests): `applyFiscalResendResult`
  merges correctly, is a no-op for a stale `localId`, and a no-op with
  no `lastReceipt` at all.

## Verification

- `npx vitest run`: **61 files / 935 tests** (915 going into this part
  + 20 new), 0 failures, 0 loosened assertions.
- `npm run typecheck` (node + web): clean.
- **Visual check — still not done, and I want to be direct about why.**
  I don't have a screenshot or browser-automation tool available in
  this session, so even attempting to launch `npm run dev` wouldn't let
  me actually see the result — I'd be guessing either way. This machine
  does have a real display (it's not a headless CI box, contrary to
  what I assumed in `docs/phase-78.md`), so **you're able to check this
  yourself** by running `npm run dev`, ringing up a sale with a
  malformed customer PIN in mock mode, and looking at the banner. That's
  a better check than anything I could produce blind. Worth doing before
  calling Step 3 finished, per your own note last time.

## Close-out — confirming the four rules

- **Rule 1 (never file twice)**: `correctPinAndResend` never builds a
  new submit path — it rewrites the stored request, then calls the
  *existing* `resendFiscalization`, which goes through
  `attemptFiscalRetry`'s already-fiscalized guard before ever touching
  the device. Same guarantee as every other resend, tested directly
  (`goes through the existing guarded path` test).
- **Rule 4 (never blocks)**: unchanged from Part B — `FiscalNotice`
  remains a `fixed`, non-modal, app-root overlay. The new buttons live
  inside that same overlay; nothing about them touches
  `PosCheckoutPanel` or gates the next sale. Every button disables
  itself (not the till) while a resend is in flight.

---

Step 3 (cashier notice + fix-and-resend) is code-complete and tested.
Holding here for your review, and for the visual check on a real
screen before calling it fully done.
