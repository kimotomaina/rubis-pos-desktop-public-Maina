# Phase 183 — Code 40, STE2=0x32 "Illegal command" on a live sale (read-only)

- **Date:** 2026-09-29
- **Requested:** Read-only. Decode the raw frame `06 63 30 32 36 31 0A`, find which `submitInvoice` step failed and with what arguments, list every fiscal-path change from the last build that filed to the 2.1 build, say which commit the 2.1 installer came from, check whether anything in that range could send a command the device refuses, then STOP.
- **Outcome:** Cause **not proven**. The frame is fully decoded, and the code is ruled out: every build from 2.0.1 to 2.1.1 sends the same commands with the same arguments for the same sale. That leaves three candidates about device or receipt state, and one read-only check on the till separates them (§5).
- **Branch / base commit:** main = staging = origin @ f1bfcf5 (chore: bump version to 2.1.1), tree clean.
- **Calls made:** none to the device, ZFPLabServer or Shopify. The device password was never read or printed. The only network call was a download of the public 2.1.1 installer from GitHub for §3.
- **Evidence (pilot till, "2.1"):** `Fiscal device error (Code 40, STE2=50): FP: OK; Command: Illegal. FP: 06 63 30 32 36 31 0A`. The sale was flagged `needs_fixing`.

---

## 1. The raw bytes

Source: `protocol_description_KE_CU_2509041522.pdf` §1.2.1, "Acknowledgement response". Text was extracted with pypdf; the quotes are verbatim.

> Positive acknowledgement – when package format is correct . It is sent when the command is acknowledged as well as when it is rejected (errors in the data sent (field `<DATA…DATA>`) or the command cannot be executed or the command is illegal depending on the current status of the CU indicated by the two status bytes ). It is a package message with the following format:
> `<ACK><NBL><STE><STE><CS><CS><ETX>`

| Byte | Field | Meaning | Source |
| --- | --- | --- | --- |
| `06` | ACK | "ACK 1 06h" | §1.2.1 field table |
| `63` | NBL | "No. of message = NBL of message related to receipt". The frame counter of the request being answered, "increased by 20h" (§1.1), so this is message 0x43 (67). | §1.1, §1.2.1 |
| `30` | STE (1st) | FD errors column: "30 OK" | Table Errors |
| `32` | STE (2nd) | Command errors column: "32 Illegal command" | Table Errors |
| `36 31` | CS CS | "Operation XOR on NBL STE and STE", then each nibble + 30h. `63 ^ 30 ^ 32 = 61` → `36 31`. **Verified: the checksum matches.** | §1.2.1 |
| `0A` | ETX | "0Ah (LF)" | §1.2.1 |

**`0x63` is not a command code.** It is the message number (NBL). The ACK frame carries no CMD field at all, so **the frame alone cannot tell you which command was refused**. The only link to the command is the NBL, and only ZFPLabServer's own request log could map NBL 0x43 back to a command (see §5, note 3).

What the two STE bytes say together: the device reported **no FD-level fault** (so it did not report opened fiscal receipt 34, clock 33, 24-hour block 3b, EJ overflow 3e or insufficient conditions 3f). It refused one command as **illegal in its current state**. The PDF's own example: "Error 32 – Illegal command due to clock failure", where the first digit is the FD error and the second is the command error. This sale's frame reads `0`/`2`: FD OK, command illegal.

How the app turned that into the message you saw ([real-etims-provider.ts:527-566](../src/main/services/integrations/real-etims-provider.ts#L527-L566)):
- `STE2="32"` is parsed as hex, which gives decimal 50.
- [`mapFiscalDeviceError`](../src/main/services/integrations/real-etims-provider.ts#L421-L444) has no case for `'50'`, so the error falls through to the server's raw `<Message>` and is marked `retryable: false`.
- [`routeFiscalOutcome`](../src/main/services/fiscal-routing.ts#L58-L63) then sends it to `needs_fixing`.

## 2. Which step failed, and its arguments

**Not determinable from anything on this PC.**
- The only RUBIS database here is the dev one (`%APPDATA%\rubis-pos-desktop\rubis-pos.db`, last written 2026-09-28 07:44, before any 2.1 build existed). The till's database isn't here.
- The provider's error text carries no step name. The same string would come from `OpenInvoice…`, `SellPLU…`, `ReadCurrentReceiptInfo` or `CloseReceipt`.
- Per-step logging goes to `console` only ([logger.ts](../src/main/services/logger.ts); the `[ETIMS] Step N/7` lines also need `FISCAL_DEBUG_LOGGING=true`, which the bundled `.env` does not set). `userData\error.log` only records crashes ([errorHandler.ts](../src/main/services/errorHandler.ts)). So a packaged till keeps no record of the failing step.

What a read-only copy of the till's database **would** show for this order:
- **`fiscal_error_kind`** tells ReadStatus apart from the rest, but no more:
  - `system` means ReadStatus refused it: `classifyDeviceFailure(…, 'system')` at [real-etims-provider.ts:952](../src/main/services/integrations/real-etims-provider.ts#L952).
  - `data` means one of OpenInvoice, SellPLU, ReadCurrentReceiptInfo or CloseReceipt, and the row cannot say which ([real-etims-provider.ts:616-630](../src/main/services/integrations/real-etims-provider.ts#L616-L630)).
  - `settings()` cannot produce a Code 40, and a `ReadCUnumbers` failure never fails a sale ([real-etims-provider.ts:935-940](../src/main/services/integrations/real-etims-provider.ts#L935-L940)).
- **`fiscal_request_json`** holds the exact request. The wire arguments follow from it deterministically ([real-etims-provider.ts:1507-1644](../src/main/services/integrations/real-etims-provider.ts#L1507-L1644)):
  - `OpenInvoiceWithFreeCustomerData`: `CompanyName`, `ClientPINnum` (buyer PIN or blank), `HeadQuarters`/`Address`/`PostalCodeAndCity`/`ExemptionNum` always blank (`buildFiscalRequest` never sets them), and `TraderSystemInvNum = INV-<local_id padded to 9>`.
  - Per line, class A: `SellPLUfromExtDB`, with `NamePLU`, `OptionVATClass=A`, `Price`, `MeasureUnit=pcs`, `HSCode`/`HSName` (blank unless the Shopify metafields set them), `VATGrRate=16.00` (from `VITE_TAX_RATE=0.16`) and `Quantity`. `DiscAddP` is never sent, because `buildFiscalRequest` never sets `discAddP`.
  - Per line, any other class: `SellPLUfromExtDB_HS`, with `NamePLU`, `Price`, `HSCode` and `Quantity`. This path has never run against a live device (VERIFY-ON-DEVICE at [real-etims-provider.ts:1546](../src/main/services/integrations/real-etims-provider.ts#L1546)).
  - `ReadCurrentReceiptInfo`, `CloseReceipt`: no arguments.
  - **No per-sale command carries the password.** It is sent only in the `settings()` GET, so nothing here needs redacting.

To get that copy: close RUBIS POS on the till, then copy `rubis-pos.db` together with `rubis-pos.db-wal` and `rubis-pos.db-shm` if they exist, since the database is in WAL mode. The `userData\backups\pre-update-*.sqlite` files were taken before the update, so they won't contain this sale.

## 3. Builds, commits and what changed

**Last build that filed successfully: not recorded in the repo or `docs/`.**
- `GO_LIVE_READINESS.md` confirms a live sale was filed ("sale 1 returned `defVerStatus: "unknown"`") but doesn't name the build.
- The pilot ran 2.0.x before 2.1, and 2.0.5 was never installed (docs/phase-181). So the baseline is taken as **2.0.4 = `6ae7ef2`**, with **2.0.1 = `01eb80f`** as the fallback. Both ranges are covered below, and they reach the same conclusion. **Please confirm which build last filed.**

**Which "2.1" build is on the till.** Admin > App & Updates shows it as "Installed version".
- **2.1.1 (the published GitHub release): built from `f1bfcf5` with no uncommitted source changes. Verified, not assumed.**
  - I downloaded the published `RUBIS-POS-Setup-2.1.1.exe` (121,447,053 bytes, the same SHA-512 as the published `latest.yml`) and unpacked it with the repo's bundled 7-Zip and `@electron/asar`.
  - Its compiled `out/` is **byte-identical to a clean `electron-vite build` of `f1bfcf5`, 8 of 8 files** (`out/main/index.js` SHA-256 `C584CB704957542A…` in both).
  - Its `print-raw.ps1` is identical to the committed file, and `app.asar/package.json` says 2.1.1.
  - The bundled `.env` has `VITE_TAX_RATE=0.16` and `VITE_USE_MOCK_ETIMS=false`, and `app-update.yml` has no `publisherName`.
  - `git status` was clean straight after the `f1bfcf5` commit at 14:05:35, and the build ran at 14:09 (`latest.yml` releaseDate `2026-09-29T11:09:33Z`). `.env` is gitignored, so a "clean tree" doesn't cover it; that is why its fiscal-relevant values are listed above.
- **2.1.0 (never published, installed by hand if at all):** the installer is no longer on disk, so which commit it came from (`2da4239`, or `71a30f7` after the phase-181 rebuild) and whether that tree was clean **cannot be checked now**. But `git diff --stat 2da4239 f1bfcf5 -- src` and `git diff --stat 71a30f7 f1bfcf5 -- src` are both empty, so its fiscal code is the same as 2.1.1's either way.

**Every change to the four named files**, plus `xml-utils`'s sibling `http-client.ts`:

| Range | Commit | File(s) | What it changes on the wire |
| --- | --- | --- | --- |
| 2.0.4 → 2.1.1 | `587047e` card tender (phase 176) | checkout.ts | Nothing. A card gate before the order is saved, plus server-derived `tenderedAmount`/`changeDue`/`referenceNumber`. **`buildFiscalRequest` is untouched.** `paymentMethod`/`amountTendered` go into the request, but the provider never reads them (grep: no match in real-etims-provider.ts), so a card sale sends exactly the commands a cash sale does. |
| 2.0.1 → 2.0.4 | `b3319fa` badge uses the connection check | real-etims-provider.ts | Adds `checkConnectivity()`: `settings()` (cached) + `ReadStatus` every 30 s for the badge ([index.ts:1111](../src/main/index.ts#L1111)). It sends no sale commands, only a status read. |
| | `1a58f05` CU date/time and serial per sale (phase 164) | checkout.ts, fiscal-engine.ts | Storage only. |
| | `45d4669` per-VAT-group amounts | real-etims-provider.ts, checkout.ts, fiscal-engine.ts | Response side only (`extractVatGroupAmounts` reads what step 5 already returned). |
| | `6b810dd` daily-closure in verifyAlreadyFiled | real-etims-provider.ts | Response classification only. |
| | `e6597a9` names STE1=59 | real-etims-provider.ts | Response classification only. |
| | `32d3db6` manual M-Pesa (phase 148) | checkout.ts | Payment gate only. |
| any | — | xml-utils.ts, http-client.ts | **No change since 2.0.1.** |

## 4. Could anything in that range send a command or argument the device refuses?

**No.**
- The set of command names in the provider is identical at `01eb80f`, `6ae7ef2` and `f1bfcf5`: `ReadStatus`, `ReadCUnumbers`, `OpenInvoiceWithFreeCustomerData`, `SellPLUfromExtDB`, `SellPLUfromExtDB_HS`, `ReadCurrentReceiptInfo`, `CloseReceipt`, `ReadDateTime`, `CancelReceipt`, `ReadCUinvoiceNumber`, `OpenCreditNoteWithFreeCustomerData`.
- No payment or discount command exists. `Subtotal` is never sent, and `CloseReceipt` takes no payment argument.
- Neither range changes the argument builders, the step order, the sell routing, `formatPrice`, the `VATGrRate` rule, `buildFiscalRequest`'s item fields, or the XML serialiser.
- The bundled `.env`'s `VITE_TAX_RATE` (the only env input to a sale's arguments) is 0.16 in 2.1.1, as it was before phase 180.

So the same sale on 2.0.4 and on 2.1.1 produces byte-identical command traffic. The cause lies in the device's or the receipt's state at that moment, or in the sale's own data, not in a code regression. The PDF's definition of "Illegal" ("illegal depending on the current status of the CU") points to state, not data: bad data has its own codes, such as 34 syntax error, 3c missing item, 3d/3e too large and 40 HS code invalid.

## 5. Candidates, the evidence for each, and the deciding check

**A. A receipt was already open when this sale's `OpenInvoice` ran, and this device reports that as command-illegal rather than as "Opened fiscal receipt".**
- **What would leave a receipt open:** a sale interrupted between OpenInvoice and CloseReceipt, from the app quitting (including an update's quit-and-install), a power cut, or another client on the same device.
- **For:**
  - "Illegal" is the state-dependent refusal.
  - The app's open-receipt recovery keys only on `STE1=0x34`, a reading that has never been seen live (the comment at [real-etims-provider.ts:485-490](../src/main/services/integrations/real-etims-provider.ts#L485-L490) says so).
  - After an OpenInvoice rejection the app sends no `CancelReceipt` ([real-etims-provider.ts:1015-1017](../src/main/services/integrations/real-etims-provider.ts#L1015-L1017)).
  - ReadStatus's `Opened_Fiscal_Receipt` bit is read on every sale but never acted on ([real-etims-provider.ts:1449-1483](../src/main/services/integrations/real-etims-provider.ts#L1449-L1483)).
- **Against:** the PDF has a dedicated FD code (34) for an open receipt, and the device said FD OK.
- **Predicts:** the receipt is **still open** now, and **every later sale fails the same way**.

**B. Two fiscal sequences overlapped on the device.**
- **How it happens:** `submitInvoice` has three unsynchronised callers: checkout ([checkout.ts:626](../src/main/services/checkout.ts#L626)), the fiscal queue's 30-second tick ([fiscal-engine.ts:126-192](../src/main/services/fiscal-engine.ts#L126-L192); its `running` flag only stops it overlapping itself) and manual resend (`fiscal:resend`, [index.ts:2603](../src/main/index.ts#L2603)). Node interleaves them at every `await`. One sale's `OpenInvoice` can land while the other's receipt is open, or one sale's `CloseReceipt`/`CancelReceipt` can end the receipt the other is still selling into. The next command of the other sale is then illegal.
- **For:** FD OK fits a healthy device whose receipt state changed underneath the sale. A queued backlog is likely right after an install, from sales rung up before the device was reachable.
- **Against:** it needs a queued or resent sale in flight at that exact moment, which only the till's database can show.
- **Predicts:** no receipt open now, and later sales file normally. In the database, another order's `fiscal_fiscalized_at` or queue attempt falls within seconds of this order's `created_at`.
- **Risk:** if B happened, see §7, item 1. Items can land on the wrong invoice.

**C. A device-side condition the app does not look at.**
- **What:** a ReadStatus bit that blocks receipts without raising an FD error: `Expired_service_contract`, `Missing_SD_card`, `Wrong_SD_card`, `SD_card_full`, `No_Sec_IC`, `No_certificates`, or the DateTime bits.
- **For:** the app checks only `CU_fiscalized` and `Paired_with_TIMS`, so any of these would pass silently.
- **Against:** it's weak. There's no direct evidence, and several of these conditions have their own FD codes, which the device did not report.
- **Predicts:** the bit is set now, and every sale fails.

**The single read-only check on the till: one `ReadStatus`**, sent while no sale is in progress, in PowerShell on the till:

```powershell
(Invoke-WebRequest -UseBasicParsing -Method Post -Uri 'http://localhost:4444/' -ContentType 'text/plain' -Body '<Command Name="ReadStatus" />').Content
```

(Use the ZFPLab address from Admin > Integrations if it isn't the default.) Then read the result:
- `Opened_Fiscal_Receipt` = 1 → **A**.
- Any of the bits listed under C = 1 → **C**.
- All clear, with `CU_fiscalized` = 1 and `Paired_with_TIMS` = 1 → **B**, a transient overlap that has since passed. Then confirm it against the database copy from §2.

Notes on the check:
1. It is a read. The command carries no password. If the reply is `<Res Code="53">` (no session), stop; don't send `settings()`, which carries the password. Press Admin > Integrations > **Test Connection** once, which opens the session with its own settings + ReadStatus, and run the command again.
2. The PDF says the FD flag "Interrupt power supply in fiscal receipt" is reported "one time until status is read". The app already reads status every 30 s for the badge, so this read changes nothing the badge hasn't.
3. If ZFPLabServer's own logging (`log(on=1)`) was switched on at the time of the sale, its log would name the request frame whose NBL was 0x63. That would identify the refused command directly, with no device call.

## 6. Verification (what was run)

- PDF text extracted with `pypdf` into the session scratchpad. §1.1, §1.2.1, Table Errors, §2.2.1 and §2.5.2 were read. The checksum `63^30^32=61` → `36 31` was checked by hand.
- `git log`/`git diff --stat` over `01eb80f..6ae7ef2`, `6ae7ef2..f1bfcf5`, `2da4239..f1bfcf5` and `71a30f7..f1bfcf5` on the fiscal paths. The command-name set was extracted from `git show <commit>:real-etims-provider.ts` at three commits.
- Published installer: downloaded, verified against the release's SHA-512, and unpacked. `out/` was compared file by file (SHA-256) with a clean `npx electron-vite build` of `f1bfcf5`: 8 of 8 identical. The unpacked copy was deleted afterwards. The rebuild only rewrote the gitignored `out/`, and `git status` stayed clean.
- Not run: anything against the device, ZFPLabServer or Shopify, and anything on the till's database (no copy is available).

## 7. Observed but not changed

1. **No lock around the device session (candidate B), and it is a filing-integrity risk, not only a failed sale.**
   - If the device answers an overlapping `OpenInvoice` with `STE1=0x34`, the app's own recovery sends `CancelReceipt` ([real-etims-provider.ts:965-975](../src/main/services/integrations/real-etims-provider.ts#L965-L975)) and cancels the *other* sale's open receipt. That sale's next `SellPLU` then lands in the receipt the second sequence opens.
   - Result: one sale's items filed under another sale's `TraderSystemInvNum`.
   - A Part 2 fix would be one promise-chain lock around `submitInvoice` in the provider.
2. **STE2 `0x32` (decimal 50, "Illegal command") has no entry in `mapFiscalDeviceError`.**
   - Nor do 31, 33, 35–38 and 3d–3f.
   - It is routed as `kind: 'data'`, which tells a person to fix the sale's data when the sale may be fine.
3. **The failing step is not recorded anywhere on a packaged till** (§2). Putting the command name into the stored reason would have answered §2 directly.
4. **`Opened_Fiscal_Receipt` and the other blocking status bits are read on every sale but never checked** ([real-etims-provider.ts:1458-1482](../src/main/services/integrations/real-etims-provider.ts#L1458-L1482)).
5. **The PDF's OpenInvoice/credit-note/debit-note note is truncated in the vendor's own document:** "If Postponed is enabled after opened fiscal receipt … If up to 5 sec timeout no command ECR closing the receipt". No command to set "Postponed" appears in the extracted text. If the device has such a mode switched on, a gap of more than 5 s inside a sale could close the receipt and make the next command illegal. There is no evidence of this; it is recorded only so it isn't lost.
6. The `docs/` tree does not record which build performed the last successful live filing.

## 8. Rollback

Nothing to roll back. This phase changed no code or config; the only file added is this report.
