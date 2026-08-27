/**
 * Global error-handler service tests.
 *
 * `node:fs`, `process`, `electron.app`, and `electron.dialog` are never
 * touched — recording fakes are injected directly, matching this
 * codebase's established DI pattern.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  createFileErrorLogger,
  formatErrorEntry,
  installGlobalErrorHandlers
} from '../src/main/services/errorHandler.js'
import type { ErrorLogger } from '../src/main/services/errorHandler.js'

/**
 * Builds a fake process/app pair that records `.on()` registrations so
 * tests can invoke the captured listener directly, without a real
 * process crashing or a real Electron app instance.
 */
function createFakeEmitterPair() {
  const processListeners = new Map<string, (...args: unknown[]) => void>()
  const appListeners = new Map<string, (...args: unknown[]) => void>()

  const process = {
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      processListeners.set(event, listener)
    })
  }
  const app = {
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      appListeners.set(event, listener)
    })
  }

  return { process, app, processListeners, appListeners }
}

function createFakeLogger(): { logger: ErrorLogger; entries: string[] } {
  const entries: string[] = []
  return { logger: { append: vi.fn((entry: string) => entries.push(entry)) }, entries }
}

describe('formatErrorEntry', () => {
  it('includes a timestamp, source, and the error message', () => {
    const entry = formatErrorEntry('uncaughtException', new Error('boom'))
    expect(entry).toContain('[uncaughtException]')
    expect(entry).toContain('boom')
    expect(entry).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  it('stringifies a non-Error value', () => {
    const entry = formatErrorEntry('unhandledRejection', 'raw string reason')
    expect(entry).toContain('raw string reason')
  })
})

describe('createFileErrorLogger', () => {
  it('appends a newline-terminated entry via the injected fs implementation', () => {
    const appendFileSync = vi.fn()
    const logger = createFileErrorLogger('/fake/error.log', { appendFileSync })

    logger.append('[timestamp] [source] message')

    expect(appendFileSync).toHaveBeenCalledWith(
      '/fake/error.log',
      '[timestamp] [source] message\n'
    )
  })
})

describe('installGlobalErrorHandlers', () => {
  it('registers uncaughtException, unhandledRejection, and render-process-gone handlers', () => {
    const { process, app, processListeners, appListeners } = createFakeEmitterPair()
    const { logger } = createFakeLogger()
    installGlobalErrorHandlers({ process, app, logger, showFatalDialog: vi.fn() })

    expect(processListeners.has('uncaughtException')).toBe(true)
    expect(processListeners.has('unhandledRejection')).toBe(true)
    expect(appListeners.has('render-process-gone')).toBe(true)
  })

  it('logs and shows a fatal dialog on uncaughtException, without throwing', () => {
    const { process, app, processListeners } = createFakeEmitterPair()
    const { logger, entries } = createFakeLogger()
    const showFatalDialog = vi.fn()
    installGlobalErrorHandlers({ process, app, logger, showFatalDialog })

    expect(() => processListeners.get('uncaughtException')?.(new Error('kaboom'))).not.toThrow()

    expect(entries).toHaveLength(1)
    expect(entries[0]).toContain('kaboom')
    expect(showFatalDialog).toHaveBeenCalledWith(
      'An unexpected error occurred. Please restart RUBIS POS.'
    )
  })

  it('logs and shows a fatal dialog on unhandledRejection', () => {
    const { process, app, processListeners } = createFakeEmitterPair()
    const { logger, entries } = createFakeLogger()
    const showFatalDialog = vi.fn()
    installGlobalErrorHandlers({ process, app, logger, showFatalDialog })

    processListeners.get('unhandledRejection')?.(new Error('rejected'))

    expect(entries).toHaveLength(1)
    expect(entries[0]).toContain('rejected')
    expect(showFatalDialog).toHaveBeenCalledOnce()
  })

  it('logs and shows a fatal dialog when the renderer process is gone', () => {
    const { process, app, appListeners } = createFakeEmitterPair()
    const { logger, entries } = createFakeLogger()
    const showFatalDialog = vi.fn()
    installGlobalErrorHandlers({ process, app, logger, showFatalDialog })

    appListeners.get('render-process-gone')?.({}, { reason: 'crashed' })

    expect(entries).toHaveLength(1)
    expect(entries[0]).toContain('render-process-gone')
    expect(showFatalDialog).toHaveBeenCalledOnce()
  })
})
