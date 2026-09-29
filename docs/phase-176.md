# Phase 176 — Card tender on the live checkout panel (PDQ, recorded manually): read-only audit

- **Date:** 2026-09-29
- **Requested:** Part 1 (read-only) of adding a Card tender to the live checkout panel — the same manual-recording pattern as M-Pesa's manual code entry, attributed to the cashier, using the existing `runCheckout` → fiscal queue path. No code changes in this part.
- **Outcome:** Audit complete. STOP for review, per the request — Part 2 not started.
- **Branch / base commit:** staging @ c39aeaf (docs: report for phase 175)

---

## 1. Type and validation

### 1a. `PaymentMethod` declaration

`src/main/services/database.ts:26`

```ts
export type PaymentMethod = 'cash' | 'mpesa' | 'card'
```

`'card'` is already a member — has been since before this audit (referenced throughout `reports.ts`, `receiptLayout.ts`, `orders.ts` already; see below). No type change is needed anywhere.

### 1b. `ipcValidator.ts` — `checkoutRequestSchema`

`src/main/lib/ipcValidator.ts:45-87`

- `paymentMethod: z.enum(['cash', 'mpesa', 'card'])` — [ipcValidator.ts:49](../src/main/lib/ipcValidator.ts#L49) — `'card'` already accepted.
- `referenceNumber: z.string().optional()` — [ipcValidator.ts:52](../src/main/lib/ipcValidator.ts#L52) — **no length rule, no character rule, and no cross-field rule** tying it to `paymentMethod`. A request with `paymentMethod: 'card'` and `referenceNumber` omitted, empty string, or any garbage string passes schema validation today. There is no `cardManual`-style nested object mirroring `mpesaManual` ([ipcValidator.ts:77-86](../src/main/lib/ipcValidator.ts#L77-L86)) — no attestation field exists on the wire at all for card.

### 1c. `checkout.ts` — `runCheckout`, the 'card' branch

`src/main/services/checkout.ts`

There is no `if (input.paymentMethod === 'card')` branch anywhere in this file. The only payment gate is:

```ts
if (input.paymentMethod === 'mpesa') {   // checkout.ts:403
  ...
}
```
([checkout.ts:403-453](../src/main/services/checkout.ts#L403-L453))

A `'card'` checkout falls straight through this `if` (it's not `'mpesa'`), `mpesaSettlement` stays `null`, and it lands in the final, unconditional branch:

```ts
} else {
  localId = db.queueOrder(orderInput).localId   // checkout.ts:517
}
```

`orderInput` (built at [checkout.ts:457-470](../src/main/services/checkout.ts#L457-L470)) carries straight through from the request with no validation:

```ts
paymentMethod: input.paymentMethod,      // 'card'
tenderedAmount: input.tenderedAmount,    // trusted as-sent, not checked against total
changeDue: input.changeDue,              // trusted as-sent
referenceNumber: input.referenceNumber,  // trusted as-sent, including undefined/blank
```

`queueOrder` ([database.ts:1359-1415](../src/main/services/database.ts#L1359-L1415)) writes this straight to the `orders` row:

| Column | Value for a card sale today |
| --- | --- |
| `payment_method` | `'card'` |
| `reference_number` | `input.referenceNumber ?? null` — **null accepted, nothing rejects a blank reference** |
| `tendered_amount` | `input.tenderedAmount` — whatever the renderer sent, unchecked |
| `change_due` | `input.changeDue` — whatever the renderer sent, unchecked |
| `staff_id` | `input.staffId` (via `staff.id` after the `getStaffById` lookup at [checkout.ts:351-354](../src/main/services/checkout.ts#L351-L354)) — cashier attribution **is** correct and present |
| `shift_id` | current open shift, same as every other tender |

**Direct answer to the question asked:** nothing in the manual M-Pesa branch has any equivalent for card today. Specifically absent, compared to manual M-Pesa:

- No blank-reference refusal (M-Pesa: [checkout.ts:404-407](../src/main/services/checkout.ts#L404-L407)).
- No attestation requirement (M-Pesa: `manualApproval.acknowledgedUnverified` check at [checkout.ts:416-418](../src/main/services/checkout.ts#L416-L418)).
- No cross-mode/already-used guard (M-Pesa: [checkout.ts:423-425](../src/main/services/checkout.ts#L423-L425) — not obviously needed for card since nothing else could claim the same PDQ reference, but noted).
- No settlement row analogous to `mpesa_payments` (M-Pesa: `mpesaSettlement` object built at [checkout.ts:426-435](../src/main/services/checkout.ts#L426-L435) and persisted via `queueOrderRecordingManualPayment`). Card writes only the bare `orders` row; there is no `card_payments` table and none is implied to exist.
- No status concept at all — M-Pesa's `verification_status` (`'manual_unverified'` etc.) has no equivalent column or value for card anywhere in the schema.

**Card today has no gate at all.** The type/schema work was done (1a, 1b) but the enforcement was never wired in — this is the actual gap Part 2 has to close, and per the request ("regardless of what the renderer sent... never trusted from the renderer") that enforcement belongs in `runCheckout`, mirroring the `if (input.paymentMethod === 'mpesa')` block's shape with a parallel `if (input.paymentMethod === 'card')` block.

One more detail worth flagging for Part 2: `buildFiscalRequest` ([checkout.ts:274-305](../src/main/services/checkout.ts#L274-L305)) already forwards `input.paymentMethod` (`'card'`) to the fiscal device request unchanged — that path needs no change.

### 1d. `checkoutMath.ts` — `canCompleteSale` for `'card'`

`src/renderer/src/lib/checkoutMath.ts:68-81`

```ts
export function canCompleteSale(
  method: PaymentMethod,
  total: number,
  tendered: number,
  referenceNumber?: string
): boolean {
  if (method === 'cash') {
    return tendered >= total
  }
  if (method === 'mpesa') {
    return false
  }
  return (referenceNumber ?? '').trim().length > 0   // line 80 — this is what 'card' hits
}
```

This already implements the "phase 102 change" the request refers to: `'card'` (and any future non-cash/non-mpesa method) falls through to the final line, requiring only a **non-blank reference number**. It has no parameter for an attestation checkbox — that state lives only in whatever component renders the card entry screen and must be threaded into the "Complete Sale enabled only when..." condition at the call site, the same way `PosCheckoutPanel.tsx`'s `canSubmitCash` combines `canCompleteSale` with other panel-level conditions ([PosCheckoutPanel.tsx:154-158](../src/renderer/src/components/PosCheckoutPanel.tsx#L154-L158)). No change needed to this function itself for Part 2 as scoped (Option A, below) — the attestation gate is a separate boolean the checkout button's `disabled` expression must additionally require.

---

## 2. Live UI

### 2a. `PosCheckoutPanel.tsx` — the method toggle row

`src/renderer/src/components/PosCheckoutPanel.tsx:351-374`

```tsx
<div className="mb-2 grid grid-cols-2 gap-3">
  <button ... className={`h-14 rounded-xl text-xl font-bold transition active:scale-95 ${...}`}>
    CASH
  </button>
  <button ... className={`h-14 rounded-xl text-xl font-bold transition active:scale-95 ${...}`}>
    M-PESA
  </button>
</div>
```

- Toggles rendered: exactly two — `CASH` and `M-PESA`.
- Classes: container is `grid grid-cols-2 gap-3` (two equal columns, 12px gap); each button is `h-14` (56px), full column width, `text-xl font-bold`, `rounded-xl`, active/inactive styling via ternary (`bg-rose-600 text-white shadow` vs `border border-slate-200 text-slate-700 hover:bg-slate-50`).
- State variable: `method`, typed `QuickPaymentMethod = Extract<PaymentMethod, 'cash' | 'mpesa'>` ([PosCheckoutPanel.tsx:43](../src/renderer/src/components/PosCheckoutPanel.tsx#L43)) — **this type itself excludes `'card'`**, so Part 2 must widen it (or introduce a new local type) as well as the JSX.
- Confirmed: `'card'` is not offered. The component's own doc comment ([PosCheckoutPanel.tsx:37-42](../src/renderer/src/components/PosCheckoutPanel.tsx#L37-L42) and [PosCheckoutPanel.tsx:50-53](../src/renderer/src/components/PosCheckoutPanel.tsx#L50-L53)) states this is deliberate (Phase 44, Hick's Law) — a Part 2 comment update should note the reversal and why (live PDQ tender needed at the till, not just theoretically supported by the contract).
- The toggle row sits inside the `!staleDiscountOrOverride` branch ([PosCheckoutPanel.tsx:349](../src/renderer/src/components/PosCheckoutPanel.tsx#L349)) but is **not** separately gated on cart emptiness — `canSubmitCash` requires `cartCount > 0` ([PosCheckoutPanel.tsx:155](../src/renderer/src/components/PosCheckoutPanel.tsx#L155)) but the buttons themselves render regardless of cart count today (same for the existing two). The request's "Card toggle hidden when the cart is empty, same as the others" therefore needs a new behavior applied consistently to all three, not something Card alone can copy — worth confirming intent before Part 2 (see open question below).

### 2b. `CheckoutModal.tsx`

Does not exist in the working tree — `git log --all -- '**/CheckoutModal.tsx'` shows it was deleted outright: `1bdae0a chore: delete dead CheckoutModal.tsx, unreferenced since PosCheckoutPanel replaced it (Phase 44)`. Nothing to confirm-as-dead; there is no file to avoid building on.

### 2c. `PaymentModal.tsx` — manual M-Pesa code field pattern

`src/renderer/src/components/PaymentModal.tsx`

On-screen keyboard call ([PaymentModal.tsx:310-319](../src/renderer/src/components/PaymentModal.tsx#L310-L319)):

```ts
const openCodeKeyboard = () => {
  useKeyboardStore.getState().open({
    value: unverifiedCode,
    onChange: (next) => setUnverifiedCode(next.toUpperCase().replace(/[^A-Z0-9]/g, '')),
    maxLength: 10,
    label: 'M-Pesa code from the customer's message',
    mode: 'caps',
    docked: true
  })
}
```

- `mode: 'caps'`, `docked: true`, `maxLength: 10`.

Attestation checkbox ([PaymentModal.tsx:371-379](../src/renderer/src/components/PaymentModal.tsx#L371-L379)):

```tsx
<label className="mt-3 flex items-start gap-2 text-base text-amber-900">
  <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} className="mt-1 h-5 w-5" />
  I have seen the M-Pesa confirmation message on the customer's phone.
</label>
```

Validation on submit ([PaymentModal.tsx:328-341](../src/renderer/src/components/PaymentModal.tsx#L328-L341)) checks the code pattern, then `acknowledged`, then calls `onPaid(unverifiedCode, { code: unverifiedCode, confirmUnverified: true })` — client-side checks exist "to tell the cashier what is wrong before they tap Complete, not to decide anything" (the file's own doc comment, [PaymentModal.tsx:321-327](../src/renderer/src/components/PaymentModal.tsx#L321-L327)), matching 1c's finding that the real gate must be server-side.

This is confirmed as the pattern to copy (read-only field → shared keyboard, `mode: 'caps'`/`docked: true`, an attestation checkbox with equivalent wording, validate-then-callback), not the STK pattern (`initiateStkPush`/polling, [PaymentModal.tsx:260-299](../src/renderer/src/components/PaymentModal.tsx#L260-L299) region), which has no analogue for a PDQ card sale.

---

## 3. Downstream

### 3a. `reports.ts` — `sumByPaymentMethod`, `generateZReport`, `generateEndOfDayReport`

`src/main/services/reports.ts`

```ts
function sumByPaymentMethod(orders) {
  ...
  if (order.payment_method === 'cash') totals.cash += order.total        // line 94
  else if (order.payment_method === 'mpesa') totals.mpesa += order.total // line 95
  else if (order.payment_method === 'card') totals.card += order.total   // line 96
  ...
}
```

`'card'` already appears — [reports.ts:96](../src/main/services/reports.ts#L96). `sumByPaymentMethod` is used by `generateZReport` ([reports.ts:201](../src/main/services/reports.ts#L201)), `generateEndOfDayReport` (overall totals at [reports.ts:436](../src/main/services/reports.ts#L436) and per-staff at [reports.ts:469](../src/main/services/reports.ts#L469)), and the fiscal reconciliation report ([reports.ts:709](../src/main/services/reports.ts#L709)). **No gap** — once orders start being written with `payment_method='card'`, every one of these reports already totals it correctly, per cashier and overall, with no code change.

### 3b. Receipt renderer (post phase 171)

`src/main/lib/receiptLayout.ts:409-418`

```ts
const paymentLabel = order.paymentMethod === 'mpesa' ? 'M-PESA' : order.paymentMethod === 'card' ? 'CARD' : 'CASH'
push(...keyValueLines(`PAID BY ${paymentLabel}`, formatAmount(totals.total), width))
if (order.paymentMethod === 'cash') {
  push(...keyValueLines('Tendered:', formatAmount(order.tenderedAmount), width))
  push(...keyValueLines('Change:', formatAmount(order.changeDue), width))
} else if (order.referenceNumber) {
  const refLabel = order.paymentMethod === 'mpesa' ? 'M-Pesa ref:' : 'Ref:'
  push(...keyValueLines(refLabel, order.referenceNumber, width))
}
```

Already handles `'card'` as its own case: prints `PAID BY CARD` and, when a reference is present, `Ref: <reference>` (falls into the generic `else` label since it isn't `'mpesa'`). **`'card' prints a sensible label today`, with no change needed** — this was clearly built ahead of the UI in anticipation of this feature. The only risk is the `else if (order.referenceNumber)` — a card order saved with a null/blank reference (possible today per 1c) prints no reference line at all and no visible sign anything is wrong; Part 2's server-side gate closes this by making a blank reference impossible to reach this code path with.

### 3c. `orders.ts` — `buildOrderInput`, how the tender reaches Shopify

`src/main/services/orders.ts:70-106`, specifically the note text at [orders.ts:74-77](../src/main/services/orders.ts#L74-L77):

```ts
const paymentNote =
  payload.paymentMethod === 'cash'
    ? `cash (tendered ${payload.tenderedAmount.toFixed(2)}, change ${payload.changeDue.toFixed(2)})`
    : `${payload.paymentMethod}${payload.referenceNumber ? ` (ref ${payload.referenceNumber})` : ''}`
```

For manual M-Pesa this produces e.g. `mpesa (ref QDF73HK9LM)`, folded into the order's `note` field ([orders.ts:86](../src/main/services/orders.ts#L86)): `...— payment: mpesa (ref QDF73HK9LM)`. There is no gateway, transaction record, or metafield — only this free-text note (plus the unrelated `client_order_uuid` custom attribute/metafield used for sync dedup, [orders.ts:88-98](../src/main/services/orders.ts#L88-L98), which is not payment-specific). Because the `else` branch is keyed only off `payload.paymentMethod !== 'cash'`, a card sale **already** produces `card (ref <reference>)` with zero code change — this generically mirrors the manual M-Pesa treatment exactly, which is what the request asks for ("no more").

### 3d. `MpesaReconciliationPage` / Reconciliation tab

`src/renderer/src/pages/MpesaReconciliationPage.tsx`

Lists only "Manual (cashier-recorded) M-Pesa payments" ([MpesaReconciliationPage.tsx:87](../src/renderer/src/pages/MpesaReconciliationPage.tsx#L87)) sourced from the `mpesa_payments` table, matched "against the M-Pesa statement" ([MpesaReconciliationPage.tsx:90](../src/renderer/src/pages/MpesaReconciliationPage.tsx#L90),164). Nothing else is listed — no other tender type appears here.

Whether a card entry needs a place here depends entirely on the Option A/B choice in §5. Under Option A (no ledger table, no `verification_status` concept for card), there is nothing to reconcile — a PDQ card slip has no external statement this system could ever match it against (unlike M-Pesa, where a Safaricom statement exists as the source of truth to check against later). Under Option A, **card does not belong on this page and none is needed.**

---

## 4. check:fit

`scripts/check-fit.mjs`

- `CASES` — 9 window sizes ([check-fit.mjs:117-127](../scripts/check-fit.mjs#L117-L127)): 1366×768 / 1920×1080 / 2560×1440, each at 100/125/150%.
- The Cash/M-Pesa cases are enumerated as a `scenarios` array run per case ([check-fit.mjs:752-761](../scripts/check-fit.mjs#L752-L761)):

```js
const scenarios = [
  { label: 'Cash', setup: async () => {} },
  { label: 'M-Pesa', setup: async () => { await clickWhereText(cmd, 'button', 'M-PESA'); ... } }
]
```

A `'Card'` case is added the same way: `{ label: 'Card', setup: async () => { await clickWhereText(cmd, 'button', 'CARD'); ... } }` — matching the button's rendered text once Part 2 adds it. Each scenario is run once per `CASES` entry ([check-fit.mjs:764-799](../scripts/check-fit.mjs#L764-L799)), so a third scenario adds 9 more (Card × 9 sizes) measured runs.
- Touch-floor sizing (`keySizes`, [check-fit.mjs:256-268](../scripts/check-fit.mjs#L256-L268)) reads every `aside button` — this already includes the always-rendered toggle row regardless of which `method` is selected, and is only captured once, on the `'Cash'` scenario ([check-fit.mjs:774](../scripts/check-fit.mjs#L774)) — adding a third toggle needs no change here, since the toggle row (not the per-method body) is what's measured.
- Current count, confirmed by the request: **283 fit, 0 skipped.** Adding one scenario (`Card`) across the 9 `CASES` is expected to raise the fit count by roughly 9 (one census+screenshot pass per case) — exact delta depends on what else in the current 283 is scenario-scoped vs. case-scoped; Part 2 should report the actual new total rather than assume the arithmetic here.

---

## 5. Options for Part 2

### Option A — thin: `orders.payment_method='card'` + `orders.reference_number`, no new table

**Cost:** the files already listed in §§1–3 above that need a real change:
1. `checkout.ts` — new `if (input.paymentMethod === 'card')` gate block (blank-reference + attestation refusal), mirroring the mpesa block's shape but with no settlement object/ledger write.
2. `ipcValidator.ts` — a `cardManual`-style nested schema (or reuse of the `referenceNumber` field plus a new attestation field), mirroring `mpesaManual`.
3. `database.ts` (`CheckoutRequest`/`QueueOrderInput` types) — a card-attestation field analogous to `manualApproval`, set server-side by the IPC handler, never by the renderer directly (same structural guarantee `mpesaManual`/`manualApproval` uses today, [database.ts:281-293](../src/main/services/database.ts#L281-L293)).
4. `main/index.ts`'s `orders:checkout` handler — strip/derive the attestation the same way `mpesaManual` → `manualApproval` is handled today ([main/index.ts:1283-1309](../src/main/index.ts#L1283-L1309)).
5. `PosCheckoutPanel.tsx` — third toggle, widen `QuickPaymentMethod`, a new card-entry panel (new component, copying `PaymentModal`'s manual-entry pattern per §2c).
6. `checkout.ts`'s `checkoutRequestSchema` consumer path is otherwise untouched — `checkoutMath.ts` needs **no change** (§1d).
7. `scripts/check-fit.mjs` — one new scenario entry (§4).

No new database table, no new report code, no new receipt code, no new Shopify-push code, no new reconciliation-page code — all four of those are already correct for `'card'` today (§§3a–3c) or correctly need nothing (§3d).

### Option B — a card ledger mirroring `mpesa_payments` (unverified until matched)

**Cost:** everything in Option A, plus:
- A new table (or an extended `mpesa_payments` with a widened `mode` CHECK constraint, which would misname the table) with the same shape as [database.ts:728-743](../src/main/services/database.ts#L728-L743) — `verification_status`, `reconciled_at`/`reconciled_by_staff_id`/`reconciliation_note` columns that have **nothing to reconcile against** (no card-statement source exists anywhere in this codebase or in Shopify's scope per phase-175 F13 — Shopify Payments isn't available in Kenya at all).
- New `queueOrderRecordingCardPayment`-style DB method mirroring `queueOrderRecordingManualPayment`.
- A place on `MpesaReconciliationPage` (or a sibling page) for card entries that can in practice never move out of "unreconciled," since there's no statement to check them against.
- Reports would need to decide whether "card" totals are ledger-sourced or `orders`-sourced (today they're `orders`-sourced and already correct — a ledger would introduce a second source of truth for the same number).

### Recommendation: **Option A.**

The manual M-Pesa ledger exists because a real external statement (Safaricom's) can later confirm or contradict each entry — that's what `reconciled_at`/`reconciliation_note` are for. A PDQ card slip has no equivalent external record this system will ever see; the attestation *is* the whole record, permanently, the same way it's described for manual M-Pesa's own unverified state in `docs/phase-150.md` step 3 (deferred to end-of-day approval, never per-sale reconciliation against a statement that doesn't exist for card). Building the ledger machinery for a stream of rows that can never be reconciled adds a table, a reconciliation-page surface, and a second source of truth for numbers `reports.ts` already computes correctly from `orders` alone — cost with no corresponding benefit. Option A also matches every downstream system's *existing* shape (§§3a–3c all already assume `orders.payment_method='card'` is the source of truth, not a ledger table).

---

## Open questions for Part 2 (not decided here)

1. **Toggle hidden on empty cart.** The request says "Card toggle hidden when the cart is empty, same as the others," but Cash/M-Pesa are **not** currently hidden on an empty cart (§2a) — only `canSubmitCash`/`canCompleteSale` are gated on `cartCount > 0`. Implementing this literally means changing existing Cash/M-Pesa behavior, which is outside "no second sale path" but is a scope expansion beyond adding Card. Needs a decision: hide all three, or match existing (always-visible) behavior for Card too.
2. **Tripwire file names.** The brief names `fiscalEngine`, `fiscalRouting`, and `mpesaPaymentGate` as files whose diff must stay empty. The actual files are `src/main/services/fiscal-engine.ts` and `src/main/services/fiscal-routing.ts` (kebab-case, confirmed via `Glob`) — no `fiscalEngine.ts`/`fiscalRouting.ts` exist. There is also no standalone `mpesaPaymentGate` file; the equivalent is the payment-gate block inside `checkout.ts:341-453` (the `if (input.paymentMethod === 'mpesa')` block and its surrounding comment/`mpesaSettlement` logic) — Part 2's tripwire check should diff that block's line range within `checkout.ts`, not a whole file, since the new `'card'` block necessarily lands in the same file. Suggest confirming the intended tripwire scope before Part 2 starts.

---

# Part 2 — Build (Option A)

- **Date:** 2026-09-29
- **Requested:** Build the card tender, Option A, per Part 1 review. Decisions taken on Part 1's open questions: toggles stay visible on an empty cart (no change to existing Cash/M-Pesa visibility); tripwire scope corrected to the real file paths / the `checkout.ts` block range; Option A confirmed (no new table, no reconciliation/report/receipt/Shopify-push changes).
- **Outcome:** Implemented.
- **Branch / base commit:** staging @ bd3dfce (docs: report for phase 176, Part 1)

## 1. Wire contract

Mirrors `mpesaManual`/`manualApproval` exactly, per Part 1 §1c/§2c:

- **`ipcValidator.ts`** ([ipcValidator.ts:45-108](../src/main/lib/ipcValidator.ts#L45-L108)): added `cardManual: { reference, confirmRecorded }.optional()` beside `mpesaManual`. `reference` uses `z.string().regex(/^[A-Z0-9]{1,12}$/, ...)` — **1-12 characters is a working assumption** (see the code comment on `CARD_REFERENCE_PATTERN` in `checkout.ts` and the identical note here) **until Rubis Finance confirms which PDQ slip number this till is meant to reconcile against.** `confirmRecorded` is `z.literal(true, ...)`, matching `confirmUnverified`.
- **`database.ts`**: added `CardManualEntry` (mirrors `ManualMpesaEntry`), `CardApproval` (mirrors `ManualMpesaApproval`, but — unlike it — carries `reference` too, not just the attestation; see the reasoning in its doc comment and in §2 below), `cardApproval?: CardApproval` on `CheckoutRequest`, and widened `CheckoutIpcRequest` to `Omit<CheckoutRequest, 'manualApproval' | 'cardApproval'> & { mpesaManual?...; cardManual?: CardManualEntry }`.
- **`main/index.ts`**'s `orders:checkout` handler ([main/index.ts:1283-1312](../src/main/index.ts#L1283-L1312)): `cardManual` is stripped from `validation.data` the same way `mpesaManual` is, and derives `cardApproval = { reference: cardManual.reference, confirmRecorded: cardManual.confirmRecorded }`. The renderer never sets `cardApproval` directly — no field for it exists on `checkoutRequestSchema`.

## 2. Server-side gate (`checkout.ts`)

A new `if (input.paymentMethod === 'card')` block, placed directly after the mpesa block closes ([checkout.ts:492-522](../src/main/services/checkout.ts#L492-L522) in the final file). Refuses with a distinct, non-blaming message for each of the three missing-input cases (`CARD_REFERENCE_MISSING_MESSAGE`, `CARD_REFERENCE_INVALID_MESSAGE`, `CARD_NOT_ACKNOWLEDGED_MESSAGE`), independently re-validating the reference pattern server-side (same "renderer's copy is a courtesy, this one is the control" reasoning as `MPESA_MANUAL_CODE_PATTERN`).

**Design deviation from the brief, and why:** the brief's step 2 says to derive `tenderedAmount`/`changeDue`/`referenceNumber` "before building orderInput." Rather than mutating `input` (no precedent for that in this file) or duplicating the derivation at both the `orderInput` site and inside `buildFiscalRequest`'s call, `cardApproval` itself carries the `reference` (unlike `manualApproval`, which relies on `main/index.ts` pre-writing `referenceNumber` before calling `runCheckout`). A local `cardReference: string | null` is set once the gate passes, and `orderInput`'s three fields are computed at their existing declaration site with a ternary on it — no separate pass, no mutation, and `buildFiscalRequest` stays byte-for-byte unchanged (per the brief's own last bullet in step 2), receiving whatever `input.tenderedAmount`/`referenceNumber` the renderer sent. This doesn't matter for correctness: `real-etims-provider.ts` never reads `amountTendered`/`paymentMethod` at all (confirmed by grep — those `FiscalInvoiceRequest` fields are unused past `buildFiscalRequest`), so nothing about the fiscal request's accuracy depends on this.

The card sale then falls through to the same unconditional `db.queueOrder(orderInput)` path cash and every other non-mpesa method already use — no new branch, no new DB method, no settlement/ledger row.

## 3. Renderer

- **`PosCheckoutPanel.tsx`**: `QuickPaymentMethod` widened from `Extract<PaymentMethod, 'cash' | 'mpesa'>` to `PaymentMethod` (all three). Toggle row: `grid-cols-2 gap-3`/`h-14 text-xl` → `grid-cols-3 gap-2`/`h-12 text-lg` — height and gap shrunk before font size, per the brief. **Measured at the worst case (1366×768 @150%, 911×512 window) via `CHECK_FIT_SIZES=1 npm run check:fit`: each toggle is 149×48 CSS px** (149×1.5 = 223.5 × 48×1.5 = 72 physical px at that window's 1.5 device pixel ratio) — well clear of `check-fit.mjs`'s 34-physical-px touch floor. Doc comments at the old "two toggles, Phase 44" block updated to explain the reversal. Toggles remain visible on an empty cart (Part 1 open question 1, resolved by your instruction) — no change to that existing behavior for any of the three.
- **`CardEntryPanel.tsx`** (new): copies `PaymentModal`'s manual-entry pattern, not the STK pattern. Read-only reference field opens the shared keyboard (`mode: 'caps'`, `docked: true`, `maxLength: 12`, filtering to `[A-Z0-9]`, label "Reference from the PDQ slip"). Checkbox text: *"I have checked the PDQ slip shows Approved for this amount."* Unlike the manual M-Pesa panel's own Complete Sale button (always clickable, validated on click), this one is `disabled` until `canCompleteSale('card', total, 0, reference) && acknowledged` — matching Cash's `canSubmitCash` pattern, per your instruction ("Complete Sale for card: enabled only when... `canCompleteSale('card', ...)` is true and the box is ticked"). `checkoutMath.ts` is unchanged, as specified. Empty-cart handling copies `PaymentModal`'s own `total <= 0` guard rather than threading a separate `cartCount` prop, matching that existing sibling component's precedent.
- **`cartStore.ts`**: `CheckoutParams` gained `cardManual?: CardManualEntry`, passed straight through to `window.api.checkout` by the existing `{ items, total, ...params, cartDiscount }` spread — no change to `checkout()`'s body.

## 4. check:fit

Added a third scenario, `{ label: 'Card', setup: click 'CARD' }`, beside Cash/M-Pesa ([check-fit.mjs:752-768](../scripts/check-fit.mjs#L752-L768)).

**New count: 283 fit, 0 skipped, 9 failed** (`Admin > Needs Attention: card not found` at every window size). **The delta and the failures were both isolated and confirmed independently** (`git stash` the whole Part 2 diff, rebuild, rerun):
- **Baseline (Part 1's code, before this change): 274 fit, 9 failed** — the same 9 `Needs Attention` failures, at the same sizes. This is a pre-existing, unrelated environment condition (that Admin card is conditionally rendered off seeded/copied app state `check-fit.mjs` doesn't control) — nothing in this change touches it, and it was never in this diff's tripwire list.
- **With Part 2 restored: 283 fit, 9 failed** — exactly +9 (one new `Card` scenario × 9 `CASES`), all nine ✔. No new failures anywhere.

## 5. Tests

New file `tests/cardManualPayment.test.ts` (21 tests, mirrors `tests/mpesaManualPayment.test.ts`'s structure):
- The four guard rails: no `cardApproval`; blank/whitespace reference (→ `CARD_REFERENCE_MISSING_MESSAGE`); 13-char/lowercase/punctuation reference (→ `CARD_REFERENCE_INVALID_MESSAGE`); no attestation (→ `CARD_NOT_ACKNOWLEDGED_MESSAGE`).
- A valid card sale: writes `payment_method='card'`, `reference_number`, `tendered_amount=total`, `change_due=0`, `staff_id`; overrides a renderer-sent `tenderedAmount:0`/`changeDue:99` (each individually and together); ignores a forged top-level `referenceNumber` in favour of `cardApproval.reference`; is queued exactly once and reaches the fiscal queue exactly once; writes no `mpesa_payments` row (Option A).
- Wire contract: `checkoutRequestSchema` has `cardManual`, not `cardApproval`; accepts a well-formed `cardManual`; rejects the same four malformed-reference shapes at the schema layer; rejects `confirmRecorded: false`.

New file `tests/posCheckoutPanelCard.test.ts` (real mount, `posCheckoutPanelFit.test.ts`'s pattern): all three toggles render; the toggle row is `grid-cols-3` (not a wrapped `grid-cols-2`, see the mutation-check note below); selecting CARD shows `CardEntryPanel` (not the cash numpad or `PaymentModal`); Complete Sale is disabled with no reference, with a reference but no tick, and with a tick but no reference; enabled once both are present; "← Change payment method" returns to Cash.

**Two pre-existing tests updated** (both deliberate, both because Part 1 found card had *no* gate at all — these tests documented that absence, which this change fixes):
- `tests/mpesaPaymentGate.test.ts` — "a card sale completes on its reference number, with no confirmation required" renamed and rewritten to use a valid `cardApproval` instead of a bare `referenceNumber: 'TXN-9001'` (which is no longer sufficient, and contains a hyphen the new pattern rejects anyway). What the test still proves — a card sale is never routed through the M-Pesa confirmation gate — is unchanged.
- `tests/mpesaPaymentsRecord.test.ts` — "writes nothing for a card sale either" now uses a valid `cardApproval` and additionally asserts `result.success === true`, so the assertion exercises a genuinely *successful* card sale rather than an incidentally refused one.

**Existing mpesa gate tests**: unchanged, and green (`tests/mpesaManualPayment.test.ts`, the rest of `tests/mpesaPaymentGate.test.ts`, `tests/runCheckout.test.ts`).

### Mutation checks (each applied, confirmed, then reverted — `git diff --stat` clean after all four)

| # | Mutation | Result |
| --- | --- | --- |
| i | Removed the blank-reference refusal from the card block | `tests/cardManualPayment.test.ts`: 3 tests failed (blank/whitespace refused with the wrong message) |
| ii | Removed the attestation refusal | `tests/cardManualPayment.test.ts`: 1 test failed |
| iii | Made the card block return success and bypass `db.queueOrder` entirely | `tests/cardManualPayment.test.ts`: 6 tests failed |
| iv | Reverted the toggle row to `grid-cols-2` | `check:fit` still passed at every size (Tailwind's grid wraps the 3rd button onto its own row rather than overflowing — confirmed by rebuilding and rerunning `check:fit` against the mutation). **A new assertion was added to `posCheckoutPanelCard.test.ts`** (`row.className` contains `grid-cols-3`) specifically because `check:fit` doesn't catch this case — confirmed to fail against the mutation, then the mutation was reverted |

## 6. Tripwires

`git diff --stat` confirmed empty for: `src/main/services/fiscal-engine.ts`, `src/main/services/fiscal-routing.ts`, `src/main/services/integrations/real-etims-provider.ts`, `src/main/services/integrations/mock-etims-provider.ts`, `src/main/services/reports.ts`, `src/main/lib/receiptLayout.ts`, `src/main/services/orders.ts`, `src/renderer/src/pages/MpesaReconciliationPage.tsx`, `src/renderer/src/components/VirtualNumpad.tsx`, `src/renderer/src/stores/keyboardStore.ts`, `src/renderer/src/lib/checkoutMath.ts`.

For `checkout.ts`: the full diff was inspected line by line. Lines 403-453 in the pre-Part-2 file (the `if (input.paymentMethod === 'mpesa')` block, from `const reference = input.referenceNumber?.trim()...` through its closing brace) are **byte-identical** in the final file — the diff shows zero changes inside that block; every change is either new constants above it, a new `let cardReference` declaration, the new `if (input.paymentMethod === 'card')` block placed immediately after it, or the three derived fields (`tenderedAmount`/`changeDue`/`referenceNumber`) plus one comment inside `orderInput`'s existing literal.

## 7. Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` (node + web) | Clean, no errors |
| `npx vitest run` (full suite) | **2243 passed, 0 failed** (147 files) — includes the two new test files (`cardManualPayment.test.ts`: 21 tests, `posCheckoutPanelCard.test.ts`: 8 tests) and the two pre-existing tests updated in place (§5) |
| `electron-vite build` | Clean — main 407.32 kB, preload 37.85 kB, renderer 970.84 kB |
| `npm run check:fit` | **283 fit, 0 skipped, 9 failed** (pre-existing `Needs Attention` issue only, confirmed unrelated — see §4) |

## 8. What only a human can check

- A card sale end to end on the pilot till at 150% scaling.
- Three toggles visible with no scroll (check:fit confirms no page/inner overflow at every size, but a human should confirm it *looks* right, not just measures right).
- The docked keyboard doesn't cover Complete Sale when the reference field is focused.
- The printed receipt shows "PAID BY CARD" and the reference line (§3b's finding: this code path was already correct before Part 2 — nothing here changed it, so this is a confirmation, not a new risk).
- End of Day shows the sale under the cashier as `card` (§3a's finding: also pre-existing and unchanged).
- The Shopify order note reads `card (ref ...)` (§3c's finding: also pre-existing and unchanged).

## Rollback

`git revert` of the Part 2 commit. No schema/data migration, no new table, no changed column — a revert leaves any card sales already recorded during the window this was live exactly as they were written (`orders.payment_method='card'` rows are not touched by reverting the code that writes them).

