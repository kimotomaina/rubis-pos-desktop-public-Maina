# Phase 56 — Rewire Fiscalization to the Real Local ZFPLabServer Protocol

## Why this phase exists

Phases 45–55 built the entire eTIMS integration against a hypothesis:
a *remote* "Tremol TSL" service at `http://154.79.253.241:8080/TSL/kra`,
authenticated per-request with device ip/port/password, speaking an
XML dialect the team reverse-engineered from HTTP 500s one field at a
time. Every one of those phases records the same pattern — a live call
fails, a plausible-looking fix goes in, tests are rewritten to match
the fix, and the *next* phase discovers the previous one's diagnosis
was itself wrong. Phase 47 even flagged this directly: it needed a
vendor spec file to verify payload shapes against and had none, so it
proceeded on "preserve what's there, it's presumably correct" — which
just carried the accumulated guesses forward.

The remote address was never real. `154.79.253.241` is dead, there is
no "Tax Service Layer," and the fiscal integration is the *local*
ZFPLabServer (`http://localhost:4444/`) that ships with the Tremol
Control Unit and bridges HTTP to the device over TCP.

Before touching code, a read-only audit (this session, prior turn)
located the vendor's own SDK on this machine —
`D:\Volcha\Projects\Rubis\Rubis Etims API Files\API Files\` — containing
`FP.cs`/`FPcore.dll` (C#), `FP.java`/`FPcore.jar` (Java), `FP.vb`
(VB.NET), and working demo apps for each. `FPcore.jar`'s class files
retain literal string constants even compiled, so `javap -c -p
-constants` on `TremolZFP/FPcore.class` recovered the *exact* bytecode
building both request shapes — not inferred, decompiled. That audit is
the source for every ground-truth claim below; see the audit report
for the full decompilation trail (settings() constant-pool strings,
the `fillXmlWithParamVals`/`concatGetMethodString` bytecode, the
`serverSendPOSTRequest` header-setting bytecode).

Two findings explain most of phases 45–55's dead ends:

1. **The command envelope was never `<Request Name="X">`.** The vendor
   builds `<Command Name="X"><Args><Arg Name="k" Value="v"/>…</Args></Command>`
   (`document.createElement("Command")` / `createElement("Arg")` +
   `setAttribute("Name"/"Value")`, confirmed in bytecode). Every payload
   this project ever posted was wrapped in the wrong root tag.
2. **Device connection is a one-time GET, not per-request auth.** The
   vendor's `ServerSetDeviceTcpSettings(ip, port, password)` sends a
   literal, unencoded GET:
   `http://localhost:4444/settings(ip=…,port=…,password=…,tcp=1)`.
   Phases 52/53 built an entire query-param/header mechanism to send
   ip/port/password on *every* fiscal command — a contract that never
   existed, chasing a symptom (device never reachable) whose real cause
   was simpler: nobody was calling `settings()` at all.

## What changed, and why each change traces back to a decompiled fact

### Transport (`http-client.ts`)

- **Base URL → `http://localhost:4444/`** (trailing slash kept
  deliberately — `settings()` builds its URL by literal string
  concatenation onto the base, so stripping the slash the way
  `normalizeBaseUrl` used to would produce
  `http://localhost:4444settings(…)`). *Why*: this is the address the
  vendor's own demo app hardcodes (`Form1.cs`: `string address =
  "http://LocalHost:4444/"`), and the corrected context confirmed it's
  running on this machine.
- **Deleted `initMode` and all `ip`/`port`/`password` query params /
  `X-Device-*` headers.** *Why*: nothing in the decompiled
  `serverSendPOSTRequest` sets these — headers are exactly
  `Content-Type`/`Accept`/`Content-Length`. This entire mechanism (Phase
  52) was solving a problem that didn't exist at the HTTP layer.
- **`Content-Type: application/xml; charset='UTF-8'`, `Accept:
  application/xml`**, replacing `text/xml` / `text/xml, application/xml`
  (Phase 47/55). *Why*: these are the literal header values the
  bytecode sets (`ldc "application/xml; charset=\'UTF-8\'"` at the
  constant pool level) — `text/xml` was never part of this server's
  contract, it was carried over from an assumption about Tomcat
  strictness on a server that doesn't exist.
- **Added `getSettings()`** — issues the GET above and parses
  `<Res Code>`. *Why*: this is the step every prior phase either
  guessed wrong (45: XML POST), removed entirely on a false 404
  diagnosis (46: "no such endpoint — reverted"), or replaced with a
  no-op log line (55: "Step 1 makes no network call of its own"). It's
  now a real network call because the decompiled bytecode shows exactly
  what it must contain.
- **Added `closeDeviceConnection()`** (`clientremove(who=me)`, the GET
  behind the vendor's `ServerCloseDeviceConnection()`). *Why*: the
  corrected 9-step flow names `CloseServerConnection` as the last step;
  the vendor demo calls it from its form-closing handler, not per
  sale — so it's wired to Electron's `before-quit`, not into
  `submitInvoice`.

### Command envelope (`xml-utils.ts`)

- **`serializeToXml` now emits `<Command Name="X">` with a conditional
  `<Args>` of `<Arg Name Value/>` elements**, replacing the
  `<Request Name="X">` + per-field child-tag shape used since before
  Phase 45. *Why*: this is `fillXmlWithParamVals`'s bytecode, verbatim
  — `createElement("Command")`, `setAttribute("Name", commandName)`,
  then (only if the parameter map is non-empty) a child `<Args>` of
  `<Arg Name Value/>` pairs. No test in this codebase had ever verified
  the envelope name against a real source; it was simply never
  challenged across ten phases.
- **`parseXmlResponse` gained `Res/@Code`, `Err/@Source`, and bare
  `Name="X" Value="Y"` attribute-pair extraction.** *Why*: the
  decompiled `CreateRes` walks `<Res Name="X" Value="Y"/>` children for
  some response shapes, and the corrected context's live-confirmed
  error envelope is `<Res Code="N"><Err Source="Server">…`. Both
  extraction paths are additive — nothing that worked before stops
  working.

### `OpenInvoiceWithFreeCustomerData` (`real-etims-provider.ts`)

- **Deleted `reserved`/`reserved`/`reserved`/`InvoiceType` and the
  entire raw-XML bypass (`postRawXml`) that Phase 51 built to send
  them as three same-named sibling tags.** *Why*: the vendor's *own*
  reference implementation —
  `Do("OpenInvoiceWithFreeCustomerData", "CompanyName", companyName,
  ...)` in `FP.cs` — never passes these four arguments to `Do()` at
  all, even though the protocol spec lists them as `Type=
  "OptionHardcoded"`. Decompiling `fillXmlWithParamVals`'s default-mode
  branch confirms it only serializes whatever the caller explicitly
  passed — nothing is auto-injected from the spec. These fields are
  filled in **server-side**. Phase 49 invented a requirement that
  doesn't exist, and Phase 51 then built real complexity (a parallel
  raw-XML code path) to satisfy the invented requirement. Both are now
  gone; `OpenInvoice` goes through the same object-serializer path as
  every other command, sending exactly the seven fields the vendor
  sends: `CompanyName`, `ClientPINnum`, `HeadQuarters`, `Address`,
  `PostalCodeAndCity`, `ExemptionNum`, `TraderSystemInvNum`.

### `SellPLUfromExtDB`

- **`DiscAddP` is now omitted when there's no discount**, instead of
  always defaulting to `'0'` (Phase 49). *Why*: the spec marks it
  `Compulsory="false"` with a presence indicator — an optional field,
  not one requiring an explicit zero.
- **`HSCode`/`HSName` stay in the payload, blank for VAT class A** —
  changed from Phase 55's *omission* of the tags for class A. *Why*:
  the vendor spec lists both as unconditional `Text` args with no
  VAT-class branching documented anywhere in the decompiled defs. Left
  as a `// TODO` rather than asserted as fully correct, since the
  class-A-exemption business rule itself may be real (KRA-side) even
  though the vendor's Arg schema doesn't encode it — this needs a live
  device to settle, not another guess.

### The two gates that were silently broken (the highest-impact finding)

- **`ReadCurrentReceiptInfo` "read VAT" gate**: previously checked
  `receiptInfo.SubTotal ?? receiptInfo.Subtotal ?? receiptInfo.subtotal`
  — a field that **does not exist** on the real response. `Number(undefined)`
  → `NaN` → the `!subtotal` check was always `true`, meaning **this
  gate failed every single real invoice**, unconditionally, regardless
  of any other fix. Replaced with `sumVatGroupSubtotals()`, which sums
  the real fields (`SubtotalAmountVATGA`…`VATGE`) confirmed in the
  decompiled `ReadCurrentReceiptInfo` response definition. *Why this
  survived five phases undetected*: every test in
  `realEtimsProvider.test.ts` mocked the response with a `SubTotal` key
  the test author invented to match the code, so the tests validated
  the code against itself rather than against the device's real
  response shape. New tests build responses from the vendor's actual
  field names instead.
- **`ReadStatus` gate**: previously checked `Connected`/`Fiscalized`/
  `OptionIsReceiptOpened`/`ReceiptOpened` — none of which exist on the
  real `ReadStatus` response (a 6-byte set of named status *bits*;
  `OptionIsReceiptOpened` in particular belongs to
  `ReadCurrentReceiptInfo`, a different command entirely). This gate
  was a permanent no-op (always "passed" since the fields were always
  `undefined`) rather than a real check. Replaced with a check against
  `CU_fiscalized`/`Paired_with_TIMS` when the response carries them,
  falling through to "reachable" (with a logged warning) when it
  doesn't — since a `<Res Code="0">` is itself proof the server reached
  the device, which is the one thing `settings()` alone doesn't prove.

### Error handling

- **Split server-level codes from device-level (STE2) codes.** *Why*:
  the corrected context distinguishes transport/session failures the
  *server* raises (30 = can't reach device, 31 = TCP password
  rejected, 53 = session not initialized, 63 = malformed request) from
  business errors the *device* raises (52/58/59/60/61/62/0, per the G03
  manual page 15). Conflating them (as the single `mapFiscalDeviceError`
  table did) would have reported a device-auth failure with a message
  about invoice line items, or vice versa. `checkDeviceResponse` now
  checks `Err/@Source` to route to the right table.
- **`Code 53` ("client settings missing") triggers one re-`settings()`
  + one retry** of whatever command hit it, inside `sendCommand`.
  *Why*: this is the realistic failure mode of a session-scoped
  handshake — the server restarts, or the session otherwise drops,
  between one sale and the next. Retrying the whole `submitInvoice`
  from scratch would be wasteful; re-establishing the session and
  resuming the one command that failed is the minimal correct
  response.

### POC resilience (explicitly preserved, not just left alone)

The device's TCP password handshake is currently failing (Code 31) as
a live, external blocker. Rather than let that block the POC:

- Any transport/device failure at any step still resolves through the
  existing `orders:checkout` → `sync_queue` → `fiscalEngine` path
  (unchanged from Phase 42's original design) — the sale completes,
  the invoice queues, and the background engine retries it once the
  device is reachable, with **no cashier-visible failure**. A new
  integration test (`fiscalIntegration.test.ts`, "Scenario E") exercises
  exactly this: a Code-31 checkout completes and queues, then a
  simulated password fix lets the *same* queued invoice drain
  successfully without any new checkout action.
- The mock provider path (`VITE_USE_MOCK_ETIMS=true` or the
  `mock_etims_enabled` DB row) is untouched, for a guaranteed-clean
  scripted demo. `.env.example` now documents both modes and which one
  wins (the DB row overrides the env var, per Phase 42).

## Files changed

`xml-utils.ts`, `http-client.ts`, `real-etims-provider.ts`, `etims.ts`
(added `fiscalizedAtSource` so a receipt timestamp can never be
mistaken for a device-attested one when it's actually the local
fallback clock), `fiscal-sanitize.ts` (doc note only), `etimsConfig.ts`,
`main/index.ts`, `AdminScreen.tsx`, `EtimsSetupGate.tsx`,
`connectivityMonitor.ts`, `.env.example`. Tests:
`realEtimsProvider.test.ts` and `http-client.test.ts` rewritten,
`xmlUtils.test.ts` serializer block rewritten, `fiscalIntegration.test.ts`
gained the Code-31 scenario, `etimsConfig.test.ts`/`etimsSetup.test.ts`/
`ipcValidator.test.ts` fixtures updated off the dead `.241` URL.

## What's still flagged, not asserted

Two `// TODO`s remain in `buildSellPluArgs`, deliberately not resolved
by guessing (the exact failure mode that produced phases 45–55 in the
first place):

- **`VATGrRate` percentage-vs-fraction** (`0.16` → `"16.00"`) — the
  vendor spec only bounds it to ≤5 characters, doesn't state the
  convention.
- **Class-A empty-HS vs. omit-HS** — current behavior sends both tags,
  blank for class A; if a live device rejects a blank value here, the
  fix is to omit the tags for class A instead, not to touch anything
  else.

Both need a live device response to settle, which is exactly the
category of decision this phase avoided making unilaterally after
watching five phases guess wrong in a row.

## Verification

- `npm test` — 51 test files, 698 tests, 100% passing.
- `npm run typecheck` (node + web) — clean, no errors.
- Manually captured the exact wire output for a sample 2-line invoice
  (one class-A item, one class-C item with HS code) via a throwaway
  test asserting on the mock `axios` call arguments — confirms the
  `settings()` GET string and every `<Command>` body match this
  document's claims byte-for-byte, not just in intent.
