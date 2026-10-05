/**
 * The renderer's `getZReport` must send the object `reports:z-report`
 * validates (`{ shiftId }`), not a bare number (docs/phase-226).
 */

import { describe, it, expect, vi } from 'vitest'
import { validate, zReportRequestSchema } from '../src/main/lib/ipcValidator.js'

const invoke = vi.fn().mockResolvedValue({ success: true })
const exposed: Record<string, unknown> = {}

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (key: string, value: unknown) => { exposed[key] = value } },
  ipcRenderer: { invoke: (...args: unknown[]) => invoke(...args), on: vi.fn(), removeListener: vi.fn() }
}))
vi.mock('@electron-toolkit/preload', () => ({ electronAPI: {} }))

describe('getZReport request shape (docs/phase-226)', () => {
  it('sends { shiftId }, which the main-process schema accepts', async () => {
    Object.defineProperty(process, 'contextIsolated', { value: true, configurable: true })
    await import('../src/preload/index.js')
    const api = exposed.api as { getZReport: (shiftId: number) => Promise<unknown> }

    await api.getZReport(5)

    expect(invoke).toHaveBeenCalledWith('reports:z-report', { shiftId: 5 })
    const payload = invoke.mock.calls.find((call) => call[0] === 'reports:z-report')![1]
    expect(validate(zReportRequestSchema, payload).success).toBe(true)
    expect(validate(zReportRequestSchema, 5).success).toBe(false)
  })
})
