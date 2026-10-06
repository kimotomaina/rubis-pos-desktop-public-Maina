/**
 * Phase 228: `till.log`. Failures only; a fixed list of events; a detail that is one capped line; and nothing
 * secret or raw. The screen can ask for one event only, `shift-state-unreadable`.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  RENDERER_TILL_EVENTS,
  TILL_LOG_DETAIL_MAX,
  TILL_LOG_EVENTS,
  createTillLog,
  formatTillLogLine,
  printOutcomeEntry,
  sanitizeTillDetail
} from '../src/main/services/tillLog.js'
import { tillEventSchema } from '../src/main/lib/ipcValidator.js'
import { useShiftStore } from '../src/renderer/src/stores/shiftStore.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a log line', () => {
  it('is a time, a fixed event name and a detail, on one line', () => {
    const line = formatTillLogLine('print-failed', 'Z report for shift #1: Printer "Receipt" (tcp://192.168.1.50:9100) is offline', new Date('2026-10-05T16:20:11.000Z'))

    expect(line).toBe('[2026-10-05T16:20:11.000Z] [print-failed] Z report for shift #1: Printer "Receipt" (tcp://192.168.1.50:9100) is offline')
  })

  it('has no line breaks or control characters, whatever the detail held', () => {
    const detail = sanitizeTillDetail('first\r\nsecond\nthird\u0000\u001b[31m\u2028fourth   fifth')

    expect(detail).not.toMatch(/[\u0000-\u001f\u2028\u2029]/)
    expect(detail).toBe('first second third [31m fourth fifth')
  })

  it('is cut at the cap and says so', () => {
    const detail = sanitizeTillDetail('x'.repeat(TILL_LOG_DETAIL_MAX + 500))

    expect(detail).toHaveLength(TILL_LOG_DETAIL_MAX)
    expect(detail.endsWith('…')).toBe(true)
    expect(sanitizeTillDetail('x'.repeat(TILL_LOG_DETAIL_MAX))).toHaveLength(TILL_LOG_DETAIL_MAX)
  })

  it('knows five events, and the screen may write only one of them', () => {
    // docs/phase-230: old, three events; `update-failed` is the fourth, written by the main process only.
    // CHANGED (docs/phase-232). OLD: four events. NEW: five; `auto-assign-failed` is written by the main process only.
    expect([...TILL_LOG_EVENTS]).toEqual([
      'print-failed',
      'print-fallback',
      'shift-state-unreadable',
      'update-failed',
      'auto-assign-failed'
    ])
    expect([...RENDERER_TILL_EVENTS]).toEqual(['shift-state-unreadable'])
  })
})

describe('the log file', () => {
  it('appends one line for each record, to the file it was given', () => {
    const appendFileSync = vi.fn()
    const log = createTillLog('C:/data/till.log', { appendFileSync })

    log.record('print-fallback', 'receipt for order #7: x')
    log.record('shift-state-unreadable', 'boom')

    expect(appendFileSync).toHaveBeenCalledTimes(2)
    expect(appendFileSync.mock.calls[0][0]).toBe('C:/data/till.log')
    expect(appendFileSync.mock.calls[0][1]).toMatch(/^\[\d{4}-\d\d-\d\dT[\d:.]+Z\] \[print-fallback\] receipt for order #7: x\n$/)
  })

  it('never throws when the file cannot be written: a log must not stop a sale or a print', () => {
    const log = createTillLog('C:/data/till.log', {
      appendFileSync: () => {
        throw new Error('disk full')
      }
    })

    expect(() => log.record('print-failed', 'x')).not.toThrow()
  })

  it('is created next to error.log, and error.log is left for crashes', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8')

    expect(source).toContain("createTillLog(join(app.getPath('userData'), 'till.log'), { appendFileSync })")
    expect(source).toContain("createFileErrorLogger(join(app.getPath('userData'), 'error.log')")
  })
})

describe('what a print writes', () => {
  it('writes a failure with the document and the message shown to the cashier', () => {
    const entry = printOutcomeEntry(
      'Z report for shift #1',
      { success: false, error: 'Printer "Receipt" (tcp://192.168.1.50:9100) is offline or unreachable. Check it is switched on and connected.' },
      () => 'unused'
    )

    expect(entry).toEqual({
      event: 'print-failed',
      detail: 'Z report for shift #1: Printer "Receipt" (tcp://192.168.1.50:9100) is offline or unreachable. Check it is switched on and connected.'
    })
  })

  it('writes a receipt that became a PDF, naming the printer that was unreachable', () => {
    const entry = printOutcomeEntry(
      'receipt for order #7',
      { success: true, data: { mode: 'pdf' } },
      () => 'Printer "Receipt" (tcp://192.168.1.50:9100)'
    )

    expect(entry).toEqual({
      event: 'print-fallback',
      detail: 'receipt for order #7: Printer "Receipt" (tcp://192.168.1.50:9100) was unreachable, saved as a PDF'
    })
  })

  it('writes nothing for a success, for a slip not asked for, or for a mock print', () => {
    const asked = vi.fn(() => 'unused')

    expect(printOutcomeEntry('x', { success: true, data: {} }, asked)).toBeNull()
    expect(printOutcomeEntry('x', { success: true }, asked)).toBeNull()
    expect(printOutcomeEntry('x', null, asked)).toBeNull()
    expect(asked).not.toHaveBeenCalled()
  })

  it('writes strings only: a result carrying more than the message gives a line with nothing else in it', () => {
    const result = {
      success: false,
      error: 'Printer "Receipt" is offline.',
      managerPin: '2222',
      stack: 'Error: boom\n    at secret (C:/app/secret.js:1:1)',
      order: { items: ['Rice 5kg'] }
    }

    const entry = printOutcomeEntry('receipt for order #7', result, () => '')
    const line = formatTillLogLine(entry!.event, entry!.detail)

    expect(line).not.toContain('2222')
    expect(line).not.toContain('secret')
    expect(line).not.toContain('Rice')
    expect(line).not.toContain('[object Object]')
  })

  it('is written by the main process after a Z report, a receipt slip, an Enjoy slip and the Test button', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8')

    expect(source).toContain("logPrintOutcome(`Z report for shift #${shiftId}`, 'receipt', zResult)")
    expect(source).toContain('logPrintOutcome(`receipt for order #${order.local_id}`, options.printerType, printed.fiscal)')
    expect(source).toContain('logPrintOutcome(`Enjoy slip for order #${order.local_id}`, options.printerType, printed.customer)')
    expect(source).toContain("printOutcomeEntry('test page', tested")
  })
})

describe('log:till-event', () => {
  it('accepts the one event the screen may write, with or without a detail', () => {
    expect(tillEventSchema.safeParse({ event: 'shift-state-unreadable' }).success).toBe(true)
    expect(tillEventSchema.safeParse({ event: 'shift-state-unreadable', detail: 'boom' }).success).toBe(true)
  })

  it('refuses an unknown event name, and the main process\'s own print events', () => {
    for (const event of ['', 'x', 'print-failed', 'print-fallback', 'SHIFT-STATE-UNREADABLE', 'shift-state-unreadable ', 7, null, undefined]) {
      expect(tillEventSchema.safeParse({ event, detail: 'x' }).success).toBe(false)
    }
    expect(tillEventSchema.safeParse({}).success).toBe(false)
    expect(tillEventSchema.safeParse('shift-state-unreadable').success).toBe(false)
  })

  it('refuses any field it was not given, so a PIN or an object cannot ride along', () => {
    expect(tillEventSchema.safeParse({ event: 'shift-state-unreadable', managerPin: '2222' }).success).toBe(false)
    expect(tillEventSchema.safeParse({ event: 'shift-state-unreadable', detail: 'x', order: { id: 1 } }).success).toBe(false)
  })

  it('refuses a detail that is not text', () => {
    for (const detail of [1, {}, ['a'], new Error('x'), null]) {
      expect(tillEventSchema.safeParse({ event: 'shift-state-unreadable', detail }).success).toBe(false)
    }
  })

  it('caps the detail and takes the line breaks out of it', () => {
    const parsed = tillEventSchema.parse({ event: 'shift-state-unreadable', detail: `a\nb\r\n${'z'.repeat(TILL_LOG_DETAIL_MAX * 3)}` })

    expect(parsed.detail).toHaveLength(TILL_LOG_DETAIL_MAX)
    expect(parsed.detail).not.toMatch(/[\r\n]/)
    expect(parsed.detail?.startsWith('a b ')).toBe(true)
  })

  it('is validated by the schema and records only what it returned', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8')
    const start = source.indexOf("'log:till-event'")
    const body = source.slice(start, source.indexOf('ipcMain.handle(', start + 10))

    expect(body).toContain('validate(tillEventSchema, request)')
    expect(body).toContain('tillLog.record(validation.data.event, validation.data.detail ?? \'\')')
    expect(body).not.toContain('request.')
  })
})

describe('the cart\'s shift-state failure reaches the log', () => {
  const writes = (): ReturnType<typeof vi.fn> => {
    const logTillEvent = vi.fn().mockResolvedValue({ success: true })
    return logTillEvent
  }

  it('is sent as the fixed event with the message, for a refusal and for a thrown error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const logTillEvent = writes()
    window.api = { getCurrentShift: vi.fn().mockResolvedValue({ success: false, error: 'database locked' }), logTillEvent } as unknown as typeof window.api
    await useShiftStore.getState().load()
    window.api = { getCurrentShift: vi.fn().mockRejectedValue(new Error('bridge down')), logTillEvent } as unknown as typeof window.api
    await useShiftStore.getState().load()

    expect(logTillEvent).toHaveBeenNthCalledWith(1, 'shift-state-unreadable', 'database locked')
    expect(logTillEvent).toHaveBeenNthCalledWith(2, 'shift-state-unreadable', 'bridge down')
    expect(useShiftStore.getState().presence).toBe('unknown')
  })

  it('sends text, never an error object or a stack', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const logTillEvent = writes()
    window.api = { getCurrentShift: vi.fn().mockRejectedValue(new Error('bridge down')), logTillEvent } as unknown as typeof window.api

    await useShiftStore.getState().load()

    const [event, detail] = logTillEvent.mock.calls[0]
    expect(event).toBe('shift-state-unreadable')
    expect(typeof detail).toBe('string')
    expect(detail).not.toMatch(/\n\s+at /)
  })

  it('writes nothing when the shift was read, whether open or not', async () => {
    const logTillEvent = writes()
    window.api = { getCurrentShift: vi.fn().mockResolvedValue({ success: true, data: null }), logTillEvent } as unknown as typeof window.api
    await useShiftStore.getState().load()
    window.api = { getCurrentShift: vi.fn().mockResolvedValue({ success: true, data: { id: 3 } }), logTillEvent } as unknown as typeof window.api
    await useShiftStore.getState().load()

    expect(logTillEvent).not.toHaveBeenCalled()
  })

  it('still hides the notice, and does not throw, when the log cannot be written or the call is missing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    window.api = {
      getCurrentShift: vi.fn().mockResolvedValue({ success: false, error: 'x' }),
      logTillEvent: vi.fn().mockRejectedValue(new Error('refused'))
    } as unknown as typeof window.api
    await expect(useShiftStore.getState().load()).resolves.toBeUndefined()

    window.api = { getCurrentShift: vi.fn().mockResolvedValue({ success: false, error: 'x' }) } as unknown as typeof window.api
    await expect(useShiftStore.getState().load()).resolves.toBeUndefined()
    expect(useShiftStore.getState().presence).toBe('unknown')
  })
})
