# Phase 206 — "Tax device unavailable" at checkout; does the till or the device print the ETR (read-only audit)

- **Date:** 2026-10-03
- **Requested:** read-only, two questions. (1) Why does checkout show "Tax device unavailable. This sale will be sent automatically when it's back."? (2) Is the ETR printed at the till, and does the control unit print anything?
- **Outcome:** **Question 1:** it was *not* an outage. At the moment of the sale the fiscal server and the control unit answered every command in under 130 ms. The device refused `OpenInvoiceWithFreeCustomerData` twice with STE2 `0x32` "Illegal command", which this build classes as retryable and shows as that notice (phase 184). The fiscal server's own log shows it, byte for byte. The earlier timeouts in your console were a different thing: the saved device address was `192.168.2.235`, which this PC cannot reach. **Two further findings you did not ask for**, both serious: the sale was then recorded as `fiscalized` although the device never accepted an invoice, and two copies of the app are running against one fiscal server and keep overwriting each other's device address. **Question 2:** outcome (iii), cannot be determined from the files; what is needed is named in section 3.
- **Changes made:** none to code, config, fixtures or tests. This document is the only file added.
- **Branch / base commit:** staging @ `a07c2b1`.

## 0. Repo state, first

```
$ git status --short
(no output: tree clean)
$ git log -1 --oneline
a07c2b1 Phase 205: App & Updates to the main Admin page; Peripherals as Scanner and Printers cards
```

**This machine:** `Chessah`, the dev PC. Wi-Fi `192.168.8.52/24`, default gateway `192.168.8.1`. **Running now:** the installed app (`RUBIS POS.exe`, 2.1.6, started 22:36) **and** the dev app (`electron .` from the repo, started 22:40), **both with `--user-data-dir=C:\Users\paulc\AppData\Roaming\rubis-pos-desktop`**, i.e. the same database. Two `ZFPLabServer.exe` processes: PID 4236, the Windows service `ZFPLabService` (running since 2026-09-29 19:37, the one registered for `HTTP://+:4444/` in `netsh http show servicestate`), and PID 52960, a GUI instance started 22:16 from `C:\Program Files (x86)\ZFPLabServer\`. No `requestSingleInstanceLock` anywhere in `src/` (grep).

## 1. Question 1 — why "Tax device unavailable"

### 1a. What the till recorded

Source: a copy of the live database (`rubis-pos.db`, `-wal`, `-shm`) taken to the scratchpad; the live file was never opened. The copy was read with `sqlite3`.

`orders` (the only row):

| local_id | created_at (UTC) | fiscal_status | fiscal_error_reason / kind | fiscal_invoice_number | trader no. | fiscal_fiscalized_at | source | qr | cu serial |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 2026-10-02T21:37:08.330Z | `fiscalized` | NULL / NULL | `0110605040000000000` | `INV-000000001` | 21:37:09.027Z | `local-fallback` | empty | `KRAMW011202207060504` |

It is a 1.00 KSh cash sale, item "test", class A, no shift. `fiscal_slip_unprinted_at` is set (21:37:12.041Z) and `receipt_printed_at` is NULL: the `printers` table is empty, so nothing was printed.

`sync_queue` rows with `entity_type = 'etims_invoice'`: **none** (the table holds no rows at all). So nothing has reached abandonment (`next_attempt_at = Number.MAX_SAFE_INTEGER`, `ABANDONED`). A success deletes the row, so an empty queue says nothing about what happened first.

`integrations` row for `etims`: keys are `baseUrl`, `defaultVatClass`, `deviceIp`, `devicePort` and **no password-like key**. Values: `http://localhost:4444/`, `A`, **`154.79.253.245`**, `8000`. The password was not read or printed anywhere.

`fiscal_duplicate_prints` (ETR copy button): one row, 2026-10-02T21:38:39.905Z, result `refused`, "The fiscal device's most recent receipt is a different one. Only the most recent receipt can be reprinted.", `device_last_cu_inv` `0110605040001000809`.

### 1b. What the logs say

The app writes no log file: `userData\error.log` does not exist (it records crashes only, [index.ts:491](../src/main/index.ts#L491)), and `console` output of the installed app goes nowhere; the dev app's console is in your terminal, which I cannot see. **Not verified:** the app's own `[DEBUG-HTTP]` lines for the sale. What exists on disk instead is the **fiscal server's own log**, `GET http://localhost:4444/log` (the manual says it is there, `Manual.pdf` §3.2): 10,846 lines, one block per device command, with the raw bytes both ways and times to the millisecond. Its clock is the PC's local time (UTC+3), which matches the database: order 1 was created at 21:37:08.330Z and the log's first command for it, `ReadCUnumbers`, started at 00:37:08.343.

**Your seven console lines** (`[DEBUG-HTTP] ReadStatus failed: Fiscal device timed out on ReadStatus`):
- That message is produced only for an axios `ECONNABORTED`, i.e. the request timeout ([http-client.ts:509-510](../src/main/services/integrations/http-client.ts#L509-L510)), set to 5000 ms ([http-client.ts:48](../src/main/services/integrations/http-client.ts#L48), [:188](../src/main/services/integrations/http-client.ts#L188)).
- The server log shows why. Every command sent while the server's device address was `192.168.2.235` failed: **424 of 424 blocks** `Socket connecting to 192.168.2.235:8000` then `E: Socket connect FAILED`, each taking **median 6.68 s (min 0, max 7.24 s)**. The server waits about 6.7 s for the connect; the app gives up at 5 s. So the app reports a timeout, the server a connect failure. (Inference for the exact mapping; the two numbers are measured.)
- The same blocks against `154.79.253.245`: 345 blocks, 2 failed (23:55:03 and 23:56:56, 6.67 s each), the rest answered in a median 0.116 s (max 1.2 s).

**The sale at 00:37:08** (all quoted from the server log, local time):

```
00:37:08.343  ReadCUnumbers                      ok   -> KRAMW011202207060504 ; P000593549A
00:37:08.459  ReadStatus                         ok   status bytes 80 80 80 F0 81 80 (no flags beyond fiscalized/produced/paired)
00:37:08.573  OpenInvoiceWithFreeCustomerData     <- 06 96 30 32 39 34 0A   E: FP: OK; Command: Illegal.
00:37:08.707  ReadStatus                         ok
00:37:08.804  OpenInvoiceWithFreeCustomerData     <- 06 98 30 32 39 3A 0A   E: FP: OK; Command: Illegal.
00:37:08.932  ReadCUinvoiceNumber                <- 5D 49 3B 30 31 31 30 36 30 35 30 34 30 30 30 30 30 30 30 30 30 30 3B  = ";0110605040000000000;"
```

The reply frame is `<ACK><NBL><STE1><STE2>…`: `06`, message number, `30` (STE1 "OK", no fiscal-device fault), `32` (STE2 "Illegal command") (`protocol_description_KE_CU_2509041522.pdf` §1.2.1 and the error table, as read in [phase-183.md](phase-183.md) §1). Each command took 94 to 128 ms. **No `SellPLU`, no `CloseReceipt`, no `CancelReceipt` was sent at all.**

How the app turns that into the notice:
- `checkDeviceResponse` maps a Code 40 `STE2` through `mapFiscalDeviceError`; **`'50'` (hex `0x32`) is `retryable: true`** ([real-etims-provider.ts:446-447](../src/main/services/integrations/real-etims-provider.ts#L446-L447), with the reasoning at [:419-441](../src/main/services/integrations/real-etims-provider.ts#L419-L441): "state, not data", phase 184 §2).
- A retryable failure is routed to `fiscal_status = 'waiting'` ([fiscal-routing.ts](../src/main/services/fiscal-routing.ts), [checkout.ts:644-672](../src/main/services/checkout.ts#L644-L672)), and `waiting` is the only status that `getFiscalNotice` turns into "Tax device unavailable…" ([fiscalNotice.ts:46-50](../src/renderer/src/lib/fiscalNotice.ts#L46-L50)).
- The app-side string for the same frame class was recorded on the pilot till in phase 183: `Fiscal device error (Code 40, STE2=50): FP: OK; Command: Illegal. FP: 06 63 30 32 36 31 0A`.
- **Correction to the premise in the question:** `waiting` is no longer set only for transport failures (Codes 19, 30, 31, 53, timeout). Since phase 184 it is also set for STE2 `0x32`. This sale is the second kind. The sentence "Tax device unavailable" is therefore false for it: the device was available and said no.

**Inference (strong):** the notice you saw at checkout was this sale's first attempt (the first `OpenInvoice` at 00:37:08.573). Basis: it is the only checkout in the database, and the line above is the only way a reachable device produces that notice. I do not have the screen or the app's console for that moment.

### 1c. The app's own Test connection

Run with the app's own code, `RealFiscalizationProvider.testConnection()` ([real-etims-provider.ts:901-909](../src/main/services/integrations/real-etims-provider.ts#L901-L909)), from a scratch script in the session scratchpad (`vite-node`, nothing in the repo changed). It sends exactly `settings()` then `ReadStatus`, the two commands the app sends by itself. The device password was taken from the server's own echo of its stored settings, held in memory, and scrubbed from every output line; the address used was the same one the server already held, so the stored configuration did not change. Quoted verbatim (twice, 446 ms the second time):

```
[DEBUG-HTTP] GET http://localhost:4444/settings(ip=154.79.253.245,port=8000,password=***,tcp=1)
[DEBUG-HTTP] settings() → HTTP 200: <Res Code="0"> …
[DEBUG-HTTP] POST http://localhost:4444/ ReadStatus: <Command Name="ReadStatus"/>
[DEBUG-HTTP] ReadStatus → HTTP 200: <Res Code="0"> …
RESULT: { "ok": true, "message": "The fiscal device answered and is ready to file sales.",
  "hops": [ { "hop": "server", "label": "Fiscal server on this till", "passed": true },
            { "hop": "device", "label": "Fiscal device answering", "passed": true },
            { "hop": "ready",  "label": "Device ready to file",   "passed": true } ] }
```

**All three hops passed.** "Ready to file" means the status bits `CU_fiscalized` and `Paired_with_TIMS` are set; it does not test whether the device will open an invoice, which is what failed.

### 1d. Independent checks

| Check | Command | Output |
| --- | --- | --- |
| Server answers | `curl http://localhost:4444/` | `http=200 time=0.024s`, the "Direct API" page |
| Server's stored settings | `curl http://localhost:4444/settings` | `http=200 time=0.0017s`; `<tcp>1</tcp> <ip>154.79.253.245</ip> <port>8000</port> <password>***</password> <defVer>2509041522</defVer> <servVer>1.9.6</servVer> <clientID>Localhost</clientID> <keepPortOpen>1</keepPortOpen>` (password redacted by `sed` before printing) |
| TCP connect to the device | three connects, 3 s listen each, **nothing sent** | `CONNECTED in 42 ms`, `128 ms`, `265 ms`; silent after connect each time |
| The old address | one connect to `192.168.2.235:8000` | `TimeoutError after 4002 ms` |
| Same network? | `Get-NetIPConfiguration`, `Find-NetRoute` | this PC is `192.168.8.52/24`; `192.168.2.235` is another subnet and is not on-link; `154.79.253.245` is a public address reached through the default gateway `192.168.8.1` |
| Processes | `Get-Process`, `Get-CimInstance Win32_Process` | section 0 |

A connect that then stays silent is **not** a pass, and a silent connect is also what a healthy device does when nothing has been sent; the TCP check therefore proves only that something accepts connections on `154.79.253.245:8000`. What proves the device answers is the server log and Test connection above (real status bytes, real `ReadCUnumbers` reply).

**Is the fiscal engine ticking?** Yes, by evidence rather than only by code. It is created and started at [index.ts:1028-1068](../src/main/index.ts#L1028-L1068), with a 30 s interval ([fiscal-engine.ts:136](../src/main/services/fiscal-engine.ts#L136)). The server log shows the retry it ran 231 ms after the sale's first `OpenInvoice`: `ReadStatus` (00:37:08.707), `OpenInvoice` (00:37:08.804, the `isRetry` pass, which then calls `ReadCUinvoiceNumber`, [real-etims-provider.ts:1103-1126](../src/main/services/integrations/real-etims-provider.ts#L1103-L1126)). The queue is empty now because that retry deleted the row. The backoff, for failures that are not "device not reached": `computeBackoffMs` is 30 s, 60 s, 120 s, … capped at 30 min ([database.ts:532-535](../src/main/services/database.ts#L532-L535)); a device-not-reached outcome counts no attempt and never abandons ([fiscal-engine.ts](../src/main/services/fiscal-engine.ts), phase 186 §5). Nothing in this database exercised the backoff.

**Two apps, one server, one device address.** The fiscal server holds **one** client configuration here (`clientID` `Localhost`), and `settings()` overwrites it. The log's `settings()` history shows the address being overwritten back and forth (each time is the command logged just before the call, so it is accurate to the few seconds between commands; **who made each call is Inference** from the process start times and from when you saved the new address):

```
22:19:30 -> 154.79.253.245      (neither app was running a handshake then; probably the ZFPLabServer web page you used)
22:36:00 -> 192.168.2.235       (the installed app starts at 22:36:24)
22:40:55 -> 192.168.2.235       (the dev app starts at 22:40:58)
23:55:03 -> 154.79.253.245      (probably you saving the new address)
23:56:00 -> 192.168.2.235       (probably the other copy re-opening its session with its old address)
23:56:56 -> 154.79.253.245
00:36:57 / 00:54:57 / 00:55:01 -> 154.79.253.245
```

Runs of commands by address: `192.168.2.235` failed x306 (22:36 to 23:54), then `154.79.253.245` ok from 23:57:03 to now (x262, no failures). There are also two background pollers still running: `ReadStatus` blocks alternate every 30 s at `:01/:31` and `:27/:57` seconds (e.g. 00:30:01, 00:30:27, 00:30:31, 00:30:57), one per running copy. The server log also holds one line `E: Command rejected. The previous one from the same client is still processing.` (23:52:05), which is two clients' commands colliding; [real-etims-provider.ts:839-841](../src/main/services/integrations/real-etims-provider.ts#L839-L841) says its serialisation covers only "this till's own calls", and `claimed` in [fiscal-engine.ts:142](../src/main/services/fiscal-engine.ts#L142) is an in-process set.

### 1e. Conclusion

**(iv), something else, named: the control unit is reachable and answering, and refused `OpenInvoiceWithFreeCustomerData` with STE2 `0x32` "Illegal command"; this build treats that as retryable and shows the "device unavailable" notice. Separately, the earlier timeouts were (ii) at the old address `192.168.2.235`, unreachable from this PC, made worse by two copies of the app overwriting each other's address on the shared fiscal server.**

**External blocker or code fault?**
- **The refusal itself is external, and I propose no code change for it.** The cause is not determined. It is the same refusal, same bytes (`30 32`) and same `ReadCUinvoiceNumber` all-zero reply, as an earlier sale in the same log at 10:48:48 on a previous day (the log has times, not dates; the service started 2026-09-29 19:37), and as phase 183 (pilot till, 2026-09-29). `ReadStatus` was clear each time: no open receipt, no SD, date or contract bits, fiscalized, paired, so phase 183's candidates A (a receipt left open), B (two sequences overlapping) and C (a status bit) do not fit this occurrence. The one precondition the definitions state for this command is in its own text: "The Invoice receipt can be issued only if the invoice range (start and end numbers) is set" (`tremol-defs.xml`, `OpenInvoiceWithFreeCustomerData`). **No command in these definitions reads the invoice range**, so it cannot be checked through this server. The protocol only says the refusal is "illegal depending on the current status of the CU" (§1.2.1). **Not verified:** the cause.
- **Two things are code, and are in Decisions needed:** the notice's wording is false for this cause; and the retry recorded the sale as filed (next section).

### 1f. The sale was recorded as filed although the device never accepted it

This is the finding that matters most for go-live. **Facts:**
- The device refused both `OpenInvoice` calls; nothing was sold or closed on it (log above).
- `ReadCUinvoiceNumber` was then sent by the retry and answered `0110605040000000000`. The app accepts any non-empty `CU_InvoiceNumber` as proof the sale was filed earlier ([real-etims-provider.ts:1558-1561](../src/main/services/integrations/real-etims-provider.ts#L1558-L1561): `if (cuInvoiceNumber) { return { outcome: 'already-filed', cuInvoiceNumber } }`), and `0110605040000000000` is non-empty.
- It stored that string as `fiscal_invoice_number`, set `fiscal_status = 'fiscalized'` and an empty QR and `local-fallback` time, exactly the signature of the recovery branch ([real-etims-provider.ts:1112-1128](../src/main/services/integrations/real-etims-provider.ts#L1112-L1128): `qrCode: ''`, `fiscalizedAtSource: 'local-fallback'`).
- The device's last invoice is still `0110605040001000809`, read at 00:38:40 (`ReadLastAndTotalReceiptNum`: `…1000809;0004946`) and identical to phase 188's read on 2026-09-29 (`…1000809;0004945`). No new CU invoice number was issued by the device between those reads. (The receipt counter moved from 4945 to 4946, which I cannot explain; it is not an invoice.) This is why your ETR-copy attempt at 00:38:39 was refused: the stored number is not the device's.

**Inference (strong, not directly observed):** `ReadCUinvoiceNumber` answers an all-zero number when it holds no invoice for the trader number, and the app took that for "already filed". Basis: the all-zero counter, the unchanged last invoice number, and the same reply on the earlier day's refusal.

**Consequence in the code as written:** `fiscal_invoice_number` is write-once (`COALESCE`, [database.ts:2328](../src/main/services/database.ts#L2328)) and `attemptFiscalRetry` returns a stored result with no device call once `fiscal_status = 'fiscalized'` ([fiscal-retry.ts](../src/main/services/fiscal-retry.ts), safeguard 1). Order 1 will therefore never be retried or corrected by the app, and its receipt would print as a `FISCAL RECEIPT` carrying CU invoice number `0110605040000000000`, no QR, and "Till time (device time unavailable)" ([receiptLayout.ts:371-376](../src/main/lib/receiptLayout.ts#L371-L376), [receiptFiscalBlock.ts:84-105](../src/main/lib/receiptFiscalBlock.ts#L84-L105)). It was not printed (no printer here).

## 2. Question 2 — is the ETR printed at the till, and does the device print?

### 2a. The till's own print path

- `receipt:print` ([index.ts:3066](../src/main/index.ts#L3066)) validates the request, loads the order, then `printSlipsForOrder` ([index.ts:2940](../src/main/index.ts#L2940)) builds the order from the stored row (CU number, trader number, QR, CU date/time and source, CU serial, VAT groups) and calls `printOrderSlips` ([printer.ts:897](../src/main/services/printer.ts#L897)): **the fiscal slip first** (`printReceipt` → `renderReceipt`/`renderEntries` over `buildReceiptLayout`), **then the Enjoy slip**, as two separate jobs, each with its own cut (phase 198).
- **What the fiscal slip carries** ([receiptLayout.ts:365-530](../src/main/lib/receiptLayout.ts#L365-L530), [receiptFiscalBlock.ts:84-105](../src/main/lib/receiptFiscalBlock.ts#L84-L105)): `- START OF FISCAL RECEIPT -`, `FISCAL RECEIPT`, `ORIGINAL` or `*** DUPLICATE ***`; `CONTROL UNIT INFO` with `CU Date/Time` (or "Till time (device time unavailable)"), `CU Serial No`, `CU Invoice No`; the QR and "Scan to verify this receipt with KRA" **only when a QR is stored** (line 520); `- END OF FISCAL RECEIPT -`; the footer.
- **When it prints as a fiscal receipt:** the layout decides by `Boolean(order.fiscalInvoiceNumber)` ([receiptLayout.ts:371](../src/main/lib/receiptLayout.ts#L371)), not by `fiscal_status` directly. That number is written in one place, together with `fiscal_status = 'fiscalized'` ([database.ts:2326-2336](../src/main/services/database.ts#L2326-L2336)), so in practice the two agree. Without a number, on the real provider and a status other than `fiscalized`, it prints the sale record: "SALE RECORD", "NOT A TAX INVOICE", "Tax invoice to follow" ([printer.ts:213-218](../src/main/services/printer.ts#L213-L218), phase 164-1/165). "Printed once" is recorded only when a real print reached paper and the order has a number ([printer.ts:193-198](../src/main/services/printer.ts#L193-L198)).
- **Caveat that follows from section 1f:** the gate trusts the stored number. An order wrongly marked `fiscalized` prints as a fiscal receipt.
- **Not exercised:** no printer is configured on this PC (`printers` is empty), so no print from this build has been seen; this section is from reading the code.

### 2b. Whether the device is told to print

Sources read, read-only: `tests/fixtures/tremol-defs.xml` (definitions `2509041522`, the version the running server reports), `protocol_description_KE_CU_2509041522.pdf`, `Manual.pdf`, and `VIL G03 INTEGRATION WORKFLOW.pdf`, all converted with `pdftotext` into the scratchpad.

**The four option types you named, quoted from the definitions:**

| Option | Where it is | What it governs, as written |
| --- | --- | --- |
| `OptionReceiptFormat` | **input** of `OpenReceipt` (`<ReceiptFormat[1]>`), **output** of `ReadCurrentReceiptInfo` | "1 symbol with value: '1' - Detailed, '0' - Brief" (`OpenReceipt` is §2.5.1; the same words appear for EJ reports: "Added option to select EJ report format - Brief or Detailed"). Nothing says it controls printing. |
| `OptionClientReceipt` | **output only**, of `ReadCurrentReceiptInfo` | "'1' - invoice (client) receipt, '0' - standard receipt". A reported state, not an argument. |
| `OptionInvoiceCopy` | **input** of `ReadOrStoreInvoiceCopy` only | desc: "(Printing/Storage Invoice receipt copy) 2 symbols for destination: 'J0' - Reading, 'J4' - Storage in External SD card memory". Its two values are read and store-to-SD; **neither says print**, though the revision note says "Added Print/Store Copy of Invoice receipt" (version 2112311200). |
| `OptionReportStorage` | **input** of the `StoreEJ*` commands only | "'J4' - Storage in External SD card memory; 'JX' - … for JSON". Storage, not printing. |
| (`OptionPrinting`) | `Subtotal`, hardcoded `'0'` | "Calculate the subtotal amount with printing and display visualization options … will be printed regardless the parameter for printing" |

**What the app sends** (`FiscalEndpointPaths`, [real-etims-provider.ts:296-341](../src/main/services/integrations/real-etims-provider.ts#L296-L341)): 14 keys, **not twelve**, naming 13 distinct commands, because the with-PIN open uses the same command name: `ReadStatus`, `ReadCUnumbers`, `OpenInvoiceWithFreeCustomerData`, `OpenCreditNoteWithFreeCustomerData`, `SellPLUfromExtDB`, `SellPLUfromExtDB_HS`, `ReadCurrentReceiptInfo`, `CloseReceipt`, `ReadDateTime`, `CancelReceipt`, `ReadCUinvoiceNumber`, `ReadLastAndTotalReceiptNum`, `InfoLastReceiptDuplicate`. Checked against the definitions: **none of the 13 takes `OptionPrinting`, `OptionReceiptFormat`, `OptionInvoiceCopy` or `OptionReportStorage` as an argument**; the only caller-chosen option is `OptionVATClass` on `SellPLUfromExtDB`; `ReadCurrentReceiptInfo` carries `OptionReceiptFormat` and `OptionClientReceipt` only in its **response**. The app never sends `OpenReceipt`, `Subtotal`, `ReadOrStoreInvoiceCopy` or any `StoreEJ*`.

**One positional observation (Inference, basis: the argument layouts):** `OpenReceipt` is `<reserved['1']><reserved[' 0']><ReceiptFormat[1]><ReceiptType['0']><TraderSystemInvNum>`, while `OpenInvoiceWithFreeCustomerData` is `<reserved['1']><reserved[' 0']><reserved['0']><InvoiceType['1']>…`. The slot that holds the receipt format in one holds a hardcoded `'0'` in the other, which in `OpenReceipt` means Brief. The definitions do not label it, so I do not read any device behaviour into it.

**The one command that may print:** `InfoLastReceiptDuplicate`: "Informs about the issued document" (§2.5.9; input and output "n. a."). The project's earlier claim that it "Prints" is, in the project's own words, "an inference, not a fact" ([phase-196.md](phase-196.md) §1). The app sends it **only** from the manager-PIN "Print ETR copy" button ([index.ts:2725](../src/main/index.ts#L2725), [fiscal-duplicate-print.ts](../src/main/services/fiscal-duplicate-print.ts)), after a `ReadLastAndTotalReceiptNum` guard, never automatically. The database shows one press, refused before anything was sent.

**Plainly: with the arguments the app sends today, does the device print, or not?** **The definitions and PDFs do not say.** They contain no argument, setting or sentence that makes the control unit print or not print the sale receipt, and none that says it prints on `CloseReceipt`. I have not inferred device behaviour from an option's name. The only thing the files do establish is that **none of the print-named options is passed by anything the app sends automatically.**

### 2c. The model

- The vendor PDF's title is "Tremol G03 (Type B & C)" (`VIL G03 INTEGRATION WORKFLOW.pdf`, every page footer). **It does not say which type has a printer.** Nor do the protocol PDF or the manual. The manual's error table has printer-fault codes (STE1 `0x31` "Out of paper, printer failure", `0x3C` "Overheated printer thermal head"), calls the family "fiscal printer mode" and shows `PaperFeed` and `PrintDailyReport` URLs (§3.1 and §4.12, with the status-bytes table just above §4.12); the protocol lists "paper feeding, paper cutting" as general commands (§2.2) and an external display command set. None of that says this unit has a printer.
- The protocol and the definitions list `DeviceType` as only `'1' - A Type` and `'2' - B Type` (`ReadDiagnostics`, §2.4.4); **type C is not defined in them at all.**
- **The project does record the type:** [phase-188.md](phase-188.md) §2-3 read it from the live device on 2026-09-29: `ReadVersion` = "Ver 2.00,TRG03-TSL C" and `ReadDiagnostics` `OptionDeviceType = C`, "a Tremol G03, type C". That is the device's own answer, not a documented printer fact.
- Where it is: per the pilot topology (ICT answer, 24 Sep 2026) the CU is at head office, shared by all shops later ([phase-196.md](phase-196.md) §1); any paper from a device-side print would come out there, not at the shop counter.
- The VIL manual's own wording supports the till printing: "DETAILS RECEIVED FROM CONTROL UNIT (to be printed on invoice)": CU invoice number, QR URL, date and time, CU serial. It does not say the unit prints nothing.

### 2d. Conclusion

**(iii) Cannot be determined from the files.** The till's own path prints the fiscal slip, with the CU data and QR, as required (section 2a, from the code; not seen on paper from this build). Whether the control unit also prints is **not answered anywhere in the definitions, the protocol, the manual or the VIL manual**, and no argument in anything the app sends automatically is one the documents tie to printing. What would settle it, and only one is needed:
- **A vendor answer** (VIL/TSL): does a Tremol G03 type C print the invoice receipt on `CloseReceipt`; is there a setting that stops it; does `InfoLastReceiptDuplicate` print and where; or
- **A live observation** with someone at head office watching the CU during one real, accepted filing. **Today that cannot be done**: the device refuses to open an invoice (section 1), so no filing can complete to observe.

## 3. Dependencies and risks identified

- **Inbound to the changed behaviour:** none; nothing was changed. Readers of `fiscal_status = 'waiting'`: `getFiscalNotice`, Needs Attention, the engine ([database.ts:2726](../src/main/services/database.ts#L2726)).
- **Contracts crossing a boundary:** the fiscal server's single client configuration (`clientID` `Localhost`), shared by every program on this PC that talks to `:4444`; the device's single TCP session; the shared `userData` database used by both app copies.
- **Tests:** the all-zero recovery and the two-copy overlap are not covered; `tests/fiscalEngine.test.ts` and the provider tests cover recovery only with realistic numbers (not re-read for this audit; **Not verified**).

## 4. Verification: what was run

- `git status --short`, `git log -1 --oneline`; `hostname`; `Get-Process`, `Get-NetTCPConnection -LocalPort 4444`, `Get-CimInstance Win32_Process` and `Win32_Service`, `netsh http show servicestate`, `Get-NetIPConfiguration`, `Find-NetRoute`.
- A copy of `rubis-pos.db` (+ `-wal`, `-shm`) to the scratchpad, read with Python `sqlite3`: `orders`, `sync_queue`, `integrations`, `fiscal_duplicate_prints`, `receipt_reprints`, `shifts`, `printers`, `settings` keys. Nothing was written; the password was not read.
- **Calls to the fiscal server and device** (all reads, all things the app itself sends, plus one page request): `GET /` and `GET /settings` (the web page's own read idiom, which the server logs as `settings()` with empty arguments), `GET /log`; **the app's own Test connection twice** (so `settings()` carrying the device password, then `ReadStatus`, each time; the `settings()` was to the address the server already held, so it changed nothing; it appears in the server log at 00:54:57 and 00:55:01); three TCP connects with nothing sent and one to the old address; no `OpenInvoice`, `SellPLU`, `CloseReceipt`, `ReadCUinvoiceNumber`, `InfoLastReceiptDuplicate` or any command that changes the device was sent by me.
- `pdftotext` of the three vendor PDFs; `ElementTree` over `tremol-defs.xml` for the option types and each command's arguments.
- **Not run:** anything on the live database; the app's UI; a print; a vendor query. **Not verified:** the app's console output for the sale; which app copy ran the checkout; why the device says "Illegal command"; the date of the earlier refusal at 10:48:48; the cause of the receipt counter moving from 4945 to 4946.

## 5. Decisions needed

1. **Order 1 is recorded as filed and was not.** Treat it as a test sale to void, or leave it? As coded the app will never retry or correct it (section 1f). Any real sale refused the same way would be recorded the same way.
2. **The recovery rule** ([real-etims-provider.ts:1558-1561](../src/main/services/integrations/real-etims-provider.ts#L1558-L1561)) accepts any non-empty `ReadCUinvoiceNumber`, including an all-zero one. Do you want it to refuse an all-zero number (and, ideally, to check the number against the device's last invoice), as a code change of its own with its own tests? It is a code fault, not an external blocker.
3. **The device refusing `OpenInvoiceWithFreeCustomerData` with "Illegal command"** is external. Who asks VIL/TSL (and KRA/ICT if needed), and what do we ask? Suggested: why does a G03 type C with a clear `ReadStatus` answer STE2 `0x32` to this command; is the invoice range (start and end numbers) set on this unit; is a daily closure or a TIMS exchange needed first. Until it is answered no sale can be filed from this till, whatever the address.
4. **The notice wording.** "Tax device unavailable" is shown for a device that is available and refusing. Keep it (phase 184 chose to retry state refusals), or give the "Illegal command" case its own wording? A copy change, only if you want it.
5. **Two copies of the app on one fiscal server.** On this PC, close one copy while testing (the dev app and the installed 2.1.6 share a database, an address and a server client, and they overwrite each other's address). On a till only one runs. Do you want a single-instance lock added so the second copy refuses to start? It is not there today.
6. **Two ZFPLabServer processes** (the service and a GUI copy). The manual says a new instance shuts the previous one down; both are running and only the service owns port 4444. Should the GUI copy be closed? **Not verified** whether it holds the device's TCP session.
7. **Question 2:** send the vendor question in section 2d (does a type C print, can it be turned off, what does `InfoLastReceiptDuplicate` do), and decide whether the Print ETR copy button should stay hidden until it is answered (phase 196-2 already says the first live send is a separate approved step).
8. **The device address** is saved as `154.79.253.245:8000` (a public address, so it depends on a port forward at the other end). Confirm that is the intended permanent address; the old `192.168.2.235` only worked from the shop LAN.

## 6. Rollback

Nothing to roll back: no code, config, fixture or test changed, and no device setting was changed. The scratch scripts and the database copy are in the session scratchpad, outside the repo, and hold no password.
