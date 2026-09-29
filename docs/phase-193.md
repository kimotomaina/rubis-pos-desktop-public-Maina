# Phase 193 — Reading the device's electronic journal, on the new ZFPLabServer

- **Date:** 2026-09-29, 19:44-19:48 EAT
- **Requested:** Try the journal read again on the newly installed ZFPLabServer, to see which sales the device has filed since 22 Sep.
- **Outcome:** **The journal can be read, and it shows exactly one invoice on the device between 22 and 29 Sep: a test entry dated 22 Sep.** No sale from the pilot till was filed. Nothing on the device changed.
- **Branch / base commit:** staging @ 9545b2d. No code changed. RUBIS POS was closed and `settings()` was not sent. Raw replies and the decoded journal are in `C:\rubis-scratch\ej2-2026-09-29\` (outside git); this report has counts and conclusions only.

## 1. The new server

- `ZFPLabServer.exe` **1.9.6.0**, installed 19:37, with its command samples dated 16 Sep 2025.
- `ReadStatus` answered `Code 0` on the first call (the session was already set up), and it reports **22 status bits**. The older definitions give 19. The extra three are the service-contract and update bits, so the server is on the newer definitions. Its `defVer` was not read (that needs `settings()`); this is inferred from the bit count.
- **This is the server on this PC**, not necessarily the till's.

## 2. How the journal is actually retrieved

| Step | Command | Result |
| --- | --- | --- |
| Read to PC, plain | `ReadEJByDate` | `Code 0`, "OK" only. Its definition has an ACK plus and no response fields, so it never returns content. |
| Read to PC, JSON | `ReadEJByDate_JSON`, dates as `dd-MM-yyyy HH:mm:ss` | `Code 0`, `Length = 605`. The device says it holds 605 bytes and does not send them. |
| Fetch the bytes | **`RawRead`, `Count = 605`, sent once** | `Code 0`, the 605 bytes as base64 (on your approval; the phase 188 brief had put `RawRead` on the forbidden list). |

- The length command has to be followed immediately by the raw read: the device closes an idle connection after 180 s, so the earlier length read had expired by the time you approved. It was reissued and read back to back.
- The same pair works for `ReadEJByTraderSystemInvNum_JSON` (one sale by its reference) and `ReadEJByCUInvoiceNum_JSON`.

## 3. What the journal holds for 22-29 Sep

- **One invoice** in the range. It is the device's last invoice, `…000809`, dated 22-09-26 (15:03 device time), and it matches `ReadDiagnostics` (`LastInvoiceCUNum`, `LastInvoiceDate`, `InvoicesSent 0001`).
- **It is a test entry, not a real sale:** its single item's description reads as a test label.
- **Its trader-system number does not follow this POS's format.** This POS sends `INV-` plus the sale number padded to nine digits; this invoice's number is a short plain number. So it did not come from a build of this POS that uses that format.
- **Nothing from 23 to 29 Sep**, in particular none of the pilot till's stuck sales. It also contains no other invoice for the whole range.
- The journal reply ends with a few bytes of binary after the closing braces (probably a signature); the JSON before it parses cleanly.

## 4. What this means

1. **The stuck sales on the pilot till were not filed by this device.** Any sale rung up on that till after 22 Sep is not in its journal, so it is safe to resend the real ones from Needs Attention. The test ones can be left alone.
2. **Nothing is at risk of double filing** for those sales.
3. **The end-of-day is still not shown as sent.** After the Z report at 17:40, `LastEODDate` still reads `210926` at 19:48 (`docs/phase-189.md` §3). The journal read does not settle that; VIL still needs to be asked.
4. **The device clock is still about 6 minutes slow** (phase 188).

## 5. Follow-ups (none acted on)

- **The app does not read the journal.** Checking one stuck sale by its reference would be `ReadEJByTraderSystemInvNum_JSON` with `INV-<number padded to 9>`, followed by `RawRead`. Building this into the app is a separate decision, and `RawRead` remains outside the app's command set.
- **Tell VIL** the end-of-day is still not showing as sent, and ask them to confirm which server definitions version the till runs.
