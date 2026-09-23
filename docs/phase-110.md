# Phase 110 — Part 1 (AUDIT): supporting both ZFP definition versions

Read-only. **No app code, test, fixture or config was changed in this
phase.** The baseline was re-run first and is green: 83 files, 1257 tests.

The brief locks two client decisions — support *both* defVer 2204120945
(old) and 2509041522 (new), and fail **safe** on the duplicate check. This
phase establishes what the old definitions actually contain, what that
costs us, and proposes the exact fallback. Parts 2 (implement) and 3
(test) follow after review.

> **Scope, stated plainly.** Everything below makes the *software*
> compatible with the old definitions. It does **not** touch the separate
> device-access problem ([phase-109.md](phase-109.md): both server
> versions get `0x60` busy and open no session). The old-defs path can be
> unit-tested now; it is **UNPROVEN against a real old-defs device** until
> one is reachable.

---

## 0. Where the old schema came from

No 2204120945 PDF exists locally, so the schema was read from the old
SDK's own generated client, exactly as the brief directs:

```
Rubis Etims API Files/API Files/C# Lib/FP.cs   →  public string defs = @"<Defs>…"
```

`<GenerationTimeStamp>2204120945</GenerationTimeStamp>`, confirmed
directly in that blob. The Java equivalent (`Java Lib/TremolZFP/FP.java`,
`this.setVersionDef(2204120945L)`) carries the same defs; `FP.cs` was used
because [scripts/extract-tremol-contract.mjs](../scripts/extract-tremol-contract.mjs)
already parses the C# verbatim-string shape, so the old contract was
extracted by the **same mechanical extractor** that produced the committed
`tremol-contract.json` — not retyped by hand. (The extraction ran from the
scratchpad; no new fixture was committed.)

| | Old | New (committed) |
|---|---|---|
| defVer | `2204120945` | `2509041522` |
| Commands | **91** | **122** |

91 vs 122 matches [phase-109.md](phase-109.md)'s count, independently
re-derived here rather than cited.

---

## 1. The command diff — every command this app sends

`real-etims-provider.ts` posts exactly eleven command names. Each was
checked arg-by-arg and response-field-by-response-field against the old
defs:

| Command | Old vs new | Action needed |
|---|---|---|
| `ReadStatus` | Response grows in new (19 → 22 bits); **the first 14 fields are positionally identical** | **None** |
| `ReadCUnumbers` | Identical (`0x60`, 0 args, `SerialNumber[20]`/`PINnumber[11]`) | None |
| `OpenInvoiceWithFreeCustomerData` | Identical (`0x30`, 11 args, 0 res) | None |
| `SellPLUfromExtDB` | `Price` **10 vs 15**; `OptionVATClass` **A–E vs A-only** | **Price width** |
| `SellPLUfromExtDB_HS` | `Price` **10 vs 15**; hardcoded arg renamed `reservde`→`reserved` | **Price width** |
| `ReadCurrentReceiptInfo` | VAT subtotals **11 vs 13**; `reservedN`→`reserved` | None (read-only) |
| `CloseReceipt` | Identical (`0x38`, `InvoiceNum[19]`/`QRcode[128]`) | None |
| `ReadDateTime` | Identical (`0x68`, `DateTime[10]`) | None |
| `CancelReceipt` | Identical (`0x39`, 0 args, 0 res) | None |
| `OpenCreditNoteWithFreeCustomerData` | Identical (`0x30`, 12 args) | None |
| **`ReadCUinvoiceNumber`** | **ABSENT FROM THE OLD DEFS** | **§3 — the fail-safe** |

Every argument name we send and every response field we read exists in the
old defs at the **same** `MaxLen`, with the two exceptions in bold. The
per-field evidence:

```
OpenInvoiceWithFreeCustomerData: CompanyName=30 ClientPINnum=14 HeadQuarters=30
  Address=30 PostalCodeAndCity=30 ExemptionNum=30 TraderSystemInvNum=15   [all identical]
SellPLUfromExtDB: NamePLU=36 OptionVATClass=1 Price=OLD 10/NEW 15 <<< MeasureUnit=3
  HSCode=10 HSName=20 VATGrRate=5 Quantity=10 DiscAddP=7
SellPLUfromExtDB_HS: NamePLU=36 Price=OLD 10/NEW 15 <<< HSCode=10 Quantity=10 DiscAddP=7
OpenCreditNoteWithFreeCustomerData: … RelatedInvoiceNum=19 TraderSystemInvNum=15  [identical]
```

### 1a. Confirmations the brief asked for

- **`ReadStatus` gating bits are byte-and-bit identical.** `CU_fiscalized`
  = byte 3 bit 5, `Paired_with_TIMS` = byte 4 bit 0, in **both**. The new
  defs only *insert* three later bits (`Service_contract_nearly_expired`
  @4.2, `Expired_service_contract` @5.3, `Update_is_available` @5.6),
  shifting names after index 13. We read both bits **by name** off the
  server's parsed response, so nothing changes. Confirmed, not cited.
- **`ReadVATrates`** — identical (`0x62`, 0 args, 5 res). We never send it.
- **`Subtotal`** — the brief lists its `DiscAddV` (8 vs 13) and
  `SubtotalValue` (10 vs 13) narrowing. **This app never sends `Subtotal`.**
  Verified against the provider and against
  [tests/tremolConformance.test.ts](../tests/tremolConformance.test.ts)'s
  captured command list. No action.
- **`ReadCurrentReceiptInfo` subtotals (11 vs 13)** are *response* fields,
  parsed through `Number(...)` in `sumVatGroupSubtotals`. A narrower field
  cannot break a parse. No action.
- **`SellPLUfromExtDB` VAT class.** Old accepts `A|B|C|D|E`; new accepts
  `A` only. `resolveSellCommand` sends `OptionVATClass="A"` on this command
  and routes everything else to `_HS`. `"A"` is legal under **both**, so
  our stricter routing emits valid old-defs commands. Confirmed —
  the routing needs no version branch.
- `SellPLUfromExtDB_HS`'s second argument is spelled `reservde` (a vendor
  typo) in the old defs and `reserved` in the new. It is
  `OptionHardcoded` — the *server* fills it from its own defs and we never
  send it, so the rename is invisible to us.

### 1b. Only one old command is missing from the new set

`ScanAndPrintWifiNetworks`. We don't send it. Nothing to do.

---

## 2. Field widths — `Price` is the only real one

Old: `<Arg Name="Price" Type="Decimal" MaxLen="10">` — *"Up to 10 symbols
for article's price"*, wire format `<Price[1..10]>`.
New: `MaxLen="15"` — *"up to 15 symbols … with upto 5 digits after the
decimal point"*, `<Price[1..15]>`.

Today [real-etims-provider.ts:1399](../src/main/services/integrations/real-etims-provider.ts#L1399)
does `String(unitPrice)` and *warns* past 15 without truncating —
deliberately, since silently chopping digits off money corrupts a sale.

Two things are wrong for old defs:

1. **The ceiling is 10, not 15.** A price of `1234567.891` is 11 characters
   — legal under new, over the old limit.
2. **`String()` leaks float artifacts.** `String(0.1 + 0.2)` is
   `"0.30000000000000004"` — 19 characters, invalid under *both*
   versions. The current code only warns about this.

**The brief asks whether one conservative rule can satisfy both.** It
cannot, without cost: capping everything at 10 characters would lose
precision the new path is entitled to on prices above ~10 million KES.
So the proposal is *one formatter, one version-dependent ceiling*:

- Normalize float artifacts on **both** paths (cap at 5 decimals — the
  new defs' own stated maximum — then strip trailing zeros). This is
  byte-identical for every value that is already contract-valid today,
  and only alters values the current code would have sent **invalid
  under both versions anyway**.
- Apply the ceiling for the detected version (10 old / 15 new). On old,
  if the normalized value still exceeds 10, step decimals down toward 2.
  If even 2 decimals won't fit (integer part ≥ 10,000,000), that is a
  genuine data problem — report it rather than send a mangled amount.
- The **new path keeps today's warn-and-send behaviour verbatim.**

Net effect on the new-defs path: unchanged for every valid price, proven
by the Part 3 regression test.

---

## 3. `ReadCUinvoiceNumber` — the gap, and the proposed fallback

### 3a. The gap is worse than "one missing command"

`ReadCUinvoiceNumber` is absent from 2204120945. So is **every** keyed
read-back the new defs added:

```
Only in NEW:  ReadCUinvoiceNumber            ReadEJByTraderSystemInvNum
              ReadEJByCUInvoiceNum           ReadEJByTraderSystemInvNum_JSON
              ReadEJByPINofBuyer             ReadEJByDateTime   … (+ all _JSON variants)
```

The old defs carry only `ReadEJ` (whole journal) and `ReadEJByDate`. **Not
one old command takes a `TraderSystemInvNum` as a lookup key.**

### 3b. Is there a reliable equivalent? No — and here is why each candidate fails

Every read-back the old defs do offer was examined:

| Old command | What it returns | Why it can't answer "did *this* sale file?" |
|---|---|---|
| `ReadLastAndTotalReceiptNum` (`0x71`) | `LastCUInvoiceNum[19]`, `LastReceiptNum` | **Positional, not identity-addressed.** It names the *last* receipt, whoever filed it. |
| `ReadOrStoreInvoiceCopy` (`0x7C`) | copy of an invoice | Keyed by `CUInvoiceNum` — the value we are trying to *discover*. Circular. |
| `ReadEJ` / `ReadEJByDate` | whole/date-ranged journal | Declares an **empty `<Response>`** — no parseable fields; not a structured read-back at all. |
| `InfoLastReceiptDuplicate` (`0x3A`) | — | Empty `<Response>` in *both* versions. Prints; returns nothing. |
| `ReadCurrentReceiptInfo` | state of the *open* receipt | The receipt we're asking about is closed (or never opened). |

`ReadLastAndTotalReceiptNum` is the only near-miss, and it is **unsafe in
both directions**:

- **False "already filed"** — our sale never filed, but another sale did
  last. We'd stamp someone else's CU invoice number onto our sale and mark
  it fiscalized. A real sale silently never reaches KRA.
- **False "not filed"** — our sale *did* file, then another sale filed
  after it. We'd conclude "never filed" and resend. **That is the
  double-file.**

A single till between two retries makes this unlikely; it does not make it
safe, and "unlikely" is not the standard Rule 1 is held to. **Recommendation:
do not use it.**

### 3c. The decisive finding — old defs document no duplicate protection either

The new defs state the device's own dedupe explicitly, in
`ReadCUinvoiceNumber`'s own `<FPOperation>`:

> *"Request for original invoice number in case of open receipt rejection
> due to **duplicate TRADER SYSTEM INVOICE NUMBER** and response received."*

Searching the **entire** old defs blob for that behaviour returns
**nothing** — the word "duplicate" appears once, in the unrelated command
name `InfoLastReceiptDuplicate`.

This matters more than the missing command. On new defs we have two
independent guards: the device refuses a duplicate `TraderSystemInvNum`,
*and* we can ask what it already filed. On old defs we have documentary
evidence of **neither**. We cannot assume a device-side refusal we have no
source for. A resend we cannot verify is therefore a genuine double-file
risk, not merely an unrecoverable loop.

### 3d. Proposed fallback

On old defs, when `OpenInvoiceWithFreeCustomerData` is rejected **on a
retry/resend** (`request.isRetry`) and the rejection came **from the
device** (it saw the command and refused it):

> resolve to `{ ok: false, kind: 'system', retryable: false }`.

That routes through the **existing** needs-attention machinery, unchanged
— [fiscal-routing.ts](../src/main/services/fiscal-routing.ts)
`routeFiscalOutcome` maps `retryable: false` to `fiscal_status =
'needs_fixing'` with `enqueue: false`, which is exactly:

- surfaced on the **Needs Attention** page
  ([database.ts:1229](../src/main/services/database.ts#L1229)),
- counted by the **unfiled-sales badge**
  ([database.ts:1246](../src/main/services/database.ts#L1246)),
- **never placed in `sync_queue`**, so `fiscal-engine.ts` can never drain
  it, and no automatic resend is possible.

No new status, no new table, no new UI. The flag *is* "never re-filed" —
structurally, not by convention.

### 3e. One decision I need confirmed before implementing

The recovery step currently runs for **any** `OpenInvoice` failure on a
retry, including pure transport failures — Code 19/30/31/53, where the
ZFPLabServer never opened a session and **the device never saw the
command at all**.

Those are not ambiguous. Nothing was filed on this attempt, and our
knowledge of the sale is exactly what it was before it. Flagging them
would mean **every network blip on any queued sale becomes a human
ticket**, and the retry queue stops working on old defs.

So my recommendation is the **narrow** rule:

- Device-level rejection on a retry (the shape a duplicate produces) → **flag.**
- Server/transport failure on a retry (`serverFailure` set — 19/30/31/53) →
  route as today: `technical`/`retryable` → `waiting` → queued.

This still satisfies "never re-file what we cannot verify", because a
transport failure is not an unverified *filing* — it is a non-event.

The **broad** alternative (flag every retry failure on old defs, transport
included) is strictly safer in the abstract and materially worse
operationally. **I'll implement the narrow rule unless you say otherwise.**

---

## 4. Version selection — and a reliability finding

`settings()` echoes `<defVer>`, already parsed in
[http-client.ts](../src/main/services/integrations/http-client.ts):
`checkDefVersion` reduces it to `'match' | 'mismatch' | 'unknown'`, and the
raw value is on `result.data.defVer`. Both are available to the provider
today.

**Finding: detection is reliable when present, but `'unknown'` is real.**

- Live, new server (1.9.6): `defVer=2509041522` — [phase-97.md](phase-97.md) §3.1.
- Live, old server (1.8.2): `defVer=2204120945` — [phase-109.md](phase-109.md) §2.
- **But** the committed real capture
  [tests/fixtures/wire/settings-ok.xml](../tests/fixtures/wire/settings-ok.xml)
  has `<defVer></defVer>` blank on `servVer 1.8.2`, and per
  [KNOWN_GAPS.md](KNOWN_GAPS.md) *every* capture before phase-97 was blank.
  Every test and the mock server run at `'unknown'` today.

So a blank `defVer` from an old-defs server is a state that has actually
been observed. Selecting purely on `defVer === '2204120945'` would send
such a server down the **new** path and straight into the gap this phase
exists to close.

**I do not recommend a manual config toggle.** A toggle can be set wrong,
silently, by the person least able to check it — and a wrong toggle
re-opens the double-file hole. A capability probe cannot: its only three
outcomes are *verified filed*, *verified not filed*, and *unverifiable →
flag*. Proposed selector:

| `defVer` | Duplicate-recovery behaviour |
|---|---|
| `2509041522` (match) | **Exactly as today.** Call `ReadCUinvoiceNumber`; byte-for-byte unchanged. |
| `2204120945` (known old) | Never call it. Device-level rejection on a retry → **flag**. |
| blank / anything else | Attempt it. Positive number → recovered (as today). Explicit not-found → genuine failure (as today). Call itself **rejected/unsupported** → treat as old → **flag**. |

The third row is the only new judgement, and it fails in the safe
direction by construction.

`Price`'s ceiling uses the same selector: 10 when `defVer` is the known-old
stamp, 15 otherwise (preserving today's new-path behaviour on blank).

---

## 5. What Part 2 will change

| File | Change |
|---|---|
| `http-client.ts` | Export the old defVer stamp; a small helper answering "does this defVer have `ReadCUinvoiceNumber`?" |
| `real-etims-provider.ts` | Version-aware duplicate recovery (§3d/§4); version-aware `Price` ceiling (§2); JSDoc on everything touched; useless comments removed |
| `etims.ts` | Carry the resolved defVer/capability where needed |

Nothing else. `resolveSellCommand`, `ReadStatus` parsing,
`OpenInvoice`/`CloseReceipt`/`CancelReceipt`/`ReadCUnumbers`/`ReadDateTime`
arg building, and the `Subtotal`/`ReadVATrates` non-paths are confirmed
identical and will not be touched.

## 6. The four rules, as they stand after this audit

| Rule | Old defs | Note |
|---|---|---|
| 1 — never file twice | **At risk; §3d closes it** | The one this phase exists for |
| 2 — never fake a QR/invoice number | Unaffected | The flag path returns no invoice number at all, so there is nothing to fake |
| 3 — an unfiled sale is always visible | Unaffected, and reinforced | `needs_fixing` is already counted by the unfiled badge |
| 4 — never block the sale | Unaffected | Flagging happens after the sale completes, in the retry path |

---

## STOP — awaiting review

Confirm §3e (narrow vs broad flagging) and §4 (probe, no manual toggle),
and I'll implement Part 2.
