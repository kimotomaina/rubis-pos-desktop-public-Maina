# Phase 61 / Chunk 0 — Full read-only audit of current reality

Read-only. **No code was changed.** Every wire claim below was confirmed
against a primary source in this pass (protocol defs / `fp_core.js` /
`tremol-contract.json` / captured fixtures), not from the brief alone.

## What was read

- `docs/` — newest is `phase-60.md`, plus `KNOWN_GAPS.md` (both read in full).
  57 phase docs total; nothing newer than phase-60 existed at the time of
  this audit.
- `tracker/` — `SDK_RECON.md`, `full_scope.md` (present, unchanged).
- Source: `real-etims-provider.ts`, `http-client.ts`, `xml-utils.ts`,
  `etims.ts`, `fiscal-engine.ts`, `src/renderer/src/lib/etimsConfig.ts`,
  `src/main/index.ts` (provider construction, ~L480-570),
  `database.ts` (schema/migration/queue surfaces).
- Ground truth: `Libs/JS/fp_core.js` L55-147 (error + success parse loops),
  `tests/fixtures/tremol-contract.json` (122 commands), all 6 files in
  `tests/fixtures/wire/` (as they existed before this phase).
- Config: `.env` (key names only — no values echoed), `.env.example`, `.gitignore`.

---

## 1. Confirmed: the coded sale sequence

Matches §4.6 of the brief exactly, as implemented in
`RealFiscalizationProvider.submitInvoice` (logged as `Step N/7`):

1. `settings()` — via `ensureSettings()`, cached in `settingsPromise`, **once
   per session**, cleared on Code 53 and on `closeServerConnection()`. Confirmed
   not per-sale.
2. `ReadStatus` — reachability + status gate.
3. `OpenInvoiceWithFreeCustomerData` — 7 caller args, correct order, leaders not sent.
4. `SellPLUfromExtDB` (class A) / `SellPLUfromExtDB_HS` (all other classes), per line.
5. `ReadCurrentReceiptInfo` — VAT-sum gate.
6. `CloseReceipt` → `InvoiceNum` + `QRcode`.
7. `ReadDateTime` — best-effort; falls back to local clock with
   `fiscalizedAtSource: 'local-fallback'`.

Rollback: any failure from step 3 onward fires a best-effort `CancelReceipt`.
Shutdown: `closeServerConnection()` → `clientremove(who=me)`, wired in `index.ts`.

**No drift found in the sequence itself.**

---

## 2. RESOLVED EARLY: the Chunk 1 Step-0 unknown — ENVELOPE_A holds

`fp_core.js:83-147` (`analyzeResponse`), read verbatim:

```js
var resRoot = resp.getElementsByTagName("Res")[0];
var props   = resRoot.getElementsByTagName("Res");   // child <Res> elements
... prop.getAttribute("Type") / ("Name") / ("Value")
if (p === 1) { return resultObj[name]; }             // single field -> bare scalar
```

**ENVELOPE_A is CONFIRMED**: root `<Res Code="0">` with one child
`<Res Name="X" Value="Y" Type="T"/>` per field. The existing
`tests/fixtures/wire/readstatus-ok-healthy.xml` already uses exactly this skin.

Parse rules confirmed in the same loop, with three details the brief states
loosely and one it gets wrong:

- Skips are by **`name === "Reserve"`** *or* **`Type` of `Reserve`/`OptionHardcoded`**.
  Our contract names those fields `reserved` (lowercase), so they are skipped
  **by type**, not by name — the fixtures must carry `Type="OptionHardcoded"`
  or they will not be skipped.
- `Value="@"` → `null` and **`break`s the entire loop** (not `continue`). Any
  field after an `@` is silently dropped. Worth one regression test.
- `Type="Status"` → `value === "1"` boolean; `DateTime` → `dd-MM-yyyy HH:mm:ss`. Confirmed.
- The scalar rule is `p === props.length === 1`, i.e. a genuinely
  single-child response. `ReadCUinvoiceNumber` has **two** children
  (`Option` hardcoded + `CU_InvoiceNumber`), so it returns an **object**, not a
  scalar, even though only one field survives the skip.

### Error envelope — brief's Appendix A.3 is wrong on nesting

`fp_core.js:64-81` (`throwOnServerError`) reads `Message` via
`resp.getElementsByTagName("Message")[0]` — nesting-agnostic. But all three real
captured fixtures put `<Message>` **inside** `<Err>`:

```xml
<Res Code="30"><Err Source="Server" Type="ServSockConnectionFailed"><Message>Socket connect FAILED</Message></Err></Res>
```

Appendix A.3 shows `<Err/>` and `<Message>` as **siblings**. The captures win.
Fixtures should be built as `<Err Source="Server" Type="…"><Message>…</Message></Err>`.

**STE codes are hex, and `parseInt(x, 16)` proves it** (`fp_core.js:72-74`).
This is the source of finding 4.1 below.

---

## 3. Credentials seam — materially different from the brief's assumption

The brief (§6) assumes the device values are hardcoded constants to be extracted
into `.env`. **That is only half true.** The real resolution order today
(`index.ts:534-560`) is:

```
db.getIntegrationConfig('etims')  →  { baseUrl, endpoints, defaultVatClass,
                                       password, deviceIp, devicePort }
        ↓ (each field, if blank/undefined)
RealFiscalizationProvider constructor defaults  →  DEFAULT_DEVICE_IP /
        DEFAULT_DEVICE_PORT / DEFAULT_DEVICE_PASSWORD  (http-client.ts:38-44)
```

- The device IP/port/password are **configured through the Admin screen**
  (Admin → Integrations, `AdminScreen.tsx:1133`) and stored in the SQLite
  `integrations` table. **No eTIMS env var is read anywhere** except
  `VITE_USE_MOCK_ETIMS`.
- Hardcoded fallbacks confirmed in `http-client.ts`:
  `DEFAULT_DEVICE_IP = '154.79.253.236'`, `DEFAULT_DEVICE_PORT = '8000'`,
  `DEFAULT_DEVICE_PASSWORD = 'Password'`. `etimsConfig.ts` (renderer) duplicates
  the IP/port constants for the Admin form.
- `.env.example` documents **no** `ETIMS_DEVICE_*` keys. `.env` has none either.
  Confirmed by key-name scan.

**Security note for Chunk 7:** the device TCP password is stored in the
**plaintext `integrations` table**, whereas the two M-Pesa secrets
(`consumerSecret`, `passkey`) are deliberately kept in the OS-encrypted vault
(`secretStore.ts` / keytar) precisely because they can authorize a transaction
(`index.ts:504-521`). The TCP password is the same class of secret and is
currently the weaker of the two. Recommend Chunk 7 route it through the existing
vault, with `process.env.ETIMS_DEVICE_TCP_PASSWORD` as the fallback — exactly
mirroring the established M-Pesa pattern rather than inventing a new one.

`.gitignore` is correct: `.env` and `.env*` ignored, `!.env.example` re-included.
**No real secret is tracked.** (`.env` does hold live Shopify/M-Pesa values —
untracked, but §6a's rotation advice stands if it has ever been shared.)

---

## 4. Drift and defects found (ranked)

### 4.1 — REAL BUG: device error codes are matched in decimal against a hex wire

`mapFiscalDeviceError` (`real-etims-provider.ts:216-235`) keys on
`'52' '58' '59' '60' '61' '62'`. The device sends STE2 as **hex**
(`fp_core.js:72-74` does `parseInt(…, 16)`; PDF §1.2.1 lists `3a`–`40`).
`checkDeviceResponse` passes `data.STE2` through **raw, unconverted**
(`:265`). So:

| Wire STE2 | Decimal | Table key | Matches? |
|---|---|---|---|
| `34` (syntax error) | 52 | `'52'` | ✗ |
| `3a` (invoice not found) | 58 | `'58'` | ✗ |
| `3b` (wrong client PIN) | 59 | `'59'` | ✗ |
| `3c` (missing item) | 60 | `'60'` | ✗ |
| `3d` (qty too large) | 61 | `'61'` | ✗ |
| `3e` (amount too large) | 62 | `'62'` | ✗ |

**Every device business error falls to the `default` branch.** Consequence
beyond bad messages: the Code-52 recovery in `submitInvoice:376`
(`openResult.code === '52'`) can **never fire** — the device sends `34`. The
"cancel and retry once on an already-open receipt" path is dead code today.

Note also the table's semantics are shifted relative to §4.4: `'58'` is mapped
to "Invalid RIN" but `0x3a`/58 is *invoice number not found*. Both the radix and
the mapping need reconciling against the PDF in Chunk 4/6.

*This was not in `KNOWN_GAPS.md` and is not listed in the brief. It is
mock-testable and device-independent.* **Not fixed — audit only.** (Later
escalated to a more severe finding — see
[phase-62.md](phase-62.md)'s finding 4.1b: the STE fields aren't extracted by
the parser at all, independent of radix.)

### 4.2 — Code 19 is misclassified as a device error (brief gap #2, confirmed)

`mapFiscalServerError` has no `'19'` case → returns `undefined` → control falls
to the device branch → `mapFiscalDeviceError('19', …)` → `default`. Result:
`"Fiscal device error (Code 19): <raw message>"`, **`retryable: false`**, and it
is not recognized as transient. Per §4.3 it should queue like Code 30. Confirmed
exactly as the brief describes.

### 4.3 — Dead timeout config (brief gap #3, confirmed)

`createFiscalHttpClient` honours `options.timeoutMs` on the axios instance
(`:112`), but **both** call sites override it per-request with the constant:
`postXml` (`:232`) and `sendGet` (`:261`) pass
`timeout: ETIMS_REQUEST_TIMEOUT_MS`. So `timeoutMs` is dead in every real path.
Confirmed.

### 4.4 — Appendix A field name is wrong; the provider is right

Brief Appendix A specifies `IsReceiptOpened`. The contract declares
**`OptionIsReceiptOpened`** (`Type="Option"`, maxLen 1) and the provider reads
that name (`:412`). Per the brief's own rule ("contract wins on exact strings"),
**the fixtures must use `OptionIsReceiptOpened`**. Same for
`OptionReceiptFormat`, `OptionClientReceipt`, `OptionPowerDownInReceipt` —
Appendix A names them without the `Option` prefix. Contract names verified
field-by-field.

### 4.5 — `ReadStatus` gate checks 2 of the 3 named bits

Provider checks `CU_fiscalized` and `Paired_with_TIMS` (`:636-654`); it does not
check `CU_produced`, which §4.5 lists as part of "fiscalized & paired". Both
present bits are correctly named and present in the 22-flag contract response.
Low severity — flagging for a Chunk 6 decision, not obviously wrong.

### 4.6 — `readstatus-live-captured-code19.xml` has an anomalous shape

It carries `errSource="Server"` as an attribute **on `<Res>`** and has **no
`<Err>` element** — unlike the other three error captures, which use
`<Err Source="Server" Type="…">`. Our parser's `errSource` regex
(`xml-utils.ts:134`) looks for `Source=` on `<Err>`, so it does **not** populate
`errSource` from this fixture. Either the server genuinely emits a different
shape for Code 19, or the fixture was hand-edited during capture.
**`VERIFY-ON-DEVICE`** — do not build Code-19 handling on this shape alone.

### 4.7 — Grep results for the phase-60 regressions: all clean

`application/xml` appears only as the `Accept` header (correct — the vendor
client sends it). **No** occurrences of a bare `SubTotal`, `Connected`, or
`Fiscalized` field, and **no** `OpenCreditNote"` without
`WithFreeCustomerData`. The five phases' worth of invented fields are gone.

---

## 5. Failure → queue path (confirmed working)

`sync_queue` with `entity_type = 'etims_invoice'` (`database.ts:657`), drained by
`fiscal-engine.ts` on three triggers (post-checkout, 30 s interval, offline→online),
with exponential backoff and exhausted-items-retained. Deliberately **not** gated
on `net.isOnline()` — correct, since the device is LAN-local. The queued
`payload_json` is the full `FiscalInvoiceRequest`. A voided sale purges its queue
rows (`:992`).

---

## 6. Answers to §11's open questions, from evidence

**Q1 — which table for the credit-note customer block?** `orders`. It already
carries `fiscal_invoice_number`, `fiscal_qr_code`, `fiscal_fiscalized_at`
(`database.ts:232-234`), indexed on the invoice number (`:249`), with an
idempotent migration helper already in place — `migrateOrdersFiscalColumns`
(`:193-198`, called at `:444`) does `ALTER TABLE orders ADD COLUMN <x> TEXT`
guarded against re-runs. Extending *that* array is the KISS move; no new table,
no new migration mechanism.
*Decision needed:* the six customer fields may already be recoverable from
`orders.payload_json` — if so, no migration is needed at all. I did not confirm
whether the checkout payload persists the buyer block. Worth one check before
Chunk 4 writes a migration.

**Q2 — env var names/placement.** Recommend keeping the DB-first resolution and
adding env as the fallback layer (mirroring M-Pesa), i.e.
`etimsConfig.deviceIp || process.env.ETIMS_DEVICE_IP || DEFAULT_DEVICE_IP`.
Password should additionally go through the keytar vault (see §3). Needs your
confirmation before Chunk 7.

**Q3 (M-Pesa production) and Q4 (redistribution licensing)** — unchanged, still
need your answer; nothing in the code decides them.

---

## 7. What each later chunk must now change

- **Chunk 1** — Step 0 is already answered (ENVELOPE_A, §2 above). Remaining work
  is materializing fixtures, with three corrections to Appendix A: contract
  field names (`OptionIsReceiptOpened` etc.), `<Message>` nested inside `<Err>`,
  and `Type` attributes present so the skip rules actually exercise. See
  [phase-62.md](phase-62.md) for that work.
- **Chunk 2/3** — unchanged in shape. Add a case for the `@`-breaks-the-loop rule
  and for `ReadCUinvoiceNumber` returning an object rather than a scalar.
- **Chunk 4** — now has **five** items, not four: the hex/decimal STE2 bug (4.1)
  joins the list, and it also resurrects the dead Code-52 retry path. (Further
  escalated in phase-62.md's 4.1b.)
- **Chunk 7** — is not a simple "extract constants to env": it must layer env
  *under* the existing Admin/DB config, and should move the TCP password into
  the existing encrypted vault rather than leaving it in a plaintext table.

---

## 8. Status

- **Nothing applied.** Read-only, as required.
- **New gap found and not yet in `KNOWN_GAPS.md`:** 4.1 (hex/decimal STE2).
- **`VERIFY-ON-DEVICE` added:** 4.6 (Code 19 envelope shape).
- **Brief corrections:** 4.4 (field names), §2 (error `<Message>` nesting),
  §3 (creds seam is DB-backed, not hardcoded-only).
- Tests/typecheck not run in this phase — no change was made to invalidate
  phase-60's reported 755/755.

**STOP for review** before Chunk 1's Apply. (Reviewed; Chunk 1 proceeded — see
[phase-62.md](phase-62.md).)
