/**
 * Phase 254: the login screen asks the main process to sign the staff member in; the manager PIN prompt sends the PIN
 * check it always sent, so authorising an action never changes who is signed in. "My shifts and sales" sends a page
 * and nothing else.
 */

import { describe, it, expect, vi } from 'vitest'
import { loginRequestSchema, shiftsListSchema, validate } from '../src/main/lib/ipcValidator.js'

const invoke = vi.fn().mockResolvedValue({ success: true })
const exposed: Record<string, unknown> = {}

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (key: string, value: unknown) => { exposed[key] = value } },
  ipcRenderer: { invoke: (...args: unknown[]) => invoke(...args), on: vi.fn(), removeListener: vi.fn() }
}))
vi.mock('@electron-toolkit/preload', () => ({ electronAPI: {} }))

interface Api {
  login: (staffId: number, pin: string, options?: { session?: boolean }) => Promise<unknown>
  getMyShifts: (page: number) => Promise<unknown>
  getMySales: (page: number) => Promise<unknown>
}

async function api(): Promise<Api> {
  Object.defineProperty(process, 'contextIsolated', { value: true, configurable: true })
  await import('../src/preload/index.js')
  return exposed.api as Api
}

describe('auth:login from the screen', () => {
  it('the manager PIN check sends exactly what it sent before the phase', async () => {
    invoke.mockClear()
    await (await api()).login(1, '1234')
    expect(invoke).toHaveBeenCalledWith('auth:login', { staffId: 1, pin: '1234' })
  })

  it('the login screen asks for a session, and the schema keeps the flag', async () => {
    invoke.mockClear()
    await (await api()).login(2, '2222', { session: true })
    expect(invoke).toHaveBeenCalledWith('auth:login', { staffId: 2, pin: '2222', session: true })
    const validation = validate(loginRequestSchema, invoke.mock.calls[0][1])
    expect(validation.success && validation.data.session).toBe(true)
  })
})

describe('"My shifts and sales" requests', () => {
  it('send the page only; a staff id added to one is dropped by the schema', async () => {
    invoke.mockClear()
    const bridge = await api()
    await bridge.getMyShifts(2)
    await bridge.getMySales(3)
    expect(invoke).toHaveBeenCalledWith('shifts:mine', { page: 2 })
    expect(invoke).toHaveBeenCalledWith('orders:mine', { page: 3 })
    expect(validate(shiftsListSchema, { page: 1, staffId: 9 })).toEqual({ success: true, data: { page: 1 } })
  })
})
