# Phase 189 — End-of-day (Z) report on the CU, sent from the dev PC

- **Date:** 2026-09-29, 17:40-17:44 EAT
- **Requested:** Run the overdue end-of-day on the shared CU from this PC, as you approved on Rubis's behalf. The last end-of-day was 21-09-26 (phase 188 §3.3). Send `DailyReport` once, with gate reads before it and read-back after, then report.
- **Outcome:** **Accepted by the CU, but not confirmed as sent to KRA.**
  - `DailyReport` answered `Code 0` / `OK`, and the device wrote to its SD journal (`SDIdxPos` went up by 32).
  - `LastEODDate` still reads `210926` three minutes later, and the last-communication read for end-of-day is blank.
  - Not resent (§3).
- **Branch / base commit:** staging @ 824a452. No code changed.

## 1. How it was run

- **Preconditions:**
  - RUBIS POS was not running on this PC.
  - ZFPLabServer had just been reinstalled (running from 17:31), and its first reply was `Code 53`, "First use settings() command". I stopped there. You re-established the session outside this session, so I never sent `settings()`.
  - You confirmed no sale was in progress on the pilot till before the send.
- **Transport:** as in phase 188, `POST http://localhost:4444/`, `text/plain`, one command at a time.
- **Raw replies:** in `C:\rubis-scratch\eod-2026-09-29\` (outside git), with IPv4 addresses and any `<password>` redacted. Neither appeared.
- **Not called:** `settings()`, `SetDateTime` or any other write. `DailyReport` was the only command that changes the device.

## 2. Requests and replies

| Time | Command | ms | Reply |
| --- | --- | --- | --- |
| 17:40:04 | ReadStatus (gate) | 160 | `Code 0`. `CU_fiscalized`, `CU_produced`, `Paired_with_TIMS` = 1; every other bit 0, including `Opened_Fiscal_Receipt` and `Unsent_receipts` |
| 17:40:15 | ReadDiagnostics (before) | 300 | `SDIdxPos 0105017920`, `LastInvoiceCUNum …000809`, `LastInvoiceDate 220926`, **`LastEODDate 210926`**, `InvoicesSent 0001` |
| 17:40:15 | ReadDateTime | 216 | `29-09-2026 17:34:00` (PC 17:40:15: still about 6 min slow) |
| 17:40:45 | ReadStatus (re-gate, straight before the send) | 749 | Same as 17:40:04 |
| **17:40:46** | **`<Command Name="DailyReport" />`** (server fills the hard-coded `Z`) | 1,094 | **`Code 0`, `<Status>OK</Status>`** |
| 17:40:58 | ReadDiagnostics (after) | 743 | **`SDIdxPos 0105017952` (+32)**; everything else unchanged, **`LastEODDate 210926`** |
| 17:40:59 | ReadInfoFromLastServerCommunication (Z, s) | 850 | `Message " "` (blank) |
| 17:41:00 | ReadInfoFromLastServerCommunication (Z, c) | 592 | `Message "00000"` |
| 17:41:00 | ReadInfoFromLastServerCommunication (Z, m) | 686 | `Message " "` (blank) |
| 17:41:16 | ReadStatus (after) | 530 | Same as the gate: no new bits, `Unsent_receipts 0` |
| 17:44:16 | ReadDiagnostics (+3 min) | 128 | Unchanged from 17:40:58; **`LastEODDate 210926`** |

## 3. What this means

- **The CU accepted the Z report.** The PDF (§1.2.1) says a refused command still answers ACK but with non-zero STE bytes, which ZFPLabServer reports as `Code 40`. This was `Code 0`. `SDIdxPos` is, per §2.4.4, the "current SD index position of last sent receipt", and it moved by 32, so the device recorded and, by that definition, sent *something*. The document doesn't say whether a Z record counts as a "receipt" there.
- **It is not shown as sent to KRA.** The PDF defines `LastEODDate` as "last **sent** EOD" (§2.4.4), and it did not move in 3 minutes. The end-of-day communication status is blank, with error code `00000`.
  - **Reading 1:** the device sends the end-of-day to TIMS later, on its own schedule. The time threshold of 60 minutes (phase 188 §3.4) may govern this.
  - **Reading 2:** the Z was recorded but its transmission hasn't happened or hasn't succeeded, and the device doesn't say why.

  The documents don't say which. Neither reading calls for a second `DailyReport`: that would write a second fiscal-memory record, and nothing shows the first one failed.
- **`InvoicesSent` stayed `0001`.** If it counts the day's invoices, a completed end-of-day would normally reset it. That fits reading 2 slightly better, but it is my inference; the PDF says only "for the current day".
- **Not resent, and nothing else sent to work around it.**

## 4. Next checks (none done here)

1. **In an hour or so, one read-only `ReadDiagnostics`.**
   - If `LastEODDate` reads `290926`, the end-of-day reached KRA (reading 1).
   - If not, it's a question for VIL.
2. **VIL (with question 3):**
   - Does `DailyReport` send the end-of-day to TIMS immediately or on a schedule?
   - What does a blank `Z`/`s` status with code `00000` mean?
   - Can we read the day's Z totals (`ReadEODAmounts`, held until question 3 is answered) to confirm a record exists?
3. **Still open from phase 188:**
   - **Clock:** the CU is still about 6 minutes slow; that is VIL's to fix.
   - **Definitions version:** the reinstalled ZFPLabServer on this PC still returns the 19-bit `ReadStatus` map, which is the older 2204120945 definitions, so the reinstall didn't change that.

## 5. Rollback

None possible, and none needed: a Z report is a permanent fiscal-memory record by design. No app code, config or database changed.
