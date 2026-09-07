# Go-live readiness — Enjoy Shop / Haile Selassie

Read-only audit. **No code was changed.** Every claim below is backed by
the command that produced it; where something could only be reasoned
about rather than run, it says so and sits in the "cannot verify" list.

The real Tremol device details are not yet available, so nothing here
touched a real Control Unit.

Audit date: 2026-09-07. Commit state: the go-live prep of phases 89-93.

---

## Headline

The fiscal **engine** is in good shape and is demonstrated below against
real wire. The fiscal **back office is missing**: the IPC to list unfiled
sales and resend them exists and works, but nothing in the UI calls it.
That breaks the go-live plan's own success test ("watch the unfiled count
drain to zero") — there is no screen showing that count. See Finding 1.

Four defects were found. None breaks the four rules. Two would be
noticed on install day; two would be noticed later, quietly.

---

## 1. PROVEN TODAY

### 1.1 The suite

```
$ npm run typecheck
typecheck exit code: 0
(no diagnostics)

$ npm test
npm test exit code: 0
 Test Files  71 passed (71)
      Tests  1089 passed (1089)
```

Zero skipped, zero `.todo`, zero `.only`, zero `it.fails` in the default
run — grepped for all of them across `tests/` and `mock-zfplab-server/`,
only hit is the live suite's own guard (below). The `failed`/`Code 30`/
`Code 31` strings in the output are **stderr from tests deliberately
exercising failure paths**, not failures.

**One env-gated suite**, excluded from `npm test` by
`vite.config.ts:33` (`exclude: [...defaultExclude, 'tests/live/**']`):

| File | Tests | To run it |
|---|---|---|
| `tests/live/zfplabServer.live.test.ts` | 2 (`settings()` accepted; `ReadStatus` accepted) | `npm run test:live`, which sets `LIVE_ZFP=1`. Now also **requires** `LIVE_ZFP_DEVICE_IP`, `LIVE_ZFP_DEVICE_PORT`, `LIVE_ZFP_DEVICE_PASSWORD` and throws a clear error without them. Needs the real device. |

### 1.2 Happy path — real provider, real HTTP, mock ZFP server

Run: `npx vite-node <scratch>/partB.ts` (boots
`mock-zfplab-server/engine.ts` on an ephemeral port, drives a real
`RealFiscalizationProvider` over a real socket).

```
--- SALE 1 OUTCOME (verbatim) ---
{
  "ok": true,
  "data": {
    "invoiceNumber": "0000000000000000042",
    "qrCode": "MOCK-QR-0123456789...(128 chars)",
    "fiscalizedAt": "05-09-2026 14:30:00",
    "fiscalizedAtSource": "device",
    "cuSerialNumber": "MOCK-CU-SERIAL-0001",
    "defVerStatus": "unknown"
  }
}
```

**Provenance — the number is the device's, not ours:**

```
fixture InvoiceNum     : 0000000000000000042
returned InvoiceNum    : 0000000000000000042
MATCH                  : true
QRcode matches fixture  : true
```

**Session opened once across two sales:**

```
settings() request count : 1
settings() URL sent      : /settings(ip=192.168.1.50,port=8000,password=branch-device-password,tcp=1)

 1. GET  settings                          -> settings-ok.xml
 2. POST ReadCUnumbers                     -> readcunumbers-ok.xml
 3. POST ReadStatus                        -> readstatus-fiscalized-full.xml
 4. POST OpenInvoiceWithFreeCustomerData   -> success-ack.xml
 5. POST SellPLUfromExtDB                  -> success-ack.xml
 6. POST ReadCurrentReceiptInfo            -> readcurrentreceiptinfo-ok.xml
 7. POST CloseReceipt                      -> closereceipt-ok.xml
 8. POST ReadDateTime                      -> readdatetime-ok.xml
 9. POST ReadStatus                        -> readstatus-fiscalized-full.xml   <- sale 2 starts here
10. POST OpenInvoiceWithFreeCustomerData   -> success-ack.xml
...
```

`settings()` and `ReadCUnumbers` appear once, at the top, not per sale.

**Rule 2 — the invoice number is not a fake string:**

```
returned invoice number       : "0000000000000000042"
matches /MOCK/i ?             : false
matches /^\d{19}$/ (CU shape) : true
```

Honest caveat: the **QR** *does* carry a `MOCK-QR-` prefix. That is the
fixture's deliberate marker (its own comment says "deliberately visibly
synthetic … so it can never be mistaken for a real KRA-issued code"), it
comes from the fixture rather than our code, and it exists precisely so a
mock-server receipt is identifiable. Against a real device the QR is
whatever `CloseReceipt` returns.

### 1.3 Failure paths — real `runCheckout`, real in-memory `RubisDatabase`

Run: `partC.ts` / `partC2.ts`. Faults injected through the mock server's
`setFault` where a fixture exists, and at the axios boundary where one
does not (noted per row). The provider, its STE decoding, its
classification, the routing and all DB writes are the real ones.

| Scenario | fiscal_status | error_kind | data_issue | queue rows | unfiled count | on needs-attention | checkout success |
|---|---|---|---|---|---|---|---|
| **C1** transient, Code 30 socket fail | `waiting` | `technical` | null | **1** | 1 | yes | **true** |
| **C3** system, Code 63 invalid post | `needs_fixing` | `system` | null | **0** | 2 | yes | **true** |
| **C2** data, Code 40 STE2=`3b` wrong PIN † | `needs_fixing` | `data` | **`wrong-pin`** | **0** | 3 | yes | **true** |

† No wrong-PIN fixture exists under `tests/fixtures/wire/` and this audit
adds no files to the repo, so the Code 40 envelope was injected at the
axios boundary instead. Only one `OpenInvoice` attempt was made.

Reasons stored, verbatim:

```
C1: Fiscal server error (Code 30): ZFPLabServer cannot reach the fiscal device — check the device IP/port and that the device is powered on
C3: Fiscal server error (Code 63): ZFPLabServer rejected the request format
C2: Fiscal device error (Code 40, STE2=59): Wrong client PIN
```

Needs-attention query output (real rows, joined to staff):

```
[ { local_id: 1, fiscal_status: 'waiting',      fiscal_data_issue: null,        cashier: 'Alex' },
  { local_id: 2, fiscal_status: 'needs_fixing', fiscal_data_issue: null,        cashier: 'Alex' },
  { local_id: 3, fiscal_status: 'needs_fixing', fiscal_data_issue: 'wrong-pin', cashier: 'Alex' } ]
```

**Rule 4 held in every case**: `checkout returned success: true` and
`order row exists: true` for all three.

> Harness honesty note: my first run of this reported `queue rows: 0` for
> C1, which looked like a missing-enqueue bug. It was my filter using
> `localId` instead of the real column `entity_id`. Corrected before
> drawing any conclusion; the product was never wrong.

**C4 — never file twice** (`resendFiscalization`, `OpenInvoice` rejected,
device reports it already holds the number):

```
resend outcome.ok              : true
fiscal_status after resend     : fiscalized
fiscal_invoice_number          : 0000000000000000777   <- the device's number
commands sent on resend        : ReadCUnumbers, ReadStatus, OpenInvoiceWithFreeCustomerData, ReadCUinvoiceNumber
CloseReceipt sent? (2nd filing): false
SellPLU sent?     (2nd filing): false
```

**C4b — the stale queue row does not cause a second filing.** After the
resend the queue row is briefly still present; by the next engine tick it
is gone and:

```
commands sent during tick     : (none)
OpenInvoice sent again?       : false
CloseReceipt sent again?      : false
fiscal_invoice_number now     : 0000000000000000777
queue rows after engine tick  : 0
```

**C5 — retry reclassification** (`waiting` sale whose queued retry
returns a data error):

```
after checkout -> fiscal_status: waiting        queue rows: 1
after retry    -> fiscal_status: needs_fixing   queue rows: 0
after retry    -> error_kind   : data
after retry    -> data_issue   : wrong-pin
order row still exists (Rule 4): true
```

### 1.4 Not-configured behaviour

Run: `partD.ts`.

```
isConfigured()                : false
checkout success (Rule 4)     : true
HTTP calls made               : 0        <-- zero; no 'Password' placeholder was sent
fiscal_status                 : waiting
fiscal_error_reason           : The fiscal device has not been set up on this till yet.
                                Enter its details in Admin, then resend this sale.
fiscal_invoice_number         : null
unfiled count                 : 1
```

The actual receipt rendered for that unfiled sale:

```
Rubis Haile Selassie
Order #1
07/09/2026, 17:37:51
Cashier: Alex
--------
Bottled Water 500ml (500ml) x1
  Ksh 120.00
--------
Subtotal: Ksh 120.00
Tax: Ksh 19.20
Total: Ksh 139.20
Payment: cash
Tendered: Ksh 150.00
Change: Ksh 10.80
Thank you!

receipt mentions "Fiscal Inv" : false
receipt mentions QR           : false
```

**Rule 2 holds** — no fiscal block, no invoice number, no QR.

### 1.5 Secret handling

```
raw row                         : {"baseUrl":"...","deviceIp":"...","devicePort":"8000","password":"super-secret"}
what crosses IPC (redacted)     : {"baseUrl":"...","deviceIp":"...","devicePort":"8000"}
password key survives redaction : false

real on-disk vault (secret-vault.json):
  RUBIS POS.shopify-admin-api-token -> ciphertext 92 chars, plaintext-readable: false
  RUBIS POS.etims-device-password   -> ciphertext 76 chars, plaintext-readable: false
```

And the real `integrations` row on disk after a live gate save was
`{"baseUrl":"http://localhost:4444/","deviceIp":"192.168.1.77","devicePort":"8000"}`
— no `password` key.

### 1.6 Test connection, both directions

```
--- pointed at a running mock server ---
ok       : true
  PASS  Fiscal server on this till
  PASS  Fiscal device answering
  PASS  Device ready to file
message  : The fiscal device answered and is ready to file sales.

--- after the server is killed ---
ok          : false
failedAt    : server
  FAIL         Fiscal server on this till
  not checked  Fiscal device answering
  not checked  Device ready to file
message  : Could not reach the fiscal server on this till. Check that the fiscal
           server software is running, and that the fiscal server address above is right.
```

### 1.7 The wire, re-cross-checked

Captured with a raw `node:http` server recording real headers and bodies
(`partE.ts`) — the mock engine ignores headers, so it cannot prove this.

| Element | Vendor source | What we actually send | Verdict |
|---|---|---|---|
| `settings()` GET, unencoded | `fp_core.js:410` — `"settings(ip=" + ipaddress + ",port=" + tcpport + (password ? (",password=" + password) : "") + ",tcp=1)"` | `GET /settings(ip=192.168.1.50,port=8000,password=branch-device-password,tcp=1)`; URL-encoded parens/commas: **false** | **match** |
| empty-password segment omitted | same line, the `(password ? … : "")` ternary | `buildSettingsCommand(ip,port,'')` → `settings(ip=192.168.1.50,port=8000,tcp=1)` | **match** |
| POST to bare URL | `fp_core.js:258` — `sendReq("POST", "", x)` | `POST "/"` | **match** |
| `Content-Type: text/plain` | `fp_core.js:32` | `content-type: text/plain` | **match** |
| `<Command>` envelope | `fp_core.js:235-257` | `<Command Name="ReadCUnumbers"/>` and `<Command Name="OpenInvoiceWithFreeCustomerData"><Args><Arg Name="CompanyName" Value=""/>…</Args></Command>` | **match** |
| `<Res Code>` root, hex STE on Code 40 only | `fp_core.js:64-81` — `parseInt(…, 16)` guarded by `resCode === 40` | `checkDeviceResponse` parses `STE1`/`STE2` as hex only under `RES_CODE_COMMAND_ERROR`; C2 above decoded `3b` → 59 → `wrong-pin` | **match** |
| **no `Accept` header** | `fp_core.js:29-37` sets exactly one header; its `Accept-Charset` line is commented out | `accept: application/json, text/plain, */*` on **both** GET and POST | **DRIFT — see Finding 3** |

The `OpenInvoice` body also confirms the `KNOWN_GAPS` entry directly —
four customer fields go out blank:

```
<Arg Name="HeadQuarters" Value=""/><Arg Name="Address" Value=""/>
<Arg Name="PostalCodeAndCity" Value=""/><Arg Name="ExemptionNum" Value=""/>
```

---

## 2. FINDINGS

### Finding 1 — the fiscal back office has no UI (highest impact)

The IPC and preload bridge exist and work; **nothing in the renderer
calls them.**

```
$ grep -rn "window\.api\.\(resendFiscalization\|getUnfiledSalesCount\|getSalesNeedingAttention\|correctPinAndResend\)" src/renderer/
src/renderer/src/components/FiscalNotice.tsx:77:  const result = await window.api.correctPinAndResend(lastReceipt.localId, buyerPin)
--- end ---
```

| Channel | main handler | preload | renderer callers |
|---|---|---|---|
| `fiscal:unfiled-count` | yes | yes | **0** |
| `fiscal:needs-attention` | yes | yes | **0** |
| `fiscal:resend` | yes | yes | **0** |
| `fiscal:correct-pin-and-resend` | yes | yes | 1 (the post-sale toast) |

Confirmed visually — the running till's header shows
`Online / ✓ M-Pesa / ✓ Fiscal / ? Scanner / ✗ Printer` and no unfiled
count; a full-page text scan returns `mentionsUnfiled: false`.

**Consequences for install day:** the plan's success test ("watch the
unfiled-sales count drain to zero") cannot be performed. A sale that
lands in `needs_fixing` for anything other than a wrong PIN caught in the
post-sale toast is invisible to staff — it is correctly stored and
correctly counted, but nobody can see it or resend it without a
developer. Rule 3 ("never silently lose an unfiled sale") is upheld in
the data layer and **not** upheld in the interface.

This is phase-88's Part 3, which was scoped and never built.

### Finding 2 — `fiscalizedAt` is stored in two different formats, and Order History misreads one

`real-etims-provider.ts:906`:

```ts
fiscalizedAt: deviceDateTime ?? new Date().toISOString(),
```

The device path stores the device's own string (`dd-MM-yyyy HH:mm:ss`,
per SDK_RECON §3.8 `Format="dd-MM-yyyy HH:mm"` /
`Date.TremolFpFormat`); the fallback path stores ISO-8601.
`OrderHistory.tsx:283` renders it with `new Date(...).toLocaleString()`:

```
device-sourced  : "05-09-2026 14:30:00"      (device means 5 September)
  new Date(...)  -> Sat May 09 2026 14:30:00  (V8 reads MM-dd-yyyy)
  toLocaleString -> 09/05/2026, 14:30:00

local-fallback  : "2026-09-07T05:35:00.062Z"
  toLocaleString -> 07/09/2026, 08:35:00      (correct)
```

Not an `Invalid Date` — a **silent misparse**, wrong by months, on a
tax-relevant screen. Blast radius is display only: the printed receipt
uses the invoice number and QR, never this field (`printer.ts:258-264`),
so no Rule is broken and nothing filed is affected.

### Finding 3 — we still send an `Accept` header; phase-92's "byte-identical" claim is wrong

`docs/phase-92.md` §1 states "Our requests are now byte-identical to the
vendor's." Captured reality on both verbs:

```
accept: application/json, text/plain, */*
content-type: text/plain
user-agent: axios/1.19.0
accept-encoding: gzip, compress, deflate, br
```

Removing our explicit `Accept: application/xml` did not remove the
header — axios supplies its own default. The vendor sends no `Accept` at
all. Whether the ZFPLabServer content-negotiates has never been
observed; it has always received this header from us, including in every
capture that produced the fixtures, so the risk is low but it is not
nil, and the doc's claim should not be relied on.

### Finding 4 — the green "✓ Fiscal" badge does not mean sales are filing

`main/index.ts:732-735`: `checkFiscal` is
`checkHttpReachable(etimsConfig.baseUrl)` — an HTTP probe of the fiscal
**server**, not the device. It says nothing about the TCP password, the
device being powered on, or TIMS pairing. A till can show **✓ Fiscal**
while every sale fails to file.

Two further notes, both read from code rather than run:

- `etimsConfig` is the startup snapshot. `applyEtimsConfigToProvider()`
  updates the provider but not this binding, so after changing the
  server address in Admin the badge keeps probing the **old** URL until
  the app restarts.
- In mock mode the badge deliberately reports disconnected, so it can
  never be green-but-fake that way.

**Use "Test connection", not the badge**, to decide whether the device
is working. The three-hop test is the honest check.

---

## 3. COVERED BY TESTS BUT NOT DEMONSTRATED HERE

Real coverage exists; I did not re-drive these because they are not
go-live decision points and the suite exercises them directly.

| Area | Where | Why not re-demonstrated |
|---|---|---|
| Mock provider cannot ship or be selected | `tests/fiscalProviderFactory.test.ts` (6) + `scripts/verify-no-mock-provider.cjs` on every `npm run build` | The build-time assertion is the real guarantee and runs on every build; it was exercised in phase-90 and caught a live leak then. |
| Credit/debit notes (`cancelInvoice`) | `tests/tremolConformance.test.ts` | Not wired into any caller — `KNOWN_GAPS` documents this. Nothing to drive. |
| Fiscal-text sanitiser and pre-send validation | `tests/fiscalSanitize.test.ts`, `tests/fiscalValidate.test.ts` | Pure functions, no device or DB interaction; the allow-list itself is a device question (§4). |
| Vault read/write mechanics | `tests/secretStore.test.ts`, `tests/etimsCredentials.test.ts` (11) | The on-disk outcome *was* shown (§1.5); the encryption internals are Electron's `safeStorage`. |
| Validation messages / IPC schemas | `tests/etimsConfig.test.ts`, `tests/ipcValidator.test.ts` | Exercised live through the Admin form in phase-91's screen pass. |
| Shopify sync, M-Pesa, printer routing, shifts, reports | their own suites | Out of scope for fiscal readiness. |

---

## 4. CANNOT VERIFY WITHOUT THE DEVICE

No amount of mock testing closes any of these. Each row names the single
concrete thing to check on install day.

| # | Unproven | What to do on install day |
|---|---|---|
| 1 | The real device accepts our invoice and returns a real number/QR. | Complete one small cash sale. Confirm `CloseReceipt` returns a 19-digit `InvoiceNum` and a QR that is **not** prefixed `MOCK-QR-`, and that the printed receipt shows the fiscal block. |
| 2 | `settings()` authenticates with the real password. | Press **Test connection** in Admin → Payments & Fiscal Device. Hop 2 ("Fiscal device answering") must pass. A Code 31 shows as "The fiscal device refused the password." |
| 3 | Duplicate-recovery against a real duplicate. | Do not force this on a live day. If a resend ever reports "already filed", confirm the number it adopted matches the number on the original printed receipt before trusting it. |
| 4 | Which STE byte means "receipt already open" (STE1 vs STE2). | If a sale fails and the device has a receipt open, capture the full `Code 40` line from the log — it prints **both** bytes deliberately (`real-etims-provider.ts` logs `STE1=…, STE2=…`). One real occurrence settles it. |
| 5 | Blank `HeadQuarters`/`Address`/`PostalCodeAndCity`/`ExemptionNum` on a B2B invoice. | Issue one invoice with a real customer KRA PIN. If TIMS accepts it, the gap closes; if it rejects, capture the STE2 code. |
| 6 | The `defVer` guard is inert — every capture so far is blank. | Read the first live `settings()` response. If `<defVer>` is `2509041522`, the guard starts working; if blank, the whole warn-vs-block question is moot. Demonstrated inert today: sale 1 returned `defVerStatus: "unknown"`. |
| 7 | Device → KRA transmission itself. | Nothing in this app can see it. Confirm on the KRA/TIMS portal that the first invoice appears, and check the device's own `Unsent_receipts` status bit. |
| 8 | Real success/QR shapes and `VATGrRate` format. | `"16.00"` is an inference from sibling `##.##` fields (SDK_RECON §4a), never quoted in the spec. If the device rejects a line item, try `"16"` before anything else. |

---

## 5. NEEDS A HUMAN AT A SCREEN

I *can* drive the app here (Electron's remote-debugging port + Node's
built-in `WebSocket`), so some of these are already done. The rest need
a person on the actual touch hardware.

**Done, with screenshots:**

| Check | Result |
|---|---|
| Setup gate reads cleanly | Pass. Title, four fields, one help line each, no prose. Server address pre-filled `http://localhost:4444/`; IP/port/password blank. |
| Gate saves and lifts | Pass. Accepting the pre-filled URL untouched saved and reached the till; badge flipped to ✓ Fiscal. |
| Admin fiscal form | Pass. Plain labels/help, Status line, Test connection with a three-row checklist. |
| Complete Sale button not covered | Pass on this window size — the numpad sits above it in normal flow, not as an overlay. |
| Unfiled-count badge prominent | **Fail — it does not exist.** See Finding 1. |

**Still needs a human on the real till:**

1. **Touch targets at the real screen size and DPI.** Everything here was
   driven at the dev window size; the branch hardware may differ.
2. **Toast stack vs Complete Sale under load.** I could not stack several
   toasts at once. Complete 3-4 sales quickly and confirm the toast
   stack never covers the button or the numpad.
3. **Virtual keyboard overlay.** Open the KRA PIN entry with the on-screen
   keyboard up and confirm it does not cover the confirm button.
4. **The fiscal notice and its wrong-PIN buttons.** These only appear
   after a real failed sale. With the device attached, force one wrong
   PIN and confirm the notice appears, its buttons are reachable, and
   the correct-and-resend round-trips.
5. **Receipt legibility on the real printer** — the printer showed
   `✗ Printer` throughout this audit; nothing was printed to paper.
6. **Glare/contrast** of the amber "Not set up yet" and red validation
   text on the actual screen.

---

## 6. What I could not do from here

Stated plainly rather than glossed:

- **No real device, so nothing in §4 was touched.**
- **No paper receipt** — the thermal printer was unreachable
  (`✗ Printer`); the receipt in §1.4 is `renderReceipt`'s real output
  captured through a recording printer stub, not ink.
- **No sale driven through the UI end to end** — the catalog is empty on
  this machine (no Shopify sync, no demo seed), so the UI sale path was
  verified only as far as the checkout panel. The headless
  demonstrations in §1.3-§1.4 go through the same `runCheckout` the UI
  calls, which is stronger evidence than a click-through anyway.
- **Port 4444 is not bindable in this sandbox** (`EACCES`), so the mock
  server ran on ephemeral ports and on 45444. This is an environment
  limitation, not a product one.
- **`ELECTRON_RUN_AS_NODE=1` is set in this shell**, which makes Electron
  start as plain Node; every app launch needed `env -u`. Worth knowing
  for anyone repeating this.

---

## 7. Recommendation

The fiscal engine is ready to meet a device. The four rules hold
everywhere I could drive them.

**Before install day I would want Finding 1 fixed** — a screen showing
the unfiled count and the needs-attention list with a Resend button.
Without it the branch has no way to see or clear a stuck sale, and the
go-live plan's own verification step cannot be carried out. Everything
needed behind it already exists and is tested; it is UI work only.

Findings 2-4 are safe to go live with, provided whoever is on site knows
that **the green ✓ Fiscal badge is not proof of filing** — press Test
connection instead.
