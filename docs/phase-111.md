# Phase 111 — Supporting both ZFP definition versions, fail-safe on the duplicate check

Parts 2 (implement) and 3 (test) of the brief whose audit is
[phase-110.md](phase-110.md). That phase read the old schema and proposed
the fallback; this one builds and tests it. The two decisions it stopped
for were confirmed: **flag device rejections only**, and **capability
probe, no manual toggle**.

`npm test` 84 files / **1286 tests** passing (was 83 / 1257).
`npm run typecheck` clean, node and web.

> ## VERIFY-AGAINST-REAL-OLD-DEVICE
>
> This makes the **software** compatible with `defVer=2204120945`. It does
> **not** resolve the separate device-access problem — both server
> versions still get `0x60` busy and open no session
> ([phase-109.md](phase-109.md)). The old-defs path is unit-tested against
> the vendor's own definitions; **it has never run against a real
> old-defs device.** Do not report it as working live.

---

## 1. The old-vs-new command diff

Extracted mechanically from the old SDK's own defs blob
(`API Files/C# Lib/FP.cs`, `<GenerationTimeStamp>2204120945`) by the same
`scripts/extract-tremol-contract.mjs` that produces the newer fixture, so
neither side is hand-transcribed. **91 commands against 122.**

Of the eleven commands this app sends, **every argument name, every
response field and every width is identical under both** — with two
exceptions:

| Command | Old vs new | Handled by |
|---|---|---|
| `ReadStatus` | Response grows 19 → 22 bits; first 14 positionally identical | — |
| `ReadCUnumbers` | Identical | — |
| `OpenInvoiceWithFreeCustomerData` | Identical (11 args) | — |
| `SellPLUfromExtDB` | **`Price` 10 vs 15**; `OptionVATClass` A–E vs A-only | §4 |
| `SellPLUfromExtDB_HS` | **`Price` 10 vs 15** | §4 |
| `ReadCurrentReceiptInfo` | VAT subtotals 11 vs 13 (response only) | — |
| `CloseReceipt` | Identical | — |
| `ReadDateTime` | Identical | — |
| `CancelReceipt` | Identical | — |
| `OpenCreditNoteWithFreeCustomerData` | Identical (12 args) | — |
| **`ReadCUinvoiceNumber`** | **Absent from the old defs** | §3 |

Confirmed rather than assumed, per the brief:

- **`ReadStatus` gating bits are byte-and-bit identical** — `CU_fiscalized`
  byte 3 bit 5, `Paired_with_TIMS` byte 4 bit 0, in both. The newer defs
  only *insert* later bits. We read both by name, so nothing changed.
- **`ReadVATrates`** identical; we never send it.
- **`Subtotal`** — the brief flagged its `DiscAddV` (8 vs 13) and
  `SubtotalValue` (10 vs 13) narrowing. **This app never sends
  `Subtotal`.** No change was needed or made.
- **`ReadCurrentReceiptInfo`'s narrower subtotals** are response fields
  parsed through `Number(...)`. A narrower field cannot break a parse.
- **VAT-class routing is valid under both.** The old defs widen
  `SellPLUfromExtDB`'s `OptionVATClass` to `A`–`E`; we send `A` on that
  command and route everything else to `_HS`, which is stricter than the
  old contract requires and legal under either. `resolveSellCommand` was
  **not** version-branched — only its doc comment was corrected, since it
  claimed to be valid for the newer defs only.

Both contracts are now committed and **self-identifying** — the extractor
records each blob's own `<GenerationTimeStamp>` as `defVersion`, so a
fixture states which version it is instead of relying on its filename:

```
tests/fixtures/tremol-contract.json       defVersion 2509041522,  122 commands
tests/fixtures/tremol-old-contract.json   defVersion 2204120945,   91 commands
```

Regenerating the newer fixture produced a **one-line diff** (the added
`defVersion`) and no change at all to `tremol-defs.xml` — the extractor
change is provably non-destructive.

---

## 2. Version selection

`settings()` echoes `<defVer>`; `http-client.ts` already parsed it. Added
there:

```ts
export const OLD_DEF_VERSION = '2204120945'
export type DuplicateRecoverySupport = 'available' | 'absent' | 'unknown'
export function resolveDuplicateRecoverySupport(defVer): DuplicateRecoverySupport
```

Three-state, deliberately not a boolean. A **blank `<defVer>` from an
old-defs server is a real captured state**, not a hypothetical — the
committed `settings-ok.xml` has one, on `servVer 1.8.2` — so "not known to
be new" and "known to be old" must stay distinguishable.

| `defVer` | Duplicate recovery | `Price` ceiling |
|---|---|---|
| `2509041522` | Unchanged: call `ReadCUinvoiceNumber` | 15 |
| `2204120945` | Never call it; §3 fail-safe | **10** |
| blank / other | Probe, then fail safe (§3) | 15 |

**No manual toggle was added**, per the confirmed decision. A toggle can
be set wrong, silently, by the person least able to check it, and a wrong
toggle re-opens the hole this work exists to close. The probe cannot: its
only outcomes are *verified filed*, *verified not filed*, and
*unverifiable → flag*.

One accuracy fix came with this: on the old defs `checkDefVersion` returns
`'mismatch'`, and `getSettings` used to warn that commands "may be
rejected or misrouted". That is no longer true, so the old version now
gets its own message naming what actually differs and carrying the
VERIFY-AGAINST-REAL-OLD-DEVICE caveat. `defVerStatus` semantics are
unchanged (it is surfaced on every `FiscalInvoiceResult`).

---

## 3. The fail-safe fallback, and why it cannot double-file

### 3a. No reliable read-back exists on the old defs

The brief asked for a genuine equivalent to be used if one existed. There
is none. The old defs declare **no command keyed by `TraderSystemInvNum`**
— `ReadCUinvoiceNumber` and every `ReadEJBy*` variant are newer additions.
Each candidate and why it fails is in [phase-110.md](phase-110.md) §3b;
the near-miss is `ReadLastAndTotalReceiptNum`, which names the *last*
receipt filed by whoever filed it, and is unsafe in **both** directions —
it can report a sale filed that never was, or unfiled when it was.

**The decisive finding:** the old defs document no duplicate
`TraderSystemInvNum` protection *either*. The newer defs state it
explicitly, in `ReadCUinvoiceNumber`'s own operation text; the entire old
blob contains the word "duplicate" exactly once, in the unrelated command
name `InfoLastReceiptDuplicate`. So on the old definitions we have
evidence of **neither** guard — an unverified resend is a real
double-file risk, not merely a loop.

### 3b. What was built

`RealFiscalizationProvider.verifyAlreadyFiled` now owns the whole
question, returning one of three verdicts:

| Verdict | Action |
|---|---|
| `'already-filed'` | Report the CU invoice number; send nothing further |
| `'genuine-failure'` | Route the original `OpenInvoice` rejection normally |
| `'unverifiable'` | **Flag for a person; never resend** |

`'unverifiable'` returns `{ ok: false, kind: 'system', retryable: false }`.

### 3c. Why it cannot double-file

The flag routes through the **existing** needs-attention machinery — no
new status, no new table, no new UI. `routeFiscalOutcome` maps
`retryable: false` to `status: 'needs_fixing', enqueue: false`, and that
single fact is the guarantee:

- `enqueue: false` → the request **never enters `sync_queue`**, so
  `fiscal-engine.ts` has nothing to drain and **no automatic resend is
  reachable at all**. This is structural, not a convention someone has to
  remember.
- `needs_fixing` → the sale appears on the **Needs Attention** page and is
  counted by the **unfiled-sales badge** (Rule 3 holds).
- A person who checks the device and finds it *was not* filed can resend
  from that page, and it files normally — `OpenInvoice` only gets rejected
  if it *was* already filed, so the flag cannot become a dead end.

Asserted directly, not argued: `routeFiscalOutcome(result)` is checked to
equal `{ status: 'needs_fixing', enqueue: false }`, and the command log is
asserted to contain **no** `SellPLUfromExtDB`, `SellPLUfromExtDB_HS` or
`CloseReceipt`.

### 3d. The narrow rule (confirmed decision)

A **transport** failure on a retry — a server-level `serverFailure`, Codes
19/30/31/53 — means no session opened and **the device never saw the
attempt**. Nothing was filed by it, and what we know about the sale is
exactly what we knew before: a non-event, not an unverified filing. Those
keep normal retry routing (`waiting`, enqueued). Without this, every
network blip on a queued sale would become a support ticket and the retry
queue would stop working on old-defs tills.

Only a **device-level** rejection — the device saw the command and refused
it, which is the shape a duplicate arrives in — is treated as
unverifiable.

### 3e. The operator message

The reason string is rendered verbatim on the Needs Attention page, so it
follows that screen's copy rules — plain language, no device codes, no
protocol jargon, and it names the one action required:

> This sale was sent to the tax device again and the device refused it.
> The device cannot tell us whether this sale was already filed, so it was
> NOT sent a second time. Check on the device whether this sale is already
> filed before filing it again.

The machine-readable detail (the device's rejection, the `defVer`, why
verification was impossible) goes to the logger instead. A test asserts
the copy contains no `defVer` / `ReadCUinvoiceNumber` / `Code N` / `STEn`.

---

## 4. Field-width handling

`Price` is the only argument width the old defs narrow on anything we
send: **10 characters, not 15**.

The brief asked whether one conservative rule could serve both. It cannot
without cost — capping everything at 10 would lose precision the newer
path is entitled to above ~10 million KES. So: **one formatter, one
version-resolved ceiling.**

1. **Normalize, identically on both paths.** `String(unitPrice)` leaks
   binary-float artifacts — `String(0.1 + 0.2)` is
   `"0.30000000000000004"`, 19 characters, invalid under *both* versions,
   and the old code only warned about it. Rounding to 5 decimals (the
   newer defs' own stated maximum) and dropping trailing zeros removes
   those while leaving **every already-valid price byte-identical**.
2. **Fit, only if still over the ceiling**: step decimals down toward 2.
   Digits are never truncated — the existing refusal to chop money is
   preserved — so a price whose whole-unit part cannot fit is sent as-is
   with a warning, for the device to reject rather than silently
   mis-record.

| Price | Old defs (10) | New defs (15) |
|---|---|---|
| `60`, `80`, `150`, `12.5`, `19.99` | unchanged | unchanged |
| `1234567.891` | `1234567.89` | `1234567.891` |
| `0.1 + 0.2` | `0.3` | `0.3` (was 19 chars) |

The newer path's wire bytes are unchanged for every legitimate price —
asserted, not asserted-to-be.

---

## 5. The tests

New file `tests/defVersionCompatibility.test.ts` — **29 tests**, driving
the real provider against a server echoing each `defVer`.

**Old path**
- Files a sale end to end; exact command sequence asserted; **never sends
  `ReadCUinvoiceNumber`**.
- **Mechanical width conformance**: every command and `<Arg>` the provider
  posts is checked against `tremol-old-contract.json` — the name must
  exist in the *old* defs and **every value must fit its old `MaxLen`**.
  This is the "widths fit old maxima" guard, against the extracted
  contract rather than hand-typed constants.
- Recognized as the older definitions, not reported as unsupported.

**The fail-safe**
- An unverifiable retry is flagged: `kind: 'system'`, `retryable: false`.
- No `ReadCUinvoiceNumber`, no `SellPLU`, no `CloseReceipt` — never re-filed.
- `routeFiscalOutcome` → `needs_fixing` / `enqueue: false`.
- The copy is plain language and jargon-free.
- A **first attempt** is not flagged — a never-filed sale still routes as
  an ordinary rejection.
- A **transport failure** on a retry is not flagged — stays `waiting`,
  enqueued (§3d).

**Blank-defVer probe**
- Refused `ReadCUinvoiceNumber` → flagged.
- A real invoice number → recovered, as today.
- Explicit not-found → genuine failure, as today.

**New-defs regression (the 2509041522 path is unchanged)**
- Same command sequence; `defVerStatus: 'match'`; **no warning emitted**.
- **Byte-identical `SellPLUfromExtDB` arguments**, asserted as an exact
  ordered list.
- Already-filed recovery through `ReadCUinvoiceNumber` still works, with
  no second filing and an empty QR.
- **The unverifiable flag is unreachable** on these definitions — checked
  against both a transport failure and a rejected recovery call.

**Contract guards**
- Each fixture is the version it claims (`defVersion`, 122 vs 91).
- `ReadCUinvoiceNumber` exists **only** in the newer contract.
- `Price` is 15 there and 10 in the old one.

One pre-existing test moved: `realEtimsProvider.test.ts`'s *"when
`ReadCUinvoiceNumber` itself errors, the ORIGINAL rejection is still
reported"* ran at a blank `defVer`, which is now the probe's territory. It
is pinned to `2509041522`, where it is exactly the new-path regression the
brief requires; the blank case has its own test.

**Mutation-checked.** Forcing `resolveDuplicateRecoverySupport` to always
return `'available'` fails four of the fail-safe tests. They are
load-bearing, not decoration.

---

## 6. The four rules, on both versions

| Rule | New defs | Old defs |
|---|---|---|
| 1 — never file twice | Unchanged: `ReadCUinvoiceNumber` recovery | **Held by the flag** — unverifiable retries are never enqueued, so no automatic resend exists |
| 2 — never fake a QR / invoice number | Unchanged (recovery returns an empty QR, never a guess) | Held — the flag returns no invoice number at all, so there is nothing to fake |
| 3 — an unfiled sale is always visible | Unchanged | Held and reinforced — `needs_fixing` is on the Needs Attention page and in the unfiled badge |
| 4 — never block the sale | Unchanged | Held — flagging happens in the retry path, after the sale completed |

---

## 7. What changed

| File | Change |
|---|---|
| `http-client.ts` | `OLD_DEF_VERSION`, `DuplicateRecoverySupport`, `resolveDuplicateRecoverySupport`; accurate old-defs warning |
| `real-etims-provider.ts` | `verifyAlreadyFiled` (the fail-safe), `UNVERIFIABLE_RETRY_REASON`, version-resolved `Price` ceiling, `formatPrice`/`formatDecimal` |
| `etims.ts` | `FiscalFailureKind`'s `'system'` doc widened to cover the flag |
| `scripts/extract-tremol-contract.mjs` | Optional output basename; records each blob's `defVersion` |
| `tests/fixtures/tremol-old-{contract.json,defs.xml}` | New — the old defs, mechanically extracted |
| `tests/fixtures/tremol-contract.json` | Regenerated: `defVersion` line only |
| `tests/defVersionCompatibility.test.ts` | New — 29 tests |
| `tests/realEtimsProvider.test.ts` | One test pinned to the new defVer; `makeSettingsGet` helper |

Untouched, having been confirmed identical: `resolveSellCommand`'s
routing, `ReadStatus` parsing, and the `OpenInvoice` / `CloseReceipt` /
`CancelReceipt` / `ReadCUnumbers` / `ReadDateTime` argument builders.

**Comment hygiene.** Every comment added is JSDoc with
`@param`/`@returns`, and the "why" for the fallback lives in
`verifyAlreadyFiled`'s JSDoc rather than as inline chatter. Two existing
defects were fixed in passing: a `// VERIFY-ON-DEVICE:` line sitting
inside a JSDoc block (now proper JSDoc prose), and a large explanatory
comment block floating mid-function above the recovery branch (folded into
the new method's JSDoc). The named categories — commented-out code, stale
`TODO`/`DEBUG`, decorative separators — **are not present in these files**;
the remaining inline comments are substantive rationale and step markers
in a 250-line protocol method, so they were left alone rather than
stripped for their own sake. No repo-wide sweep.
