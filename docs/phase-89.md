# Phase 89 — Go-live prep, Part 1: audit (read-only)

Standing context: the master brief §0-9 and the four rules. Nothing was
changed in this part. The question behind it: can this app go live at the
Haile Selassie branch by entering the real device variables alone?

**Answer: not today.** Three blockers, detailed below. The wire itself is
in good shape — one real mismatch, everything else confirmed correct
against the vendor source.

## 1. Mock vs real provider selection

Selection is an inline ternary in the bootstrap (`main/index.ts:560-580`),
not a factory. The flag resolves DB-first, env-fallback
(`main/index.ts:506-510`):

```ts
const rawMockEtims = (process.env.VITE_USE_MOCK_ETIMS || 'true').trim().toLowerCase()
const mockEtimsEnabled =
  (db.getConfig('mock_etims_enabled') ?? (rawMockEtims !== 'false' ? 'true' : 'false')) === 'true'
```

**The default when neither source is set is MOCK.** `configMigration.ts:44`
seeds the DB row from env once per install; after that the row wins on
every launch. Mock mode additionally bypasses the eTIMS setup gate
(`etimsSetup.ts:43-45`) and forces the fiscal connectivity badge to
"disconnected" (`main/index.ts:661-664`).

The mock provider ships in every installer: `main/index.ts:71` is an
unconditional top-level import with no `app.isPackaged` or
`import.meta.env` guard, so no bundler can drop it. The built
`out/main/index.js` contains the literal `KRA-MOCK-` string, and
`electron-builder.yml` ships `out/**/*`.

Three routes from a production till into the mock:

1. `EtimsSetupGate.tsx:156-163` — a user-visible "Use Mock eTIMS for
   Testing" button calling `setup:use-mock-etims`
   (`main/index.ts:1374-1384`) with **no manager PIN**. The sharpest edge.
2. `AdminScreen.tsx:775-778` — the System-tab toggle, PIN-gated. Its
   client-side default is `useState(true)` (`:138`) and it reads a null
   row as mock (`:308`), so on a real till with no DB row the panel
   displays mock-on and a save would flip it.
3. `config:set` — `ipcValidator.ts:232-237` accepts any key, no allowlist.

The mock returns `KRA-MOCK-XXXXXXXX` (`etims.ts:276`), which `printer.ts`
then prints as a fiscal block — a Rule 2 breach in production.

**The mock server is clean and stays.** `mock-zfplab-server/`
(`engine.ts` + `run.ts`), script `mock:zfplab` (`package.json:34`), used
by `tests/mockZfplabServer.test.ts`. Not imported by `src/`, not in
`out/`, excluded from `electron-builder.yml`'s `files`. It serves
ground-truth fixtures from `tests/fixtures/wire/`. Plan confirmed: real
provider only in production, mock provider not shippable, mock server and
tests retained.

## 2. Config sources and resolution order

`docs/phase-61.md:95-131`'s mapping still holds, and there is no env layer:

```
db.getIntegrationConfig('etims')  →  { baseUrl, deviceIp, devicePort,
                                       password, defaultVatClass, endpoints }
        ↓ each field, if blank/undefined
constructor defaults  →  http-client.ts:35-44, real-etims-provider.ts:68,195
```

`real-etims-provider.ts:541-551` uses `||`, so blank *and* undefined both
fall through. Defaults: `DEFAULT_ETIMS_BASE_URL = 'http://localhost:4444/'`,
`DEFAULT_DEVICE_IP = '154.79.253.236'`, `DEFAULT_DEVICE_PORT = '8000'`,
`DEFAULT_DEVICE_PASSWORD = 'Password'`.

Only two eTIMS-related env vars are read anywhere: `VITE_USE_MOCK_ETIMS`
and `FISCAL_DEBUG_LOGGING`. `.env.example` documents no `ETIMS_DEVICE_*`
key.

**Values the real integration needs:** server base URL, device IP, device
port, device TCP password, default VAT class. That is the whole set for
the wire. The endpoint-path overrides exist but all twelve map to `''` —
the ZFPLabServer routes on `<Command Name>` — so they configure nothing.

**KRA PIN / company identity is not device config.** `CompanyName`,
`ClientPINnum`, `HeadQuarters`, `Address`, `PostalCodeAndCity` and
`ExemptionNum` are the **customer's** block on a B2B invoice
(`real-etims-provider.ts:1059-1072`), captured per sale at checkout. The
Control Unit holds the store's own identity. Separately worth recording:
`headQuarters`/`address`/`postalCodeAndCity`/`exemptionNum` are never
populated by any caller — `checkout.ts:124-154` sets only `companyName`
and `buyerPin` — so every live invoice ships those four as empty strings.
The store's own name on the printed receipt comes from
`process.env.VITE_STORE_NAME` (`main/index.ts:452`).

## 3. The Admin eTIMS section

Integrations tab, `AdminScreen.tsx:1058-1169`. Six controls: ZFPLabServer
URL, Device IP, Device Port, Password, Default VAT Class, and an
"Endpoint Paths (advanced)" JSON textarea.

Text to replace:

- `:1115` — password placeholder **"Optional"**. It is required;
  `checkEtimsCompletion` blocks the entire POS without it.
- `:1132-1134` — "These settings are only used when
  VITE_USE_MOCK_ETIMS=false in your .env file." Stale, wrong (the DB row
  overrides env), and a raw env string shown to a user.
- `:1059-1061` — heading "Real eTIMS Connection Details (Ignored if Mock
  is enabled)".
- `:1103-1106` — "…and with what TCP password" sits above the IP/Port
  fields but describes the field below them.
- `:1149-1153` — the endpoints help. Accurate, but jargon for dead config.
- `:1062-1065` is accurate and derived from `http-client.ts`'s own header
  comment. Keep the substance.

**The password is plaintext, and worse:** stored in
`integrations.config_json` (`database.ts:1445-1451`), returned to the
renderer by `integrations:get-config` with no PIN
(`main/index.ts:1043-1055`), and pre-filled back into the form field
(`AdminScreen.tsx:176`). The M-Pesa secrets do none of those — vault
stored, boolean-status read only, `'•••••••• (configured)'` placeholder.
`docs/phase-61.md:119-129` recommended routing the TCP password through
the vault; it was never done. `docs/phase-21.md:105-109` is where the
plaintext decision was originally accepted, explicitly "revisit if that
changes."

Two further defects: the Admin save path backfills IP/port/URL with
hardcoded defaults and writes a blank password as `undefined`
(`AdminScreen.tsx:402-407`), bypassing the `.min(1)` rules
`etimsConfigSaveSchema` enforces on the setup-gate route. And the
renderer's `DEFAULT_ETIMS_ENDPOINTS` omits `readCUnumbers`, so "Reset to
Defaults" writes an incomplete object.

There is no eTIMS "Test Connection" button, though M-Pesa has one
(`:1044-1055`).

## 4. The ZFP wire

Checked against the vendor source `ZFP_SDK_KE_2509041522_ControlUnit/
Libs/JS/fp_core.js`, quoted verbatim in `tracker/SDK_RECON.md`. Not
assumed.

| Element | Code | Vendor ground truth | Verdict |
|---|---|---|---|
| `settings()` literal unencoded GET | `http-client.ts:154-160` | `fp_core.js:407-410`, SDK_RECON §2.4 | Correct |
| Command POST to bare base URL | `http-client.ts:257-273`, endpoints all `''` | `sendReq("POST", "", x)`, `fp_core.js:258`, §2.2 | Correct |
| `Content-Type: text/plain` | `http-client.ts:58` | `fp_core.js:32`, §2.1 | Correct |
| `<Command Name="X"><Args><Arg Name Value/></Args></Command>` | `xml-utils.ts:73-83` | `fp_core.js:235-259`, §2.2 | Correct, byte-compatible |
| `<Res Code="N">` root, `0` = success | `xml-utils.ts:136-183` | `fp_core.js:64-81`, §2.3 | Correct |
| STE1/STE2/FPLibErrorCode as **hex** | `real-etims-provider.ts:374-375` | `parseInt(..., 16)`, §2.3 | Correct |
| `Accept: application/xml` | `http-client.ts:61` | **The vendor sets no Accept header.** `fp_core.js:29-37` makes exactly one `setRequestHeader` call, for Content-Type | **Mismatch** |
| `,password=` always emitted | `http-client.ts:159` | Vendor emits it only when truthy: `(password ? (",password=" + password) : "")`, `fp_core.js:409` | Divergence |

On the "header recognizes the correct thing" question: the request
`Content-Type` is right and the response envelope parsing is right. The
one wrong thing is the `Accept` header we add that the vendor never
sends. `docs/phase-61.md:214` claims "the vendor client sends it", which
the source does not support.

Two related observations:

- **The `defVer` guard is inert.** The real captured `settings-ok.xml`
  has `<defVer></defVer>` blank, so `checkDefVersion`
  (`http-client.ts:92-95`) always returns `'unknown'` and the mismatch
  warning (`:204-213`) can never fire against a real device. The one
  guard protecting VAT-class sell routing does nothing.
- **The mock server validates no headers.** There is no `req.headers`
  read anywhere in `engine.ts`, so no current test could catch a
  Content-Type regression — precisely the failure `docs/phase-60.md:80-88`
  records as a live 5-second hang. Existing header coverage
  (`tests/http-client.test.ts:60-66`, `:248`) asserts on the axios
  instance, never round-trip.

## 5. Missing-config behavior

**It silently tries the wrong default.** With nothing configured, the real
provider sends:

```
GET http://localhost:4444/settings(ip=154.79.253.236,port=8000,password=Password,tcp=1)
```

The device answers `Res Code="31"` (`ServTCPAuth`, "Wrong device TCP
password" — SDK_RECON §6.3). The startup log honestly prints
`password = (default)` (`main/index.ts:587`) but the wire carries the
literal string `Password`. `EtimsSetupGate` is meant to prevent this, but
it is bypassed whenever mock mode is on — which is the default.

**Net picture:** install today with no `.env`, and the till runs the mock,
prints `KRA-MOCK-` receipts, files nothing, and shows no setup gate.

## Plan for Parts 2-5

Confirmed with the four decisions taken after this audit:

- **Part 2** — split `MockFiscalizationProvider` out of `etims.ts`;
  select through a factory that always returns the real provider when
  `app.isPackaged`; import the mock only inside an `import.meta.env.DEV`
  branch so Rollup drops it; flip the env default from mock to real;
  remove the setup gate's mock button and the `setup:use-mock-etims`
  handler; add a `postbuild` assertion that `KRA-MOCK-` is absent from
  `out/main/index.js`. Mock server and every test untouched.
- **Part 3** — device TCP password to the vault (M-Pesa pattern) with a
  one-time migration off the plaintext row; stop returning it to the
  renderer; rewrite the form with plain labels and short human help;
  delete the endpoint-paths textarea; add IP/port/required validation
  with plain messages; add a Test connection button; add
  `reconfigure()` so a save applies to the next sale without a restart.
  Store name and store KRA PIN become admin fields for the receipt
  header only, replacing `VITE_STORE_NAME`.
- **Part 4** — remove the `Accept` header (the one genuine wire
  mismatch), confirm and leave everything else alone with cites; delete
  `DEFAULT_DEVICE_PASSWORD`; make an unconfigured device a typed
  `kind: 'technical'` outcome returned before any HTTP call, so the sale
  completes (Rule 4), lands unfiled, and reads plainly on the
  needs-attention list. Keep the setup gate as the normal path.
- **Part 5** — `docs/GO_LIVE.md` and `KNOWN_GAPS.md` updates.

---

**STOP for review**, per this part's brief.
