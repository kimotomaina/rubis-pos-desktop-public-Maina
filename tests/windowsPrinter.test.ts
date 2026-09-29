/**
 * Windows RAW printer route tests (docs/phase-174).
 *
 * `child_process.execFile` and `fs/promises` are mocked so no real
 * PowerShell process or temp file is ever touched — the same
 * dependency-injection philosophy as `printer.test.ts`'s recording
 * fake, applied here at the module-mock level since `execFile` isn't
 * already behind an injectable seam (there is nothing to fake it with
 * inside `sendRawToWindowsPrinter` itself; the seam this codebase
 * exposes for tests is `WindowsPrintSender`, one level up in `printer.ts`).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tmpdir } from 'node:os'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  sendRawToWindowsPrinter,
  resolvePrintRawScriptPath,
  toWindowsPrinterInfo,
  markMissingWindowsPrinters,
  WINDOWS_PRINT_TIMEOUT_MS
} from '../src/main/services/windowsPrinter.js'
import type { PrinterConfig } from '../src/main/services/database.js'

type ExecFileCallback = (err: Error | null) => void

const execFileMock =
  vi.fn<(cmd: string, args: string[], opts: object, cb: ExecFileCallback) => void>()
const writeFileMock = vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined)
const unlinkMock = vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined)

vi.mock('node:child_process', () => {
  const execFile = (cmd: string, args: string[], opts: object, cb: ExecFileCallback) =>
    execFileMock(cmd, args, opts, cb)
  return { execFile, default: { execFile } }
})

vi.mock('node:fs/promises', () => {
  const writeFile = (...args: unknown[]) => writeFileMock(...args)
  const unlink = (...args: unknown[]) => unlinkMock(...args)
  return { writeFile, unlink, default: { writeFile, unlink } }
})

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => tmpdir()),
    isPackaged: false
  }
}))

beforeEach(() => {
  execFileMock.mockReset()
  writeFileMock.mockClear()
  unlinkMock.mockClear()
})

describe('sendRawToWindowsPrinter', () => {
  it('sends the printer name as a discrete execFile argument, never a shell string', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null))

    await sendRawToWindowsPrinter('EPSON-TM-T88', Buffer.from('hello'))

    expect(execFileMock).toHaveBeenCalledTimes(1)
    const [command, args, options] = execFileMock.mock.calls[0]
    expect(command).toBe('powershell.exe')
    expect(Array.isArray(args)).toBe(true)
    // The printer name is one discrete array element, not concatenated
    // into any other argument — proves no shell interpolation is possible.
    expect(args).toContain('EPSON-TM-T88')
    expect(args.some((a: string) => a.includes('EPSON-TM-T88;'))).toBe(false)
    expect(options).toMatchObject({ timeout: WINDOWS_PRINT_TIMEOUT_MS })
  })

  it('a printer name containing shell metacharacters is still a single argument', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null))
    const dangerousName = 'PRN & calc.exe'

    await sendRawToWindowsPrinter(dangerousName, Buffer.from('hello'))

    const [, args] = execFileMock.mock.calls[0]
    expect(args).toContain(dangerousName)
  })

  it('writes the buffer to a temp file, then removes it on success', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null))
    const buffer = Buffer.from([0x1b, 0x40])

    await sendRawToWindowsPrinter('EPSON-TM-T88', buffer)

    expect(writeFileMock).toHaveBeenCalledTimes(1)
    expect(writeFileMock.mock.calls[0][1]).toBe(buffer)
    const tempPath = writeFileMock.mock.calls[0][0] as string
    expect(unlinkMock).toHaveBeenCalledWith(tempPath)
  })

  it('removes the temp file even when the script fails', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(new Error('printer offline')))

    await expect(sendRawToWindowsPrinter('EPSON-TM-T88', Buffer.from('x'))).rejects.toThrow(
      'printer offline'
    )

    expect(unlinkMock).toHaveBeenCalledTimes(1)
  })

  it('removes the temp file even when the process times out', async () => {
    const timeoutErr = Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' })
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(timeoutErr))

    await expect(sendRawToWindowsPrinter('EPSON-TM-T88', Buffer.from('x'))).rejects.toThrow()

    expect(unlinkMock).toHaveBeenCalledTimes(1)
  })

  it('bounds the print job at 15 seconds', () => {
    expect(WINDOWS_PRINT_TIMEOUT_MS).toBe(15_000)
  })

  it('resolves the bundled script path relative to the source tree in dev', () => {
    expect(resolvePrintRawScriptPath()).toMatch(/resources[\\/]print-raw\.ps1$/)
  })
})

/**
 * String check only — the mocks above never run the actual PowerShell
 * body (this file's own header comment), so it can't catch a compile
 * error inside the here-string. Phase 179: Add-Type's -MemberDefinition
 * snippet compiles inside a generated class body, where a `using`
 * directive is invalid syntax and failed on a real till.
 */
describe('print-raw.ps1: no `using` line in the Add-Type here-string (docs/phase-179)', () => {
  it('the -MemberDefinition snippet contains no line starting with "using "', () => {
    const script = readFileSync(join(process.cwd(), 'resources', 'print-raw.ps1'), 'utf8')
    const start = script.indexOf("@'")
    const end = script.indexOf("'@", start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)

    const hereString = script.slice(start, end)
    expect(hereString).not.toMatch(/^using /m)
  })
})

/**
 * Phase 182: StartDocPrinter binds the Unicode (W) export, so DOC_INFO_1's
 * strings must be Unicode too. A per-field LPStr overrides the struct's
 * CharSet, and the spooler then read a garbled pDatatype (error 1804 on
 * the pilot till). String checks only, for the same reason as above.
 */
describe('print-raw.ps1: DOC_INFO_1 strings match the Unicode entry point (docs/phase-182)', () => {
  const script = readFileSync(join(process.cwd(), 'resources', 'print-raw.ps1'), 'utf8')
  const hereString = script.slice(script.indexOf("@'"), script.indexOf("'@", script.indexOf("@'")))
  const codeLines = hereString.split(/\r?\n/).filter((line) => !line.trim().startsWith('//'))

  /** The attribute line directly above the first line matching `declaration`. */
  function attributeAbove(declaration: RegExp): string {
    const index = codeLines.findIndex((line) => declaration.test(line))
    expect(index).toBeGreaterThan(0)
    return codeLines[index - 1]
  }

  it('marshals no string as LPStr (ANSI), only LPWStr', () => {
    expect(codeLines.filter((line) => /\bLPStr\b/.test(line))).toEqual([])
    expect(codeLines.filter((line) => /UnmanagedType\.LPWStr/.test(line))).toHaveLength(3)
  })

  it('declares CharSet.Unicode on both DOC_INFO_1 and StartDocPrinter', () => {
    expect(attributeAbove(/public struct DOCINFOA/)).toMatch(/CharSet\s*=\s*CharSet\.Unicode/)
    expect(attributeAbove(/extern bool StartDocPrinter\(/)).toMatch(/CharSet\s*=\s*CharSet\.Unicode/)
  })
})

describe('toWindowsPrinterInfo', () => {
  it('maps name and displayName straight through', () => {
    const info = toWindowsPrinterInfo({
      name: 'EPSON-TM-T88',
      displayName: 'EPSON TM-T88 Receipt',
      description: '',
      options: {}
    } as Electron.PrinterInfo)

    expect(info).toEqual({ name: 'EPSON-TM-T88', displayName: 'EPSON TM-T88 Receipt' })
  })

  it('includes port when options exposes one', () => {
    const info = toWindowsPrinterInfo({
      name: 'EPSON-TM-T88',
      displayName: 'EPSON TM-T88 Receipt',
      description: '',
      options: { port: 'USB001' }
    } as unknown as Electron.PrinterInfo)

    expect(info.port).toBe('USB001')
  })

  it('leaves port out entirely when options does not expose one', () => {
    const info = toWindowsPrinterInfo({
      name: 'EPSON-TM-T88',
      displayName: 'EPSON TM-T88 Receipt',
      description: '',
      options: {}
    } as Electron.PrinterInfo)

    expect('port' in info).toBe(false)
  })
})

describe('markMissingWindowsPrinters', () => {
  const windowsPrinter: PrinterConfig = {
    id: 'till-1',
    type: 'receipt',
    interfaceName: 'EPSON-TM-T88',
    enabled: true,
    connectionType: 'windows'
  }
  const networkPrinter: PrinterConfig = {
    id: 'kitchen-1',
    type: 'kitchen',
    interfaceName: 'tcp://192.168.0.52:9100',
    enabled: true,
    connectionType: 'network'
  }

  it('flags a windows printer whose queue is no longer installed', () => {
    const result = markMissingWindowsPrinters([windowsPrinter], [])

    expect(result).toEqual([{ ...windowsPrinter, missing: true }])
  })

  it('leaves a windows printer unflagged when its queue is still installed', () => {
    const result = markMissingWindowsPrinters([windowsPrinter], ['EPSON-TM-T88'])

    expect(result).toEqual([windowsPrinter])
  })

  it('never flags a network printer, whatever the available queues are', () => {
    const result = markMissingWindowsPrinters([networkPrinter], [])

    expect(result).toEqual([networkPrinter])
  })

  it('never flags a pre-phase-174 config with no connectionType', () => {
    const legacyPrinter: PrinterConfig = {
      id: 'till-1',
      type: 'receipt',
      interfaceName: 'tcp://192.168.0.50:9100',
      enabled: true
    }

    const result = markMissingWindowsPrinters([legacyPrinter], [])

    expect(result).toEqual([legacyPrinter])
  })
})
