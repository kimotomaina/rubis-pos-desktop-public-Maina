/**
 * Sends raw ESC/POS bytes to a Windows printer queue (USB or COM/serial,
 * docs/phase-174).
 *
 * `node-thermal-printer`'s own `printer:<name>` interface
 * (`node_modules/node-thermal-printer/lib/interfaces/printer.js`) needs a
 * `driver` object passed at construction — in practice the native
 * `printer` npm module — which this project deliberately avoids (see
 * `printer.ts`'s module doc: a second fragile native build alongside
 * `better-sqlite3`). Instead this module shells out to a bundled
 * PowerShell script (`resources/print-raw.ps1`) that opens the queue
 * directly via the Win32 winspool API — Microsoft, "Sending Data
 * Directly to a Printer": OpenPrinter, StartDocPrinter (`pDatatype`
 * `"RAW"`), StartPagePrinter, WritePrinter, EndPagePrinter,
 * EndDocPrinter, ClosePrinter
 * (https://learn.microsoft.com/en-us/windows/win32/printdocs/sending-data-directly-to-a-printer).
 *
 * The printer name is untrusted input — typed nowhere; it only ever
 * comes from `getPrintersAsync()` (Electron, "Get the system printer
 * list": https://www.electronjs.org/docs/latest/api/web-contents) or a
 * previously saved config — but is still passed to `execFile` as a
 * discrete argument, never interpolated into a shell command string, so
 * it cannot be used to inject a second command.
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type { PrinterConfig } from './database.js'

/**
 * Bounds how long a RAW print job may take before it's treated as
 * failed and the caller falls back to PDF (docs/phase-174) — mirrors
 * `PRINTER_CONNECT_TIMEOUT_MS`'s role for the network route, just
 * longer: a Windows print spooler round trip (spawn PowerShell, open
 * the queue, write the job) is slower than a bare TCP connect.
 */
export const WINDOWS_PRINT_TIMEOUT_MS = 15_000

/** Sends a printer name + ESC/POS buffer to a Windows queue. Swapped out in tests. */
export type WindowsPrintSender = (printerName: string, buffer: Buffer) => Promise<void>

/**
 * Resolves the bundled `print-raw.ps1` script's path — packaged
 * (`extraResources` in `electron-builder.yml`) vs dev, mirroring
 * `main/index.ts`'s `ICON_PATH` resolution for `resources/icons/icon.ico`.
 *
 * @returns {string}
 */
export function resolvePrintRawScriptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'print-raw.ps1')
    : join(__dirname, '../../resources/print-raw.ps1')
}

/**
 * Writes `buffer` to a temp file in the app's own temp folder and sends
 * it RAW to the named Windows printer queue via `print-raw.ps1`. The
 * temp file is always removed afterwards, whether the send succeeded or
 * failed — it holds nothing sensitive (an ESC/POS receipt render) but
 * has no reason to persist.
 *
 * `printerName` must be `PrinterInfo.name` (the OS queue name), never
 * `displayName` — see `PrinterConfig.interfaceName`'s doc comment.
 *
 * @param {string} printerName
 * @param {Buffer} buffer
 * @returns {Promise<void>} rejects on a missing printer, a script error, or a timeout
 */
export const sendRawToWindowsPrinter: WindowsPrintSender = async (printerName, buffer) => {
  const tempFilePath = join(app.getPath('temp'), `rubis-print-${randomUUID()}.bin`)
  await writeFile(tempFilePath, buffer)
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          resolvePrintRawScriptPath(),
          '-PrinterName',
          printerName,
          '-DataPath',
          tempFilePath
        ],
        { timeout: WINDOWS_PRINT_TIMEOUT_MS, windowsHide: true },
        (err) => {
          if (err) reject(err)
          else resolve()
        }
      )
    })
  } finally {
    await unlink(tempFilePath).catch(() => {
      // Best-effort cleanup — a leftover temp file is not worth failing the print over.
    })
  }
}

/** One entry from `webContents.getPrintersAsync()`, shaped for the Admin screen's "Find printers" cards. */
export interface WindowsPrinterInfo {
  /** The OS queue name (`PrinterInfo.name`) — what gets saved and sent to. */
  name: string
  /** The name shown in Print Preview — what the card displays. */
  displayName: string
  /** The port, when the platform-specific `options` bag happens to expose one. */
  port?: string
}

/**
 * Shapes one `Electron.PrinterInfo` into a {@link WindowsPrinterInfo}
 * card — a pure mapper, split out of the `printers:find-windows` IPC
 * handler so it's unit-testable without Electron itself (that handler's
 * own wiring, like every other IPC handler in this codebase, is not
 * unit tested — see `printer.ts`'s `shouldMarkReceiptPrinted` doc for
 * the same reasoning). `options` is typed as an empty interface by
 * Electron (platform-specific, variable keys) so `port` is read
 * defensively and left out when absent, rather than guessed.
 *
 * @param {Electron.PrinterInfo} info
 * @returns {WindowsPrinterInfo}
 */
export function toWindowsPrinterInfo(info: Electron.PrinterInfo): WindowsPrinterInfo {
  const options = info.options as Record<string, string> | undefined
  const port = options?.['port']
  return {
    name: info.name,
    displayName: info.displayName,
    ...(port ? { port } : {})
  }
}

/** A saved printer config, with whether its Windows queue is still installed (docs/phase-174). */
export type PrinterWithAvailability = PrinterConfig & { missing?: boolean }

/**
 * Flags every saved `connectionType: 'windows'` printer whose queue name
 * is no longer among `availableNames` — re-checked whenever the Admin
 * screen's Peripherals > Printer tab loads the list (`printers:list`),
 * which includes the first load after app start. A `'network'` printer
 * (or a pre-phase-174 config with no `connectionType`) is never flagged
 * here; its own reachability is checked at print time instead, exactly
 * as before.
 *
 * Pure function, split out for the same testability reason as
 * {@link toWindowsPrinterInfo}.
 *
 * @param {PrinterConfig[]} configs
 * @param {string[]} availableNames — every `PrinterInfo.name` `getPrintersAsync()` currently reports
 * @returns {PrinterWithAvailability[]}
 */
export function markMissingWindowsPrinters(
  configs: PrinterConfig[],
  availableNames: string[]
): PrinterWithAvailability[] {
  const available = new Set(availableNames)
  return configs.map((config) =>
    config.connectionType === 'windows' && !available.has(config.interfaceName)
      ? { ...config, missing: true }
      : config
  )
}
