# Phase 100 — Audit: an SMS/Gammu M-Pesa confirmation provider alongside Daraja

Read-only audit. **No code was changed.** The deliverable is the payment-seam
map, the gammu files-backend viability finding, the parser spec, the
real-samples requirement, and the risks.

**Why this exists:** Rubis cannot share their Daraja credentials between two
implementers, so the Enjoy Shop till needs a second way to confirm M-Pesa
payments — read the confirmation SMS off a modem holding the till's
notification SIM, and have the cashier approve the matching payment before the
sale completes. Daraja stays exactly as it is.

---

## 0. The finding that shapes everything else

**Today, in production, an M-Pesa sale completes with no verification at all.**

Three facts, each independently true in the current code:

1. `runCheckout` verifies a typed M-Pesa code **only in mock mode**
   ([checkout.ts:202](../src/main/services/checkout.ts#L202)):
   ```ts
   if (mockMpesaEnabled && input.paymentMethod === 'mpesa' && input.referenceNumber) {
   ```
2. `DarajaMpesaProvider.verifyTransactionCode` is a stub that refuses
   ([daraja-mpesa-provider.ts:244-252](../src/main/services/integrations/daraja-mpesa-provider.ts#L244-L252)):
   *"Manual M-Pesa code verification is not supported by the Daraja integration
   — use STK Push instead"*. Correct, and unavoidable: Daraja has no
   "look up this receipt" API in the STK Push scope.
3. `canCompleteSale` lets the sale through on any non-blank string
   ([checkoutMath.ts:59-69](../src/renderer/src/lib/checkoutMath.ts#L59-L69)):
   ```ts
   return (referenceNumber ?? '').trim().length > 0
   ```
   and `CheckoutModal.handleSubmit` sends whatever is in the box
   ([CheckoutModal.tsx:80-91](../src/renderer/src/components/CheckoutModal.tsx#L80-L91)).

So on a production till a cashier can type `X` into the M-Pesa reference field
and complete the sale. The STK Push path is genuinely gated — `onPaid` fires
only from the poller's `onSuccess`
([PaymentModal.tsx:127-156](../src/renderer/src/components/PaymentModal.tsx#L127-L156))
— but the manual path beside it is not gated at all, and `PaymentModal`'s
Manual Code tab hits the Daraja stub and fails, pushing cashiers to the
ungated reference field instead.

This is not a new risk introduced by this feature. It is the hole the feature
closes, and it is the reason the safety rule inverts: **the cashier-approval
gate must block.** Reported, not fixed — this audit changes no code.

---

## Part 1 — The existing payment seam

### 1.1 How a payment method is chosen

`PaymentMethod` is `'cash' | 'mpesa' | 'card'`, picked in the checkout UI.
There are two checkout surfaces and both behave the same way:

| Surface | Method choice | M-Pesa branch |
|---|---|---|
| [CheckoutModal.tsx](../src/renderer/src/components/CheckoutModal.tsx) | `method` state | embeds `<PaymentModal>` at [:215-217](../src/renderer/src/components/CheckoutModal.tsx#L215-L217) |
| [PosCheckoutPanel.tsx](../src/renderer/src/components/PosCheckoutPanel.tsx) | `method` state | embeds the same `<PaymentModal>` at [:330](../src/renderer/src/components/PosCheckoutPanel.tsx#L330) |

Both pass `onPaid`, and both check out **immediately** when it fires
([CheckoutModal.tsx:94-110](../src/renderer/src/components/CheckoutModal.tsx#L94-L110),
[PosCheckoutPanel.tsx:134-144](../src/renderer/src/components/PosCheckoutPanel.tsx#L134-L144)),
on the stated reasoning that the payment step already required explicit
confirmation. **That is the exact hook the cashier-approval gate needs** — it
is already "nothing completes until this callback fires". The SMS flow keeps
that contract and simply changes what has to happen before it fires.

### 1.2 The M-Pesa path today

Two sub-flows inside `PaymentModal`, plus a third, ungated one outside it:

| Flow | Where | Gated? |
|---|---|---|
| STK Push → poll → `onPaid` | `PaymentModal.tsx:127-191`, [mpesaPaymentPoller.ts](../src/renderer/src/lib/mpesaPaymentPoller.ts) | **yes**, on a confirmed Daraja status |
| Manual Code tab → `verifyMpesaCode` → `onPaid` | [PaymentModal.tsx:206-229](../src/renderer/src/components/PaymentModal.tsx#L206-L229) | mock only; the Daraja stub refuses |
| Plain reference-number field → Complete Sale | `CheckoutModal.tsx:87`, `:113-115` | **no** |

IPC channels ([main/index.ts](../src/main/index.ts)):

| Channel | Line | Purpose |
|---|---|---|
| `integrations:mpesa-stk-push` | :888-890 | initiate |
| `integrations:mpesa-verify-code` | :901-906 | manual code |
| `mpesa:query-status` | :960-962 | poll |
| `mpesa:log-transaction` / `mpesa:get-logs` | :917-942 | audit trail for the M-Pesa Logs screen |

### 1.3 The provider abstraction — and where a third one slots in

`MpesaProvider` ([mpesa.ts:74-96](../src/main/services/integrations/mpesa.ts#L74-L96))
has three methods: `initiateStkPush`, `verifyTransactionCode`,
`queryStkPushStatus`. Selection is an inline ternary at
[main/index.ts:568-578](../src/main/index.ts#L568-L578), driven by
`mockMpesaEnabled` resolved from DB-then-env at [:526-536](../src/main/index.ts#L526-L536).

**The key structural observation:** Daraja already implements this interface
*partially*, refusing the one method it cannot support. An SMS provider is the
**mirror image** of that same shape:

| Method | Daraja | SMS/Gammu |
|---|---|---|
| `initiateStkPush` | supported | **unsupported** — receive-only, cannot prompt |
| `verifyTransactionCode` | **unsupported** | supported — look the code up in received SMS |
| `queryStkPushStatus` | supported | **unsupported** — nothing was pushed |

So the third provider fits the existing interface without widening it, using a
pattern the codebase already established. Two changes, neither touching
Daraja:

1. **A factory**, `resolveMpesaProvider()`, mirroring
   [fiscal-provider-factory.ts:49-71](../src/main/services/fiscal-provider-factory.ts#L49-L71)
   exactly — replacing the ternary at `main/index.ts:568`. Three-way selection:
   mock / daraja / sms. `DarajaMpesaProvider` is constructed identically to
   today.
2. **A new file** `src/main/services/integrations/sms-mpesa-provider.ts`.
   `daraja-mpesa-provider.ts` is not opened.

**Cashier flow (a) — pick from a list — does not fit `MpesaProvider`**, and
should not be forced into it. It needs `listRecentUnmatched()`, which is
meaningless for Daraja and mock. That belongs in a **second, narrow interface**
(`MpesaSmsInbox`) implemented only by the SMS service and reached by its own
`mpesa-sms:*` IPC channels. Widening `MpesaProvider` with a method two of three
implementations must stub is the wrong trade.

### 1.4 How a confirmed payment completes a sale

```
PaymentModal.onPaid(reference)
  └─> CheckoutModal.handleMpesaPaid / PosCheckoutPanel.handleMpesaPaid
        └─> checkout({ paymentMethod: 'mpesa', referenceNumber, ... })
              └─> IPC → runCheckout (main/index.ts:862-872)
                    ├─ [gate] mock-only verifyTransactionCode  (checkout.ts:196-216)
                    └─ db.queueOrder(...)                       (checkout.ts:221-234)
```

`db.queueOrder` writes `reference_number` into `orders`
([database.ts:709, :724](../src/main/services/database.ts#L709); column at
[:316](../src/main/services/database.ts#L316)). **A sale is "paid" by virtue of
being persisted** — there is no separate payment-status column. So the gate has
to be *before* `queueOrder`, which is exactly where `checkout.ts:202` already
sits.

**The one checkout-side change the build will need:** `checkout.ts:202`'s
`mockMpesaEnabled &&` must become a capability flag rather than a mock flag —
otherwise unconditional verification would break real Daraja (its stub returns
`success: false`, which `:207-209` turns into a failed checkout). Cleanest
minimal shape: rename the injected dep
([checkout.ts:110-111](../src/main/services/checkout.ts#L110-L111)) from
`mockMpesaEnabled` to `verifyReferenceNumbers: boolean`, set `true` for mock
and SMS and `false` for Daraja. Daraja's behaviour then stays byte-for-byte
identical. This is the only line in the sale path that must move, and because
it is the sale path it deserves its own tests.

### 1.5 Config: where the per-till selection lives

Mirror the existing pattern, do not invent one. `integrations` is a
`provider → config_json` table
([database.ts:1430-1451](../src/main/services/database.ts#L1430-L1451)) with
`IntegrationProviderName = 'mpesa' | 'etims'`
([:407](../src/main/services/database.ts#L407)).

**Recommendation: extend the existing `mpesa` row.** No new provider name, no
new table for config:

```jsonc
{
  "consumerKey": "...", "shortcode": "...", "environment": "...", "callbackUrl": "...",
  "confirmationMethod": "daraja",       // NEW: "daraja" | "sms"
  "smsInboxPath": "C:\\gammu\\inbox"    // NEW: only read when method is "sms"
}
```

Reasons: the two methods are alternatives for the same integration, the Admin
screen already loads this row into one section
([AdminScreen.tsx:185, :194-198](../src/renderer/src/components/AdminScreen.tsx#L185)),
and a till switching methods should not leave a second orphaned row behind.
Validation goes in [ipcValidator.ts](../src/main/lib/ipcValidator.ts) beside
`etimsConfigSaveSchema` ([:302-314](../src/main/lib/ipcValidator.ts#L302-L314))
— the main process must not trust a renderer-validated path.

**No secret is involved.** Unlike Daraja and the fiscal device, this method has
nothing to put in the vault. A folder path is not a credential.

**A new table is needed for the messages themselves** — see §1.6.

### 1.6 Is the gammu-smsd FILES backend viable here?

**Yes, with three practicalities the build must handle, and one that must be
tested against the real modem before anything else is written.**

`gammu-smsd` with `Service = files` writes each received message as a text file
into `InboxPath`, named on the pattern
`IN<YYYYMMDD>_<HHMMSS>_<NN>_<sender>_<NN>.txt`. The app reads that folder. No
SQL backend, no extra service, nothing to keep in sync — which is the right
call for a single till.

**How the app reads it.** The project has **no file-watching machinery today**
— no `chokidar` dependency, no `fs.watch` anywhere in `src/main`. Adding a
watcher for this would be new surface for no gain: a folder written by another
process on Windows is exactly the case where `fs.watch` is least reliable
(missed events, duplicate events, events before the write completes). Poll it
instead, on the `setInterval` pattern already used by
[connectivityMonitor.ts:108-111](../src/main/services/connectivityMonitor.ts#L108-L111).
A 2-3 second interval is far below human tolerance at a till and costs a
`readdir` of a small folder.

**How a message is marked processed.** *Do not delete or move gammu's files.*
Two reasons: deleting races with gammu still writing, and a destroyed inbox
file is unrecoverable evidence for a money transaction. Track processed state
in SQLite instead — a new `mpesa_sms_messages` table keyed on the transaction
code, mirroring how `mpesa_transactions`
([database.ts:373-385](../src/main/services/database.ts#L373-L385)) already
serves as the M-Pesa audit trail:

```sql
CREATE TABLE IF NOT EXISTS mpesa_sms_messages (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_code     TEXT NOT NULL UNIQUE,   -- the dedup key, enforced here
  amount               REAL NOT NULL,
  payer_name           TEXT,
  payer_alias          TEXT,                   -- Jumbe variant
  masked_phone         TEXT,                   -- captured, never matched on
  occurred_at          TEXT NOT NULL,          -- normalised ISO-8601, see §2.5
  source_file          TEXT NOT NULL,
  raw_text             TEXT NOT NULL,          -- kept verbatim: this is money
  matched_order_local_id INTEGER,              -- NULL = unmatched
  approved_by_staff_id INTEGER,
  approved_at          DATETIME,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

`UNIQUE` on `transaction_code` is what makes dedup real. An in-memory set would
lose its contents on restart and re-approve an already-spent payment — a
double-credit bug. The insert should be `INSERT ... ON CONFLICT DO NOTHING`, so
re-reading the folder is free and idempotent by construction.

**The thing to test first, before writing a parser:** *multipart reassembly.*
An M-Pesa confirmation is comfortably longer than a single 160-character GSM-7
SMS, so it arrives as a concatenated multipart message. The files backend has
no guaranteed reassembly for every configuration — parts can land as separate
files. If they do, the reader must join them (gammu's `detail` inbox format
carries the part sequence) before the parser ever sees a string. **This is the
single highest-risk unknown in the whole feature**, it is invisible to unit
tests against whole sample strings, and it is cheap to settle: send one real
M-Pesa payment to the SIM and look at what appears in the folder.

**Windows / modem practicalities the app must assume**

- `gammu-smsd` runs as a Windows service and needs a COM port. Its lifecycle is
  outside the app: the app must treat "no inbox folder" and "folder present but
  nothing new for N minutes" as **visible states**, not silent emptiness. A
  cashier waiting on a payment must never be shown an empty list that means
  "the service is dead".
- **A USB GSM modem/dongle is much safer than a phone.** Most Android phones do
  not expose a standard modem interface over USB, and those that do often stop
  after an OS update. If a phone is the plan, it must be proven with gammu on
  this exact machine before the build starts.
- Encoding: read as UTF-8 and tolerate a BOM; gammu may write UCS-2 content
  depending on `InboxFormat`. Pin this from a real file.
- **Partial reads.** A file can be read mid-write. If a file does not parse and
  is younger than a few seconds, leave it and retry on the next poll rather
  than recording it as junk.
- The folder must be on local disk. A network path adds a failure mode to a
  money path for no benefit.

---

## Part 2 — Parser spec (design only)

A pure function in the renderer-agnostic `lib` style the project already uses
for [fiscalDate.ts](../src/renderer/src/lib/fiscalDate.ts) — no I/O, no clock,
no Electron, unit-tested directly.

```ts
/** One confirmed incoming M-Pesa payment, parsed from a confirmation SMS. */
export interface MpesaSmsPayment {
  /** ~10-char alphanumeric code, uppercased. THE dedup key. */
  transactionCode: string
  /** Amount in KES. */
  amount: number
  /** Payer's two names, or null on the Jumbe variant. */
  payerName: string | null
  /** Jumbe privacy alias (e.g. NK_74), or null on a normal receipt. */
  payerAlias: string | null
  /** Partial number as printed (e.g. "0722*000**"). Captured, never matched on. */
  maskedPhone: string | null
  /** Device-stated moment, normalised to ISO-8601. See 2.5. */
  occurredAt: string
  /** The message exactly as received. */
  raw: string
}

/**
 * @param {string} raw one SMS, already reassembled if it arrived multipart
 * @returns {MpesaSmsPayment | null} null for anything that is not an incoming payment
 */
export function parseMpesaPaymentSms(raw: string): MpesaSmsPayment | null
```

### 2.1 Anchors — recognise, then reject

A string is a candidate only if **all three** hold. Any one failing returns
`null` immediately.

| # | Anchor | Provisional pattern |
|---|---|---|
| 1 | opens with the code + `Confirmed.` | `/^\s*([A-Z0-9]{8,12})\s+Confirmed\./` |
| 2 | closes with the standard footer | contains `PIN YAKO SIRI YAKO` |
| 3 | is **incoming** | contains `You have received` |

Anchor 1 doubles as the code extractor. Anchor 3 is the direction filter and
carries most of the safety: it is what separates a payment from everything else
Safaricom sends.

The `{8,12}` length is deliberately loose. Research examples show both 9 and 10
characters, and I will not pin a length I have not seen in this SIM's own
messages (§3).

### 2.2 Rejection set

Everything below must return `null`, and each needs a real captured sample as a
test:

| Kind | Why it is rejected |
|---|---|
| outgoing (`You have sent`, `sent to`) | wrong direction; anchor 3 fails |
| balance alerts | no `You have received`; often no code opener |
| reversals | not a new payment; must never create a second candidate |
| airtime purchases | outgoing |
| promos / marketing | no bookends |
| delivery reports, network messages | no bookends |
| anything unrecognised | **null, never a half-parsed guess** |

The last row is the rule: a partially-matched message returns `null`. There is
no "best effort" for money.

### 2.3 Fields

| Field | Source | Notes |
|---|---|---|
| `transactionCode` | anchor 1, uppercased | dedup key |
| `amount` | `/Ksh\s?([\d,]+\.\d{2})/` | strip commas, `Number()`; reject if `NaN` or `<= 0` |
| `payerName` | between `from ` and the masked number / ` on ` | two names, uppercase in observed samples |
| `payerAlias` | Jumbe shape (§2.4) | mutually exclusive with `payerName` |
| `maskedPhone` | optional partial after the name | **never required, never matched on** |
| `occurredAt` | `on <date> at <time>` | see §2.5 |

**The phone number is not a matching field.** Since 24 March 2026 Safaricom
masks it in merchant notifications (`0722*000**`). Capture it for the cashier's
eyes and nothing else. Any design that matches on it is already broken.

### 2.4 The Jumbe variant

Merchants with Split Notifications enabled receive a privacy alias (a JumbeID
like `NK_74`) instead of a name and number. Same bookends, same code, same
amount — only the payer segment differs. The parser tries the named shape
first, then the alias shape, and sets exactly one of `payerName` / `payerAlias`.
If neither matches but all three anchors held, return `null` rather than a
payment with an unknown payer: an unrecognised payer segment means the format
moved, and this is money.

Whether Enjoy Shop has Jumbe on is **unknown** and must be established from
real messages (§3).

### 2.5 Date and time — a trap this project has already hit

M-Pesa prints `on 15/10/24 at 11:52 AM`: day-first, two-digit year,
12-hour clock. **Do not hand that to `new Date()`.** Phase-96 fixed exactly
this class of bug for fiscal timestamps — `new Date(y, m, d, ...)` silently
rolls out-of-range fields over instead of failing, so a malformed date becomes
a plausible wrong one rather than an error.

Reuse the phase-96 discipline: explicit regex, explicit range validation on
every field, and `null` on anything that does not validate. Normalise to
ISO-8601 for storage so the app has **one** timestamp format
(the recommendation phase-96 flagged for follow-up and never got).

The two-digit year needs a stated rule: `24` → `2024`. Pin the pivot
explicitly rather than relying on any runtime default.

### 2.6 Dedup

The parser is pure and stateless — it does **not** dedup. Dedup is the store's
job, enforced by `UNIQUE (transaction_code)` (§1.6) with
`INSERT ... ON CONFLICT DO NOTHING`.

This division matters: reading the same folder every 3 seconds means every
message is parsed hundreds of times, and correctness must not depend on the
reader's memory or on files being deleted. Same code = same transaction, once,
forever, across restarts.

### 2.7 The two cashier flows

Both resolve to one action: **approve this received payment for this sale.**

**(a) Pick from a list.** `mpesa-sms:list-unmatched` returns recent messages
where `matched_order_local_id IS NULL`, newest first, within a window (30
minutes is a sensible default; confirm with the branch). Each row shows amount,
payer name or alias, and time received. The cashier taps the matching one.

**(b) Look up by code.** The cashier types or scans the code; exact match,
case-insensitive, on the dedup key. Found and unmatched → same approve action.
Found but already matched → **blocked**, with a plain message naming the sale
it already paid for. Not found → "That payment has not arrived yet", not "wrong
code" — the difference matters and the cashier can act on it.

**The amount rule needs a human decision.** The safest default is: approve only
when the SMS amount equals the cart total exactly, and list mismatches greyed
out with a plain reason. It matches how `PaymentModal` already guarantees the
STK amount by construction
([PaymentModal.tsx:66-71](../src/renderer/src/components/PaymentModal.tsx#L66-L71))
— there is no editable amount for a cashier to mistype. Underpayment must never
be approvable. Whether a small overpayment may be approved, and what happens to
the difference, is a business call, not mine. **Flagged for the client, not
assumed.**

On approval: mark the row matched, then call the existing `onPaid(code)` — so
everything downstream of §1.4 is unchanged, including which column the code
lands in.

---

## Part 3 — Real samples are required before the regex is final

**The format changed on 24 March 2026 and every clean public sample predates
it.** Everything in Part 2 is derived from research: current to the best
available knowledge, and **unverified against this SIM.** Field order,
separators, the exact code length, the exact footer casing, and whether the
masked number appears at all in this merchant's notifications are all
provisional.

This is the same discipline used for the device wire everywhere else in this
project: the ZFP integration was built against captured fixtures, not a guessed
format, and phase-97/99 exist because guessing about a real endpoint is how
days get lost.

**Nothing in this document contains a real captured message.** The one string
quoted in the brief — `"BS49OR201 Confirmed. You have received Ksh50.00 from
<NAME> <NUMBER> on 15/10/24 at 11:52 AM."` — is **illustrative, pre-masking,
and from public research**, not from Enjoy Shop's SIM. It must not become a
test fixture as though it were captured.

**Samples to collect from the real notification SIM** (redact names and the
partial number; keep structure, punctuation and whitespace byte-exact):

| # | Sample | Proves |
|---|---|---|
| 1 | a normal till payment, post-masking | the happy path and the current field order |
| 2 | a second normal payment, different amount and payer | that the pattern generalises, not memorises |
| 3 | a Jumbe/alias receipt, **if** Split Notifications is on | the alternate payer shape, or that it does not apply |
| 4 | a balance alert | the filter rejects non-payments |
| 5 | a reversal | a reversal never becomes a payment candidate |
| 6 | an airtime purchase or any outgoing message | the direction filter |
| 7 | **the raw inbox files for one payment** | multipart reassembly (§1.6) — not a parser sample, a reader sample |
| 8 | an amount with a thousands separator (Ksh 1,500.00) | comma handling |

Sample 7 is the one to get first. It can invalidate the reader design; the
others only tune a regex.

Until 1-8 exist, **the parser must not be written as final** — a skeleton with
the anchors is reasonable, the field regexes are not.

---

## Part 4 — Risks and preconditions

**Physical precondition.** The modem must hold the till's **notification SIM** —
the number Safaricom sends merchant confirmations to. Any other SIM receives
nothing and every symptom looks like a software bug. Being confirmed with the
client separately; the build should not start until it is.

**SMS can be delayed by minutes.** The approval gate handles this correctly by
construction, but the UX must make waiting an explicit, readable state:
"Payment not received yet" with the amount being waited for, never an empty
list or a spinner with no explanation. **The cashier must have no way to
approve a payment whose SMS has not arrived** — there is no manual override, no
"approve anyway". That is the whole point of the gate.

**Receive-only.** This method cannot prompt for payment (no STK Push), cannot
cancel or reverse one, and cannot query Safaricom for anything. It confirms
what already happened, nothing more. Tills that need to prompt must use Daraja.

**The safety rule inverts here, deliberately.** All the fiscal work followed
"never block the till — complete the sale, reconcile later", because an unfiled
sale is recoverable. **Payment is not.** Goods released against an unconfirmed
payment are gone. So this gate blocks, and every ambiguous case resolves to
"not paid": no SMS, amount mismatch, already-matched code, unparseable message,
modem silent. Blocking a real payment costs a minute of a cashier's time;
releasing goods for an imaginary one costs the stock.

**This is money, and green unit tests prove nothing about the modem.** Two
separate verify-on-real-hardware items, neither satisfiable by the test suite:

1. **The parser** — must be validated against real captured messages (§3), not
   against strings written by whoever wrote the regex.
2. **The modem read** — must be validated by sending a real M-Pesa payment to
   the real SIM in the real modem and watching it appear, parse, and be
   approvable. Multipart reassembly, encoding, file naming and gammu's service
   lifecycle are all invisible to unit tests.

Both belong on the go-live verify list beside the fiscal device's own
outstanding items.

**Pre-existing gap named in §0.** The ungated reference-number field lets a
production M-Pesa sale complete with no verification today. It is out of scope
for this audit, it is the reason the gate must block, and if the SMS method is
adopted it should be closed for the SMS till at the same time — otherwise the
new gate sits beside an open door.

---

## Summary of what the build would touch

| File | Change | Daraja affected? |
|---|---|---|
| `integrations/sms-mpesa-provider.ts` | new | no |
| `services/mpesa-sms-inbox.ts` | new — poll, reassemble, insert | no |
| `renderer/src/lib/mpesaSms.ts` | new — the pure parser | no |
| `services/mpesa-provider-factory.ts` | new — mirrors the fiscal factory | no, constructed identically |
| `main/index.ts:568-578` | ternary → factory call | no |
| `services/checkout.ts:110-111, :202` | `mockMpesaEnabled` → `verifyReferenceNumbers` | no, `false` for Daraja |
| `services/database.ts` | new `mpesa_sms_messages` table | no |
| `lib/ipcValidator.ts` | schema for the two new config fields | no |
| `AdminScreen.tsx` | method selector + inbox path in the existing M-Pesa section | no |
| a new payment UI | the pick-or-type approval screen | no |
| `daraja-mpesa-provider.ts` | **not opened** | — |

Stopping here for review. No code changed.
