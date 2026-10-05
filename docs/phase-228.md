# Phase 228 — The Z report and the printer status use the receipt printer; `till.log` for failures

- **Date:** 2026-10-05
- **Requested:** Nigel's rulings of 2026-10-05 (19:10 and 19:35), after the urgent audit: the Z report said "Printer offline" while receipts printed, because it was sent to the default printer settings instead of the printer list receipts use.
- **Started from:** the parked patch `C:\Users\paulc\parked\printer-z-registry-2026-10-05.patch` (145 lines, an uncommitted edit that was taken out of the working tree). The approach was approved; **the code here was written fresh**, with the additions the audit asked for. Nothing was copied, and the patch's wrong phase label ("phase 227") was not carried over. The patch file is left in place.
- **Status:** built and tested. **Not installed, not published, no release built.**
- **Layout: not checked by check:fit (owner's rule). For the owner to check on the till.** The only screen change is the status list's printer row (grey, "Status unknown") and one word in the connectivity window.
- **Not changed:** what the Z report contains, receipts, the Test button's pages, anything fiscal, checkout, the default-settings fallback.
- **Read from the release commit:** how a receipt finds its printer, from `git show 5e5bda8:…` (2.2.2).

## 1. Cause (recap)

At 2.2.2 the Z handler called `printZReport(report, printerSettings)`: the default settings (`VITE_PRINTER_INTERFACE`, or `tcp://192.168.0.100:9100`), not the printer list. Receipts call `resolvePrinterSettings(registry, 'receipt', default)` first. The status dot did the same wrong thing: `checkTcpReachable(printerSettings.interfaceName)`. 2.2.2's bundled `.env` carries `tcp://192.168.1.50:9100`.

## 2. What changed

| Where | Change |
| --- | --- |
| `printZReportToType` ([printer.ts](../src/main/services/printer.ts)) | Finds the printer with **`resolvePrinterSettings`**, the one function `printOrderSlips` (receipts) calls: the first enabled `receipt` printer in the list, otherwise the default settings. Network or Windows queue, as receipts. `printZReport` takes the Windows sender as an extra argument so tests can inject it. **No PDF fallback.** The Z handler in [index.ts](../src/main/index.ts) now calls it; no other print used the default settings alone (audit of 2.2.2). |
| `checkReceiptPrinter` (printer.ts) | The status dot's check, through the same lookup. A mock printer reads connected; a network printer is probed at its **own** address; a **Windows queue reads "status unknown"** (`connected: false`, `notApplicable: true`, with an explanation), never connected. `index.ts` passes the live printer list and `checkTcpReachable`. |
| `describePrinter` (printer.ts) | One place that says which printer: a network printer by its type and address, `Printer "Receipt" (tcp://192.168.1.50:9100)`; a Windows queue by its name, `Printer "EPSON TM-T88V"`. `resolvePrinterSettings` now carries the type as `printerLabel` for a registered printer; the default settings (unchanged, so a fallback is still `toEqual` the default) read "Receipt". The Test button's page reads "Test page". |
| Failure messages (printer.ts) | Every message names the printer: `Printer "Receipt" (tcp://192.168.1.50:9100) is offline or unreachable. Check it is switched on and connected.`, `… is unreachable. Check the network connection and that it is switched on.`, `… connection timed out.`, `… reports a problem. Check the paper and try again.`, `… error: <message>`. The same words show for the Z report, an Enjoy slip, a receipt that cannot fall back, and the Test button (network and Windows). No error code or stack. |
| Status list ([NavStatusButton.tsx](../src/renderer/src/components/NavStatusButton.tsx)) | A printer with `notApplicable` is **grey, "Status unknown"**, and does not turn the overall dot red. A probed printer that does not answer is still red "Disconnected". |
| Connectivity window ([ConnectivityModal.tsx](../src/renderer/src/components/ConnectivityModal.tsx)) | Reads "Status unknown" for the printer (M-Pesa still reads "Not applicable"); the explanation is in the existing neutral box. |
| [tillLog.ts](../src/main/services/tillLog.ts) | **`till.log`**: `formatTillLogLine`, `sanitizeTillDetail` (line breaks and control characters become a space, capped at 200 characters), `createTillLog` (appends; never throws), `printOutcomeEntry` (the rule for what a print writes). |
| `till.log` writes ([index.ts](../src/main/index.ts)) | `print-failed` when a Z report, a receipt slip, an Enjoy slip or the Test button's page fails, with the document and the message shown to the cashier; `print-fallback` when a receipt became a PDF because its printer was unreachable, naming the printer. **Failures only: no success lines.** |
| `log:till-event` ([ipcValidator.ts](../src/main/lib/ipcValidator.ts), index.ts, preload `logTillEvent`, `window.d.ts`) | The screen may write **one** event, `shift-state-unreadable`. `tillEventSchema` is a strict object: the event must be on the fixed list (a zod enum; `print-failed` and `print-fallback` are the main process's own and are refused), the detail must be text, is flattened to one line and capped, and any other field is refused. The handler records only what the schema returned. |
| Cart shift state ([shiftStore.ts](../src/renderer/src/stores/shiftStore.ts)) | On a failure it still logs to the console and now also calls `logTillEvent` with the message (text, never an error object). A missing or failing log call never throws; the notice stays hidden either way. |
| [KNOWN_GAPS.md](KNOWN_GAPS.md) | Four entries (section 6). |

### Where `till.log` is

`till.log` sits next to `error.log` in the app's user-data folder: `join(app.getPath('userData'), 'till.log')` ([index.ts](../src/main/index.ts)). On the till that is normally **`C:\Users\<the Windows user>\AppData\Roaming\RUBIS POS\till.log`** (paste `%APPDATA%\RUBIS POS\` into File Explorer's address bar; if that folder does not exist, try `%APPDATA%\rubis-pos-desktop\`). `error.log` stays for crashes only. A line looks like:

```
[2026-10-05T16:20:11.000Z] [print-failed] Z report for shift #1: Printer "Receipt" (tcp://192.168.1.50:9100) is offline or unreachable. Check it is switched on and connected.
[2026-10-05T16:21:40.000Z] [print-fallback] receipt for order #7: Printer "Receipt" (tcp://192.168.1.50:9100) was unreachable, saved as a PDF
[2026-10-05T16:22:03.000Z] [shift-state-unreadable] database locked
```

**Never in a line:** a PIN, a token, a password, the contents of an order, a raw error object or a stack. Only the fixed event name, the document, the printer and the message already shown to the cashier go in.

## 3. Existing assertions changed

**None.** No existing test needed an edit: the fallback settings are still `toEqual` the default, no test asserted a printer message string, and the status tests only add rows. The full suite was green before any new test was added.

## 4. Tests

- **New files:** [printerZReport.test.ts](../tests/printerZReport.test.ts) (19), [tillLog.test.ts](../tests/tillLog.test.ts) (22), [printerStatusUnknown.test.ts](../tests/printerStatusUnknown.test.ts) (7). 48 tests.
- **Z report:** goes to the registered network printer and never the default address; to the registered Windows queue (bytes sent to the queue, the network never touched); falls back to the default exactly as a receipt does when the list is empty; ignores a disabled printer; finds its printer with the same function as a receipt; no PDF fallback (an offline printer is a failure with no data); the handler calls `printZReportToType` and no longer calls `printZReport(report, printerSettings)`.
- **Messages:** a network printer by type and address; the default by its address; a Windows queue by name and no address; a refused connection, a timeout and a paper fault; the Test button, network and Windows; `describePrinter`; no code or stack in a message.
- **Status dot:** probes the registered address, not the default; the default when the list is empty; a Windows queue is never connected, is not probed, and says its status cannot be read; a mock reads connected; the monitor calls `checkReceiptPrinter` with the live list. Header list and connectivity window: "Status unknown", grey, overall dot not red; a probed printer that does not answer is still red; one that answers is green; M-Pesa still "Not applicable".
- **`till.log`:** the line shape; control characters and line breaks removed; the cap and its mark; the three events and the one the screen may write; one append per record to the file given; a write failure never throws; `till.log` is created next to `error.log`; failures and fallbacks only (a success, an absent slip and a mock print write nothing); a result carrying a PIN, a stack and order items yields a line with none of them; the main process writes after the Z report, a receipt slip, an Enjoy slip and the Test button.
- **`log:till-event`:** accepts the one event, with or without a detail; **refuses an unknown event name** and the main process's own print events, an empty, wrong-case or padded name, a number, null, a missing event and a non-object; refuses any extra field (so `managerPin` or an object cannot ride along); refuses a detail that is not text; **caps the detail** and removes line breaks; the handler records only what the schema returned.
- **Cart:** a refusal and a thrown error each send `shift-state-unreadable` with the message as text; no stack; nothing for a shift that was read; a missing or failing log call does not throw and the notice stays hidden.

### Mutation checks (each restored; 98 tests green again after)

| # | Mutation | Test that failed |
| --- | --- | --- |
| 1 | The Z report back on the default settings (`printZReportToType` ignores the list) | 5: `goes to the registered network printer, never the default address`; `goes to the registered Windows queue…`; `names a network printer by its type and address when it is offline`; `names a Windows queue by its name alone…`; `names the printer for a refused connection, a timeout and a paper fault` |
| 2 | The status dot back on the default address | 2: `probes the registered network printer, never the default address`; `never shows a Windows queue as connected…` |
| 3 | `log:till-event` accepts any event name (`z.string()`) | `log:till-event > refuses an unknown event name, and the main process's own print events` |

## 5. Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean (node and web) |
| Full suite (`npx vitest run`) | **211 files, 3502 passed, 1 skipped, 0 failed** (208 files and 3454 tests before: +3 files, +48 tests). `tests/updateBackup.test.ts`, the known failure, did not fail in this run. |
| M-Pesa payment gate (`mpesaPaymentGate`, `mpesaManualPayment`, `paymentModal`, `mpesaPaymentPoller`) | 4 files, **76** passed |
| Fiscal suite (`fiscal*`, `etims*`, `realEtimsProvider`, `posCheckoutPanelFiscalGate`) | 25 files, **512** passed |
| Layout rule files (`noUnexpectedScroll`, `screensFitDesignBox`, `belowLgUnreachable`, `scale`, `posCheckoutPanelFit`) | 5 files, **96** passed |
| `npm run build` | passes; "Confirmed: neither mock provider is in out/main." |

Layout: not checked by check:fit (owner's rule). For the owner to check on the till.

### For the owner to check on the till (after the release is installed, after trading closes)

1. **The Z report for shift #1 prints**, on the same printer as receipts.
2. **A receipt prints.**
3. **The Test button prints** (Admin → Peripherals → Printers).
4. **The status dot is right.** A network printer that is on reads Connected; one that is off reads Disconnected, red; a Windows-queue printer reads "Status unknown", grey, and does not turn the header's dot red.
5. **A failure is named.** With the printer off, print the Z report: the message names the printer by type and address (or queue name), and a line appears in `till.log`.
6. **`till.log`** exists next to `error.log` after a failure (path in section 2) and holds no PIN and no order contents.

## 6. Observed but not changed

- **`printReceiptToType` is never called** (receipts go through `printOrderSlips`); recorded in `KNOWN_GAPS.md`.
- **2.2.2's bundled `.env` carries `tcp://192.168.1.50:9100`**; a till with an empty printer list falls back to it. Recorded. The build does not refuse a printer address in `.env` (it refuses credentials).
- **The 30-second probe now hits the real printer** and could rarely clash with a print on a printer that takes one connection at a time. Left as is, as ruled; any clash shows in `till.log`. Recorded.
- **`till.log` is not rotated**; about 150 bytes per failure. Recorded.
- **The label is the printer's type, not a name.** A printer in the list has no name field, so the quoted `"Receipt"` is its type. A kitchen or label printer that falls back to the default address is also called "Receipt".
- **The detail the screen sends is the message the main process gave it** (for example a database error text). It is flattened and capped, but it is free text from a trusted source, not a fixed list.
- **A mock print is not logged** (it is a success), and the Z report's PDF fallback does not exist, so a Z failure is always `print-failed`.
- The `Encoding not recognized: 'undefined'` line in the test output comes from `node-thermal-printer` on the Windows route and was there before this phase.

## 7. Not verified

- That `till.log` is written to a real disk in the packaged app: the tests inject the file-append function. The user-data folder name is read from the code and from the earlier `error.log` path, not from a till.
- A real Z print on the till's printer (network or Windows queue) and a real Windows-queue "status unknown" in the status list.
- Whether a real receipt printer ever refuses a print because of the 30-second probe.
- The layout of the grey printer row on the till.

## 8. Rollback

Revert this phase's commit. The Z report goes back to the default printer settings, the status dot to the default address, failure messages to their old words, and `till.log` stops being written (an existing `till.log` is left on disk, unread). Nothing stored, no setting and no schema changed.
