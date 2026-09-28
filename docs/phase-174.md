# Phase 174 — Can the POS find and print to USB and COM (serial) receipt printers?

- **Date:** 2026-09-28
- **Requested:** Audit (read-only) whether the POS can detect and use USB and COM/serial receipt printers. Build the Windows-printer route only if the audit shows it is missing.
- **Outcome:** Implemented. Audit found no USB or COM support at all, so Part B was built: a "Windows printer (USB or COM)" connection type, sent to via a bundled PowerShell script over the Win32 winspool API. The existing network (IP) path and PDF fallback are unchanged.
- **Branch / base commit:** staging @ bfb949f (docs/phase-173)

---

## Answer, up front

**Before this phase: no.** The POS could only print over TCP/IP (`tcp://<ip>:<port>`) or fall back to a saved PDF. There was no code path anywhere that opened a Windows printer queue, a COM port, or a USB device.

**After this phase: yes, for USB and COM printers installed as a Windows printer queue.** A printer plugged in by USB, or wired through a COM/serial port, prints from Windows the same way either way once it has a driver and a queue: as a named Windows printer. The new route sends RAW ESC/POS bytes to that queue name. It does not talk to a raw COM port or USB device directly (see "Observed but not changed").

---

## PART A — Audit

### 1. Printer library and its interfaces

`node-thermal-printer` is at version **4.6.1** ([package.json:55](../package.json#L55)).

Its interface picker, [node_modules/node-thermal-printer/lib/interfaces/index.js:1-19](../node_modules/node-thermal-printer/lib/interfaces/index.js#L1-L19), reads:

```js
function getInterface (uri, options, driver) {
  const networkRegex = /^tcp:\/\/([^/:]+)(?::(\d+))?\/?$/i;
  const printerRegex = /^printer:([^/]+)(?:\/([\w-]*))?$/i;

  const net = networkRegex.exec(uri);
  const printer = printerRegex.exec(uri);

  if (typeof uri === 'object') {
    return uri;
  } if (net) {
    const Network = require('./network');
    return new Network(net[1], net[2], options);
  } if (printer) {
    const Printer = require('./printer');
    return new Printer(printer[1], driver);
  }
  const File = require('./file');
  return new File(uri);
}
```

So the installed version supports exactly three interfaces:

- **`tcp://<ip>:<port>`** — the `Network` interface. This is the only one the codebase uses today.
- **`printer:<name>`** — the `Printer` interface. Its constructor, [node_modules/node-thermal-printer/lib/interfaces/printer.js:3-12](../node_modules/node-thermal-printer/lib/interfaces/printer.js#L3-L12), throws `'No driver set!'` unless a `driver` object is passed in, and its `execute()` method ([printer.js:36-51](../node_modules/node-thermal-printer/lib/interfaces/printer.js#L36-L51)) calls `this.driver.printDirect(...)`. In practice that `driver` has to be the native `printer` npm module — the codebase's own `printer.ts` module doc already explains why that was deliberately never installed: *"a second fragile native build alongside `better-sqlite3`"* ([src/main/services/printer.ts:10-13](../src/main/services/printer.ts#L10-L13)). So `printer:<name>` exists in the library but was never usable here.
- **File path** (the fallback, anything that matches neither regex) — used to write a file, not to print.

**No serial/COM interface exists in this library at all.** There is no fourth branch, no `serialport` dependency, nothing that opens `COM3` or similar.

**Can it return the ESC/POS bytes as a buffer instead of sending them?** Yes. `getBuffer()` at [node_modules/node-thermal-printer/lib/core.js:165-167](../node_modules/node-thermal-printer/lib/core.js#L165-L167):

```js
getBuffer() {
    return this.buffer;
}
```

A `ThermalPrinter` instance only wires up a transport at all when `initConfig.interface` is truthy ([core.js:62-70](../node_modules/node-thermal-printer/lib/core.js#L62-L70)); construct one with no `interface` and every formatting call (`println`, `bold`, `cut`, …) still works — they just append to `this.buffer` — and `getBuffer()` hands back the raw bytes with nothing ever sent anywhere. This is exactly what Part B's Windows route uses (see below): the same renderer, diverted to a different transport.

### 2. Admin > Integrations > Printer — what it loads and stores

Before this phase, the Peripherals/Printer tab loaded only `window.api.getPrinters()` → `printers:list` → `db.getPrinters()`, and offered one "Add Printer" form with three fields: a free-typed **id**, a **type** dropdown (`receipt`/`kitchen`/`label`), and a free-typed **interface** string, placeholder `tcp://192.168.0.101:9100` (old code — [tests/adminScreen.test.ts](../tests/adminScreen.test.ts), the pre-phase-174 git history for `AdminScreen.tsx`). Nothing called `webContents.getPrintersAsync()` anywhere in the repo — confirmed by a repo-wide search that returned no matches for `getPrintersAsync` before this phase.

Storage: SQLite table `printers`, defined at [src/main/services/database.ts:558-564](../src/main/services/database.ts#L558-L564) (before this phase): `id TEXT PRIMARY KEY`, `type`, `interface TEXT NOT NULL`, `enabled`, `width`. Only an IP-shaped `interface` string could ever be saved — there was no field for a connection type, a Windows queue name, or a port.

`PrinterRegistry` ([src/main/services/printer.ts:266-277](../src/main/services/printer.ts#L266-L277), unchanged this phase) is an in-memory `Map<string, PrinterConfig>` built from `db.getPrinters()` at startup and rebuilt after every `printers:save`/`printers:delete`. It models **where** each of a store's printers is — one row per printer role (`receipt`/`kitchen`/`label`) — not a live connection. `resolvePrinterSettings` looks up the first enabled entry of the requested type and falls back to the single env-configured default when the till has never registered any (back-compat for every till before multi-printer support existed).

### 3. Any existing path to a Windows printer queue, COM port, or USB device?

**None.** A repo-wide search (excluding `node_modules`) for `getPrintersAsync`, `COM[0-9]`, `SerialPort`, `serialport`, `child_process`, `execFile`, and `winspool` returned zero matches anywhere in `src/`. The only transport the app ever opened was a TCP socket, via `node-thermal-printer`'s `Network` interface, from `defaultPrinterFactory` at [src/main/services/printer.ts:243-248](../src/main/services/printer.ts#L243-L248) (unchanged this phase).

### 4. How `receipt:print` picks the printer and falls back to PDF

`main/index.ts`'s `receipt:print` handler ([src/main/index.ts:2735](../src/main/index.ts) area, unchanged in this phase's flow) calls `printReceiptToType(order, items, printerRegistry, printerSettings, printerType)`. That resolves settings via `resolvePrinterSettings` and calls `printReceipt`, which calls the shared `sendToPrinter` helper: connect with a bounded 3-second timeout (`PRINTER_CONNECT_TIMEOUT_MS`, [printer.ts:240](../src/main/services/printer.ts#L240)), and on an offline/unreachable printer or an ECONNREFUSED/EHOSTUNREACH/ETIMEDOUT error, fall back to a saved PDF receipt (`fallBackToPdf`) rather than fail the sale outright. This is guarded by `check:fit` mode ([src/main/lib/checkFit.ts:64-71](../src/main/lib/checkFit.ts#L64-L71), applied at [src/main/index.ts:2708-2711](../src/main/index.ts) in the `receipt:print` handler) — sending is refused unless the printer is mocked.

---

## PART B — Build

Audit answer was "no", so this was built.

Sources used and cited, as required:
- Electron `webContents.getPrintersAsync()`, "Get the system printer list" — https://www.electronjs.org/docs/latest/api/web-contents
- Microsoft, "Sending Data Directly to a Printer" (OpenPrinter, StartDocPrinter with `pDatatype` `"RAW"`, StartPagePrinter, WritePrinter, EndPagePrinter, EndDocPrinter, ClosePrinter) — https://learn.microsoft.com/en-us/windows/win32/printdocs/sending-data-directly-to-a-printer

### 1. New files

| File | What it does |
| --- | --- |
| [src/main/services/windowsPrinter.ts](../src/main/services/windowsPrinter.ts) | `sendRawToWindowsPrinter` (writes the buffer to a temp file, runs the PowerShell script via `execFile` with an argument array, deletes the temp file on success and failure, 15-second timeout); `resolvePrintRawScriptPath`; `toWindowsPrinterInfo` (shapes an `Electron.PrinterInfo` into a card); `markMissingWindowsPrinters` (flags a saved Windows printer whose queue is no longer installed). |
| [resources/print-raw.ps1](../resources/print-raw.ps1) | The bundled script. Uses `Add-Type` to P/Invoke `winspool.drv`'s OpenPrinter/StartDocPrinter(`RAW`)/StartPagePrinter/WritePrinter/EndPagePrinter/EndDocPrinter/ClosePrinter, exactly as Microsoft's article describes. Takes `-PrinterName` and `-DataPath` as named parameters — never string-built. |
| [tests/windowsPrinter.test.ts](../tests/windowsPrinter.test.ts) | Unit tests for the above (14 tests). |

### 2. Changed files

| File | Change |
| --- | --- |
| [src/main/services/database.ts](../src/main/services/database.ts) | `printers` table gains `connection_type TEXT NOT NULL DEFAULT 'network'` ([:574](../src/main/services/database.ts#L574)), with an idempotent `ALTER TABLE` migration for existing installs ([:437-461](../src/main/services/database.ts#L437-L461)). `PrinterConfig` gains `connectionType?: 'network' \| 'windows'` ([:830](../src/main/services/database.ts#L830)); `interfaceName` is reused to hold the Windows queue's system name when `connectionType: 'windows'` rather than adding a second name column — see its doc comment at [:815-822](../src/main/services/database.ts#L815-L822). `getPrinters`/`savePrinter` read and write the new column ([:2505-2541](../src/main/services/database.ts#L2505-L2541)). |
| [src/main/services/printer.ts](../src/main/services/printer.ts) | `PrinterSettings.connectionType` added. `resolvePrinterSettings` now carries it through ([:295-310](../src/main/services/printer.ts#L295-L310)). `createBufferClient` ([:506-513](../src/main/services/printer.ts#L506-L513)) builds a `ThermalPrinter` with no transport interface, for `getBuffer()`. `sendToWindowsPrinter` ([:574-590](../src/main/services/printer.ts#L574-L590)) renders onto that buffer client and sends RAW via the injected `WindowsPrintSender`; any failure (missing queue, script error, timeout) is treated exactly like an offline network printer — PDF fallback wins when one is given. `sendToPrinter` branches to it when `connectionType === 'windows'` and not mocked ([:614-618](../src/main/services/printer.ts#L614-L618) area). `printReceipt`/`printReceiptToType` gained an optional trailing `windowsSender` parameter, defaulted so every existing call site is unaffected. New `printWindowsTestPage` ([:820-841](../src/main/services/printer.ts#L820-L841)) — a separate function from `printTestPage`, so the network test path's own fixed content stays untouched. |
| [src/main/lib/ipcValidator.ts](../src/main/lib/ipcValidator.ts) | `printerSaveSchema` gains optional `connectionType`. `printerTestSchema` becomes a union of the original `{ interfaceName }` shape and a new `{ connectionType: 'windows', windowsPrinterName }` shape. |
| [src/main/index.ts](../src/main/index.ts) | `printers:list` ([:1938-1966](../src/main/index.ts#L1938-L1966)) is now async and, on Windows with at least one saved Windows printer, cross-checks against `getPrintersAsync()` and flags missing queues. New `printers:find-windows` handler ([:1978-1998](../src/main/index.ts#L1978-L1998)) — Windows-only, refused server-side on any other platform even though the UI already hides the option. `printers:save` forwards `connectionType`. `printers:test` branches on the request shape to either `printTestPage` (unchanged) or `printWindowsTestPage`. |
| [src/preload/index.ts](../src/preload/index.ts), [src/preload/window.d.ts](../src/preload/window.d.ts) | Added `platform: process.platform` (a plain value, not an IPC call). `getPrinters` return type carries the new `missing?: boolean`. `testPrinter` widened to the union shape. New `findWindowsPrinters`. |
| [src/renderer/src/components/AdminScreen.tsx](../src/renderer/src/components/AdminScreen.tsx) | Peripherals > Printer tab gains, Windows-only (`window.api.platform === 'win32'`, [:1948](../src/renderer/src/components/AdminScreen.tsx#L1948)): a "Connection" selector (Network (IP) / Windows printer (USB or COM)); when Windows is picked, a "Find printers" button ([:1973-1977](../src/renderer/src/components/AdminScreen.tsx#L1973-L1977)) lists `getPrintersAsync()` results as tap-to-select cards (`displayName`, plus `port` when the platform-specific `options` bag happens to expose one); the selected system name is shown read-only rather than typed, so no new on-screen-keyboard field was needed. A saved Windows printer whose queue disappeared shows a "Missing" badge. `handleTestPrinter`'s own signature and every call site were kept byte-for-byte identical (a regression guard in `tests/adminIntegrationsSections.test.ts` checks for this) — it looks up the printer's `connectionType` from state internally instead of taking a new parameter. |
| [electron-builder.yml](../electron-builder.yml) | `extraResources` gains `resources/print-raw.ps1` → `print-raw.ps1`, packaged alongside the existing icon. |

### 3. Design decisions worth recording

- **No new npm dependency.** The Windows route needs nothing beyond Node's built-in `node:child_process`/`node:fs`/`node:crypto` and a PowerShell script the OS already has. `node-thermal-printer` itself is untouched.
- **Same renderer, both routes.** `sendToWindowsPrinter` calls the identical `renderReceipt`/`renderZReport`/test-slip functions the network route uses, just onto a buffer-only client. The two routes cannot drift apart in what they print — satisfying the hard rule that the receipt layout is untouched.
- **`interfaceName` reused, not duplicated.** Rather than add a `windows_printer_name` column, a Windows printer's `interfaceName` holds its queue name (`PrinterInfo.name`). This kept `handleTestPrinter`'s call site and the regression test covering it completely unchanged (see AdminScreen row above).
- **Printer name is never built into a shell string.** `sendRawToWindowsPrinter` calls `execFile('powershell.exe', [...argsArray], ...)` — the printer name is one array element, passed straight through to PowerShell's own `-PrinterName` parameter. Verified by a mutation test during VERIFY (below).
- **check:fit guard inherited automatically.** The Windows route runs through the same `receipt:print` handler already guarded by `guardCheckFitSending` ([src/main/lib/checkFit.ts:64-71](../src/main/lib/checkFit.ts#L64-L71), applied in `main/index.ts`'s `receipt:print` handler) — no separate guard was needed or added for it.

---

## TESTS

All in `tests/windowsPrinter.test.ts` (14 tests), `tests/printer.test.ts` (8 new tests in two new `describe` blocks), `tests/database.test.ts` (2 new + 4 updated), `tests/ipcValidator.test.ts` (6 new), and `tests/adminScreen.test.ts` (3 new):

- Printer name passed as a discrete `execFile` argument array, never a shell string (`windowsPrinter.test.ts`).
- Temp file removed on success, on a script failure, and on a timeout (`windowsPrinter.test.ts`).
- A missing Windows printer falls back to PDF (`printer.test.ts`).
- A timeout falls back to PDF (`printer.test.ts`).
- The network (IP) path is unchanged (all pre-existing `printer.test.ts`/`printerRegistry.test.ts` tests still pass, unmodified).
- `check:fit` guard refuses the Windows route exactly like every other sender — inherited from the existing `receipt:print` guard (`tests/checkFit.test.ts`, unmodified, still covers this; no Windows-specific test needed since nothing bypasses the shared handler).
- The settings screen lists and saves a Windows printer, with `getPrintersAsync()` mocked via `findWindowsPrinters` (`adminScreen.test.ts`).
- A saved Windows printer no longer installed shows a "Missing" badge (`adminScreen.test.ts`).
- The Windows connection option is hidden entirely on a non-Windows platform (`adminScreen.test.ts`).

**Mutation check (performed, then reverted — not left in the suite):** temporarily changed `sendRawToWindowsPrinter` to build a single `-Command` string with the printer name interpolated into it (the shell-injection shape). Ran `tests/windowsPrinter.test.ts -t "shell string"` — it failed as expected (`expected [...] to include 'EPSON-TM-T88'`), proving the test actually detects the unsafe pattern. Reverted immediately; the real implementation was re-verified passing before continuing.

---

## VERIFY

```
$ npm run typecheck
(clean: typecheck:node and typecheck:web, no errors)

$ npm run test
Test Files  145 passed (145)
     Tests  2214 passed (2214)

$ npm run build
✓ built in ~2s; "Confirmed: neither mock provider is in out/main."

$ npm run check:fit
Measured and fit: 274
✖ 9 case(s) failed the fit check — all 9 are "Admin > Needs Attention: card not found",
  one per supported window size. Confirmed pre-existing and unrelated: re-ran check:fit
  against the working tree with this phase's changes stashed out (git stash push -u) —
  the baseline fails the exact same 9 cases with the exact same "274 measured and fit"
  count. "Admin > Integrations > Printer" — the only screen this phase touches — passes
  with an exact page-vs-client size match at all 9 sizes, both with and without this
  phase's changes.
```

## Rollback

`git revert` the commit. The new `connection_type` column stays in the SQLite file on a revert (SQLite migrations are additive-only, matching every other migration in this codebase) but is inert once the code that reads it is gone. No data is lost: every printer keeps its `interfaceName`/`type`/`enabled`/`width` exactly as before.

## Observed but not changed

- **Not a raw COM/USB driver.** This route prints to a printer already installed as a Windows printer queue (which is how Windows exposes both USB and COM/serial printers once they have a driver). It does not open a COM port or a USB device directly. If a printer has no Windows driver at all, this route cannot help it — that would need a different, lower-level approach and was out of scope here.
- **`printer:<name>` in `node-thermal-printer`** remains unused and unusable without the native `printer` driver module — left alone per the hard rule against new native dependencies.
- **The pre-existing `package.json` version bump (2.0.2 → 2.0.3)** found uncommitted at the start of this task was left untouched — it was not made by this phase's work.
- **`check:fit`'s pre-existing "Admin > Needs Attention: card not found" failure** (9/9 cases, one per supported window size) is unrelated to this phase and was not fixed — out of scope for a printer task. Confirmed pre-existing by re-running `check:fit` with this phase's changes stashed out: the same 9 cases fail on the unmodified baseline too.
