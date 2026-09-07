# Phase 92 — Go-live prep, Part 4: wire correctness + missing-config clarity

Two jobs: fix what the audit found genuinely wrong on the wire (and
change nothing else), and make "the device was never set up" a clear
state instead of a guessed password.

Both landed alongside Part 3 — they touch the same files
(`http-client.ts`, `real-etims-provider.ts`) and splitting them would
have meant editing the same functions twice. This doc records the wire
reasoning; `docs/phase-91.md` records the screen.

## 1. The wire: one change, everything else confirmed

Checked against the vendor source `ZFP_SDK_KE_2509041522_ControlUnit/
Libs/JS/fp_core.js`, quoted verbatim in `tracker/SDK_RECON.md`. Not
assumed, and not adjusted to match a guess.

### Confirmed correct — no change made

| Element | Code | Evidence |
|---|---|---|
| `settings(ip=…,port=…,password=…,tcp=1)` as a literal, unencoded GET path | `buildSettingsCommand`, `getSettings` | `fp_core.js:407-410`, SDK_RECON §2.4 |
| Command POST to the **bare** base URL, routed on the body | `postXml`, all endpoints `''` | `sendReq("POST", "", x)` — `fp_core.js:258`, §2.2 |
| `Content-Type: text/plain` on command POSTs, despite an XML body | `FISCAL_CONTENT_TYPE` | `fp_core.js:32`, §2.1 |
| `<Command Name="X"><Args><Arg Name Value/></Args></Command>`, no prolog, no `<Response>` metadata | `serializeToXml` | `fp_core.js:235-259`, §2.2 |
| `<Res Code="N">` root, `0` = success | `parseXmlResponse` | `fp_core.js:64-81`, §2.3 |
| `STE1`/`STE2`/`FPLibErrorCode` read as **hex**, and only on `Code 40` | `checkDeviceResponse` | `parseInt(…, 16)`, §2.3 |

Every one of these was already right. The `Content-Type` in particular
was corrected in an earlier phase against this same source, and is left
exactly as it is.

### Changed: the `Accept` header, removed

`createFiscalHttpClient` and `postXml` sent `Accept: application/xml`.
The vendor does not. `sendReq` (`fp_core.js:29-37`) makes exactly one
`setRequestHeader` call, for `Content-Type`; its only other header line,
an `Accept-Charset`, is commented out in the shipped source.

This was not a guess corrected by a guess — `docs/phase-61.md:214`
asserted "the vendor client sends it", and the source does not support
that. `FISCAL_ACCEPT` is deleted and the claim corrected in the code
comment. Our requests are now byte-identical to the vendor's.

### Changed: `settings()` omits an empty password segment

`buildSettingsCommand` always emitted `,password=…`. The vendor emits it
only when the password is truthy:

```javascript
"settings(ip=" + ipaddress + ",port=" + tcpport +
  (password ? (",password=" + password) : "") + ",tcp=1)"
```
— `fp_core.js:409`, SDK_RECON §2.4

Now matched. Largely moot in practice, since the provider refuses to call
at all without a password (below), but it removes the last divergence
from the vendor's own string.

### Left alone deliberately

The optional `?client=` query parameter (`fp_core.js:31`) is still not
implemented. It is the multi-client mechanism for a device shared by
several tills; the branch has one till, and adding an untested wire
element at go-live is the opposite of what this part is for.

## 2. Missing config: a clear state, not a guessed password

### What it did

`real-etims-provider.ts` resolved its device details with `||` onto
hardcoded defaults, including `DEFAULT_DEVICE_PASSWORD = 'Password'`. An
unconfigured till therefore sent:

```
GET http://localhost:4444/settings(ip=154.79.253.236,port=8000,password=Password,tcp=1)
```

and got back `Res Code 31` (`ServTCPAuth`, "Wrong device TCP password").
So "nobody has set this up" arrived looking identical to "the device is
rejecting us" — a configuration gap wearing a hardware fault's clothes.

### What it does now

`DEFAULT_DEVICE_PASSWORD`, `DEFAULT_DEVICE_IP` and `DEFAULT_DEVICE_PORT`
are **deleted**. The constructor keeps possibly-empty strings, and a new
`isConfigured()` reports whether all three are present.

`submitInvoice` returns, **before any HTTP call**:

```ts
{ ok: false,
  reason: 'The fiscal device has not been set up on this till yet. Enter its details in Admin, then resend this sale.',
  kind: 'technical',
  retryable: true }
```

`'technical'` is the existing kind, not a new one — `etims.ts`'s own
definition is "a transient/technical condition … that heals on its own
**or once configuration is corrected**", which is exactly this. So no
fourth `FiscalFailureKind`, no new column, no new routing.

The consequences follow from machinery that already existed:

- The sale **completes** (Rule 4 — the till is never blocked).
- It routes to `waiting` and queues, so it drains once the details are
  saved rather than needing a manual rescue.
- It appears in `getUnfiledOrderCount()` immediately and in
  `getOrdersNeedingAttention()` once past `STUCK_WAITING_THRESHOLD_MS`
  (phase-88), where the reason reads as a plain sentence.
- The receipt prints **without** a fiscal block, because `printer.ts`
  only prints one when there is an invoice number (Rule 2 — no
  valid-looking tax receipt for an unfiled sale).

`DEFAULT_ETIMS_BASE_URL` survives, and that asymmetry is deliberate: the
fiscal server is a fixed-port service installed on the till itself, so
`http://localhost:4444/` is a real answer rather than a guess. A device
password is never a real answer.

### The gate, and a bug it was hiding

`EtimsSetupGate` stays as the normal path — it stops an unconfigured till
before the first sale, which the backstop cannot. Its mock escape hatch
went in Part 2, and its wording and validation were brought in line in
Part 3.

Driving the real app surfaced a bug here that no test would have caught.
`setup:check-etims-completion` was keyed on `mockEtimsEnabled` — what the
config *asked for* — and mock mode reports "complete" unconditionally
(`etimsSetup.ts:43-45`). But a packaged build refuses the mock regardless
of the stored flag (Part 2). So an **upgraded install whose DB row still
said mock would skip the gate entirely while running the real provider**
— straight to checkout with nothing configured. It is now keyed on the
provider actually in use:

```ts
checkEtimsCompletion(!(fiscalizationProvider instanceof RealFiscalizationProvider), …)
```

The completeness check also reads the password from the vault now rather
than the row, since Part 3 moved it.

## 3. Tests

`tests/fiscalNotConfigured.test.ts` (40 tests, shared with Part 3):

- The not-configured outcome is returned and **zero HTTP calls are made**
  — asserted on the injected client, so no guessed password can reach the
  wire and no `Code 31` can be provoked.
- It is `kind: 'technical'`, `retryable: true`, so the sale queues.
- The reason names no code, command or the word `Password`.
- A **partial** configuration (missing any one of ip/port/password) is
  treated as not set up — parameterised over all three.
- `testConnection` names the right hop for: not configured, server
  unreachable, `Code 31`, `Code 30`, unpaired device, and all-pass.

`tests/realEtimsProvider.test.ts` replaces its "defaults device
ip/port/password to the configured Control Unit values" test with the
opposite assertion — the provider substitutes nothing and refuses to
call — plus a test that the configured values are sent verbatim.

`tests/http-client.test.ts`: `Accept` is now asserted **absent**, the
POST header assertion is `Content-Type` only, and a new test covers the
omitted password segment.

`tests/live/zfplabServer.live.test.ts` now **requires**
`LIVE_ZFP_DEVICE_IP`/`_PORT`/`_PASSWORD` and throws a clear error without
them, rather than falling back to a hardcoded production device IP and
the `Password` placeholder.

## 4. Confirmed on the real app

Startup log, real provider, nothing configured:

```
[DEBUG-ETIMS] Startup: using RealFiscalizationProvider,
  baseUrl = (default) http://localhost:4444/,
  deviceIp = (not configured), devicePort = (not configured),
  password = (not configured)
```

Then: gate appears → details entered → gate lifts → badge flips to
✓ Fiscal → Test connection passes all three hops against the mock server.
Full detail in `docs/phase-91.md` §8.

## Verification

- `npx vitest run`: **71 files / 1089 tests**, 0 failures.
- `npm run typecheck` (node + web): clean.
- `npm run build`: mock-provider guard passes.

---

**STOP for review**, per the brief.

Remaining for Part 5: `docs/GO_LIVE.md` and the `KNOWN_GAPS.md` update.
Two items already queued for the VERIFY-ON-DEVICE list, both found during
this work rather than known going in:

1. The `defVer` guard is **inert**. The captured `settings-ok.xml` has
   `<defVer></defVer>` blank, so `checkDefVersion` always returns
   `'unknown'` and the mismatch warning can never fire against a real
   device. The one guard protecting VAT-class sell routing does nothing.
2. Every live invoice ships `HeadQuarters`, `Address`,
   `PostalCodeAndCity` and `ExemptionNum` as **empty strings** — no
   caller populates them (`checkout.ts` sets only `companyName` and
   `buyerPin`). We do send all seven `<Arg>` elements, which is what the
   vendor client does for empty values, and the defs mark those args
   compulsory in the sense of *present* rather than *non-empty*; but
   whether TIMS accepts a blank address when a buyer PIN is supplied is
   unproven. The first real B2B invoice with a customer PIN settles it.
   Capturing those fields is deliberately out of scope for go-live — most
   sales at this branch are walk-in B2C with no PIN, and the capture
   would cost four taps on every sale to satisfy a requirement that may
   not exist.
