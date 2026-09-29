# Phase 188 — Read-only probe of the CU through ZFPLabServer

- **Date:** 2026-09-29, 15:49-15:55 EAT
- **Requested:** Probe the shared CU through the dev PC's ZFPLabServer with an allow-list of read commands only, one at a time. Record every request and reply, then answer six questions.
- **Outcome:** Done. All 15 allowed reads answered `Code 0`. No held or forbidden command was sent, `settings()` was not called, and no receipt was open. The findings that matter most are in §3.
- **Numbering:** phase 187 is reserved for the till-database queries, which are waiting for the copy at `C:\rubis-scratch\till-2026-09-29\` (it isn't there yet).
- **Branch / base commit:** staging @ 5f9059d, tree clean. No code changed.

## 1. How it was run

- **Preconditions checked:** RUBIS POS was not running on this PC, so there was no badge poll to interleave. `ZFPLabServer.exe` was running, with port 4444 held by `http.sys`.
- **Transport:** `Invoke-WebRequest -Method Post http://localhost:4444/`, `Content-Type: text/plain`, body `<Command Name="…" />`, as in phase 183 §5.
- **One command at a time, each waiting for its reply.** The script stops on a Code 53 and retries a Code 34 once. Neither code occurred.
- **Every command name and argument was checked against the server's own definitions** (2204120945, `tests/fixtures/tremol-old-defs.xml`) before sending. Seven take server-filled arguments only. `ReadInfoFromLastServerCommunication` needs two inputs; it was sent **once**, with `R` (at send receipt) and `s` (status).
- **Raw replies** are saved in `C:\rubis-scratch\probe-2026-09-29\` (outside git), with IPv4 addresses and any `<password>` element redacted. Neither appeared in any reply.

## 2. Replies

| # | Command | ms | Reply (all `Code 0`) |
| --- | --- | --- | --- |
| 0 | ReadStatus | 1,167 | 19 bits. `CU_fiscalized=1`, `CU_produced=1`, `Paired_with_TIMS=1`; **all others 0**, including `Opened_Fiscal_Receipt`, `Unsent_receipts`, the SD-card bits, the DateTime bits, `No_Sec_IC` and `No_certificates` |
| 1 | ReadVersion | 162 | `Version = "Ver 2.00,TRG03-TSL C"` |
| 2 | ReadCUnumbers | 121 | `SerialNumber = KRAMW011202207060504`, `PINnumber = P000593549A` |
| 3 | ReadDateTime | 144 | `29-09-2026 15:49` (this PC: 15:55:03) |
| 4 | ReadVATrates | 151 | A `16.00`, B `08.00`, C `00.00`, D `00.00`, E `00.00` (format `00.00%`) |
| 5 | ReadLastAndTotalReceiptNum | 115 | `LastCUInvoiceNum = 0110605040001000809`, `LastReceiptNum = 0004945` |
| 6 | ReadInvoice_Threshold | 111 | `Value = 00005` |
| 7 | ReadTimeThreshold_Minutes | 137 | `Value = 00060` |
| 8 | Read_IdleTimeout | 153 | `IdleTimeout = 0180` |
| 9 | ReadTotalMessagesCount | 113 | `Count = 020` |
| 10 | ReadInfoFromLastServerCommunication (R, s) | 128 | `Message = " "` (blank) |
| 11 | ReadHScodeNumber | 119 | `HScodesNumber = 0305` |
| 12 | ReadDiagnostics | 139 | `OptionDeviceType = C`, `SDIdxPos = 0105017920`, `LastInvoiceCUNum = 0110605040001000809`, `LastInvoiceDate = 220926`, `LastEODDate = 210926`, `InvoicesSent = 0001` |
| 13 | ReadDeviceModuleSupport | 167 | LAN `1`, WiFi `1`, GPRS `1`, BT `0` |
| 14 | ReadServer_UsedComModule | 136 | `OptionModule = 1` (LAN/WiFi; `0` would be GSM) |

Field meanings are the definitions' own text (`<Desc>`/`<FPOperation>` in the 2204120945 defs, and the protocol PDF §2.2.2, §2.6.5 and §2.8.x). Where the documents give no meaning, the answers below say so.

## 3. Answers

### 1. Firmware and definitions

- The device is **"Ver 2.00, TRG03-TSL C"**: a Tremol G03, type C. That matches the VIL manual's title, "Tremol G03 (Type B & C)".
- **The server's older definitions (2204120945) do not fully describe this device.**
  - `ReadDiagnostics` returned `OptionDeviceType = C`, but those definitions list only `1` (A type) and `2` (B type).
  - `ReadStatus` returned the older 19-bit map. The newer definitions (2509041522) add three bits the till therefore can't see: `Service_contract_nearly_expired`, `Expired_service_contract` and `Update_is_available`.
  - No `ServMismatchBetweenDefinitionAndFPResult` (SDK code 9) occurred on any of the 15 reads.
- **What the mismatch changes in the app,** which picks its behaviour from the `defVer` the server echoes (phase 110):

  | The till's ZFPLabServer echoes | What the app does |
  | --- | --- |
  | `2204120945` | `Price` is limited to 10 characters, and `ReadCUinvoiceNumber` is **not declared**. So a retry whose `OpenInvoice` is refused is **flagged for a person, never resent** (`verifyAlreadyFiled` → `absent` → `unverifiable`). That is safe, but after a crash every such retry needs a person (phase 185 §6). |
  | blank (`defVerStatus 'unknown'`, as GO_LIVE_READINESS.md recorded) | The newer path is assumed. A refused `ReadCUinvoiceNumber` then also flags. |

- **Recommendation:** check which `defVer` the **till's** server echoes. If it is 2204120945, updating that ZFPLabServer to the 2509041522 SDK would give the till `ReadCUinvoiceNumber` and the service-contract bits. That is VIL's call.

### 2. VAT rates

- **A 16.00, B 08.00, C 00.00, D 00.00, E 00.00.** A, B and C match the pilot assumption.
- **D and E are both 0.00.** Whether a 0 % line is filed as exempt or as zero-rated comes from each HS code's `OptionTaxable` flag in the device's HS table (`ProgHScode`, SDK_RECON §4b), not from the rate. The table holds **305 HS codes**.
- Any non-A product in the pilot list must use an HS code that is in that table, or the device refuses the line (STE2 `0x40`, "HS code is not valid").

### 3. Receipt counters, for reconciliation with the till database

- Last CU invoice number: **`0110605040001000809`**, which appears both in `ReadLastAndTotalReceiptNum` and in `ReadDiagnostics`.
- `LastReceiptNum` is **4945**.
- **Last invoice date `22-09-26`, last EOD `21-09-26`; invoices sent "for the current day" `0001`.**
  - Read together: **no invoice has been filed on this CU, by any till, since 22 Sep 2026**, and **no end-of-day has been sent since 21 Sep**, eight days ago.
  - "Current day" appears to be the CU's business day since its last EOD, which would explain `0001`. That reading is mine; the document says only "for the current day".
- **Phase 183 asked which build last filed.** The CU's last filing was on 22 Sep 2026, before 2.0.1 was even tagged (`01eb80f`, 23 Sep 21:16). So no 2.0.x or 2.1.x build has ever filed on this CU.
- The till-database phase (187) can match `…000809` against the till's filed orders.
- The relationship between `LastReceiptNum` (4945) and the invoice sequence (…000809) isn't documented, so I don't infer one.

### 4. Idle timeout and thresholds

- **Idle timeout: 180 s.** The protocol PDF §2.8.13 says it verbatim: "seconds in which the connection will be closed when there is an inactivity … 0 is for never close the connection".
  - **This narrows VIL question 10:** the CU itself drops an idle connection after 3 minutes.
  - **But RUBIS POS never lets the connection go idle:** its status badge sends `ReadStatus` every 30 s (phase 186 §4), well inside 180 s. That is the opposite of VIL Step 9's "only active when in use".
  - PDF §1.3 lists the reply `60`, "CU is already busy with another connection (LAN or WiFi connection only)". **If the CU accepts one connection at a time, one till polling every 30 s could keep other shops out.** This is the most important question to put to VIL before a second shop connects (questions 6 and 10).
- **Invoice threshold: 5. Time threshold: 60 minutes.**
  - The PDF gives no meaning beyond the names ("Read invoice threshold count", "Read time threshold minutes", §2.8.18-19).
  - One plausible reading is the CU's batching of transmissions to TIMS: send after 5 invoices or 60 minutes. Another is a limit on how many invoices or how long the CU may run unsent before it blocks.
  - Either way these govern the **CU ↔ TIMS** link at head office, not a shop's link to the CU. So they don't change phase 186's shop-outage arithmetic. They are for VIL questions 1 and 2.

### 5. Communication with TIMS

- **`Unsent_receipts = 0`**: the CU holds nothing waiting for TIMS.
- **`ReadServer_UsedComModule = 1`**: it reaches TIMS over LAN/WiFi, not GSM. The device also supports GPRS.
- **`ReadInfoFromLastServerCommunication` (R, s)** returned a blank status message. That call, with those two options, has no documented "success" value. The error-code and error-message variants (`c`, `m`) were **not** read, because the brief allowed one read per command. They are the next reads if you want a positive statement.
- The last transmission can't be dated beyond the last invoice (22-09-26), which is recorded as sent (`Unsent_receipts = 0`).

### 6. What a shop till should check and doesn't today (phase 183 candidate C)

The app's `readStatus` acts only on `CU_fiscalized` and `Paired_with_TIMS` ([real-etims-provider.ts, `readStatus`](../src/main/services/integrations/real-etims-provider.ts)). Every blocking condition below was **0 today**, but the till wouldn't notice if one weren't:

| Condition | Source | Why a till should care |
| --- | --- | --- |
| `Opened_Fiscal_Receipt` | ReadStatus ST2.1 | Phase 184 item 4, held for VIL |
| `DateTime_not_set`, `DateTime_wrong`, `Hardware_clock_error` | ST0 | Filing times would be wrong |
| `SD_card_near_full` / `full`, `Missing_SD_card`, `Wrong_SD_card` | ST2, ST5 | The device can't store invoices |
| `No_Sec_IC`, `No_certificates` | ST5 | The device can't sign |
| `Unsent_receipts` | ST4.1 | The CU's backlog to TIMS: filed locally, not yet at KRA |
| `Service_contract_nearly_expired` / `Expired_service_contract` | new defs only | **Invisible while the server runs 2204120945** (§1) |
| `LastEODDate` age | ReadDiagnostics | **8 days today.** If the device enforces the "24 hours block – missing Z report" (FD error `3b`, handled since phase 162), filing will stop without warning. |
| Device clock | ReadDateTime | **About 6 minutes slow today** (see "Also found" below). |

### Also found: the device clock

- The CU read `15:49` when this PC read `15:55:03`: **about 6 minutes slow**. The CU returns minutes only, so the error is 6 ± 1 minutes.
- The app stores the CU's `ReadDateTime` as each filed sale's `fiscal_fiscalized_at`, and prints it on the receipt as the device time (phase 164).
- `SetDateTime` is forbidden here. This is for VIL or head office. The PC's clock was not checked against an external source; if it is itself wrong, the gap could differ.

## 4. What was not done, on purpose

- **Held for VIL question 3:** `ReadEODAmounts`, `ReadDailyAmountsByVAT`, `ReadEJ`, `ReadEJByDate`, `ReadOrStoreInvoiceCopy`, `InfoLastReceiptDuplicate`, `ReadSpecificMessage`. The 20 log messages (`ReadTotalMessagesCount`) can only be read with `ReadSpecificMessage`, which is held.
- **Forbidden, and not sent:** every `Set*`, `Prog*`, `Erase*`, `AddNew*`, `Save*`, `Store*`, `Scan*`, `Start*`, `Display*`, `DailyReport`, `ConfirmFiscalization`, `SoftwareReset`, `SetDateTime`, `Open*`, `SellPLU*`, `Subtotal`, `CloseReceipt`, `CancelReceipt`, `RawRead`, `RawWrite` and `DirectCommand`. Nothing in the replies required one.
- **Not called:** `settings()` and the `settings` GET. Both carry or echo the password.
- **No live sale and no duplicate-number test** (per the brief).

## 5. Follow-ups raised (none acted on)

1. **VIL, before a second shop connects:** does the CU accept one TCP connection at a time (`60`, "busy with another connection")? If so, the app's 30 s badge poll must change (phase 186 §4, VIL questions 6 and 10).
2. **VIL or head office:** no EOD since 21 Sep, and the device clock about 6 minutes slow.
3. **Check the till's ZFPLabServer `defVer`,** and consider the 2509041522 SDK for `ReadCUinvoiceNumber` and the service-contract bits (§3.1).
4. **Phase 187:** reconcile the till's filed orders with `LastCUInvoiceNum …000809` and the 22-09-26 last invoice date.
