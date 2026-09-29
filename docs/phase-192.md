# Phase 192 — Reading the device's electronic journal for 22-29 Sep

- **Date:** 2026-09-29, 19:08-19:09 EAT
- **Requested:** Read the fiscal device's own record of what it filed between 22 and 29 Sep, to tell whether the stuck sales on the till were ever filed. You approved this read (it was on the list held for VIL question 3).
- **Outcome:** **No journal data could be obtained this way.** The device accepted the command but the plain HTTP API returns no journal content for it. Nothing on the device changed.
- **Branch / base commit:** staging @ 5cc560b. No code changed. RUBIS POS was closed; `settings()` was not sent.

## Requests and replies (raw replies in `C:\rubis-scratch\ej-2026-09-29\`, outside git)

| Time | Command | ms | Reply |
| --- | --- | --- | --- |
| 19:08:47 | ReadStatus (gate) | 1,058 | `Code 0`, no receipt open, no fault bits, `Unsent_receipts 0` |
| 19:08:52 | ReadEJByDate, `JY`, `220926` to `290926` | 35 | **`Code 12`, server error `ServCreateCmdString`**: dates must be `dd-MM-yyyy HH:mm:ss`. The server refused to build the command, so **nothing reached the device**. |
| 19:08:59 | ReadEJByDate, `JY`, `22-09-2026 00:00:00` to `29-09-2026 23:59:59` | 316 | **`Code 0`, `<Status>OK</Status>`**, no journal content |
| 19:09:08 | ReadDiagnostics | 114 | Same as before: `SDIdxPos 0105017952`, last invoice `…000809` on `220926`, `LastEODDate 210926`, `InvoicesSent 0001` |

The second attempt is not a repeat of the first: the first never left the server.

## Findings

1. **The command works but returns nothing usable.**
   - In the definitions, `ReadEJByDate` has no response fields, only an "ACK plus" (`ACK_PLUS="true"`).
   - The PDF (§2.7.9) says the JSON journal's bytes "must be read subsequently" by the client.
   - The plain HTTP API returned only "OK", so the journal cannot be retrieved this way. Retrieving it would need the server's raw read commands (`RawRead`/`DirectCommand`), which are on the forbidden list.
2. **Nothing changed on the device.** The journal read did not move `SDIdxPos`, the last invoice or the end-of-day date.
3. **The end-of-day still shows as not sent.** At 19:09, about 1.5 hours after the Z report, `LastEODDate` is still `210926` (`docs/phase-189.md` §3).
4. **The server needs dates in `dd-MM-yyyy HH:mm:ss`** for `ReadEJByDate`, not the `ddMMyy` its definitions and PDF describe. The app sends no date-taking commands today.

## What we can still say without the journal

- The device's last invoice is `0110605040001000809`, dated 22-09-26, and `InvoicesSent` is 1. **Nothing has been filed since 22 Sep by any till.**
- So any sale rung up on the pilot till after 22 Sep, from this POS or any other system, was not filed by this device.

## Options to see the actual journal (none done here)

1. **VIL:** how to retrieve the journal through ZFPLabServer (the raw read, or the store-to-SD/USB options `J4`, which write to the card).
2. **Newer definitions (2509041522):** they add reads by our own reference (`ReadEJByTraderSystemInvNum`), by CU invoice number and by buyer PIN. That is the direct way to ask "did the device file `INV-000000123`?", and needs the server upgraded.
3. **The device's own screen or an EJ export by VIL or head office.**
