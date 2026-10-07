/**
 * Phase 254: the role gate in the main process. Every C6 action, called as a cashier, is refused with "This needs a
 * manager." before its handler runs, and writes nothing (every table counted before and after, on a real in-memory
 * SQLite). An admin passes every one (C7). A channel nobody listed is refused to a cashier (deny by default).
 *
 * The handlers in `index.ts` are closures of the running app and cannot be called from a test; so the gate is run with
 * stand-in handlers that write, and the source is checked to register every handler through the gate.
 */

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { IpcMain } from 'electron'
import type { Database as SqliteConnection } from 'better-sqlite3'
import { RubisDatabase, type StaffSummary } from '../src/main/services/database.js'
import {
  CASHIER_CHANNELS,
  MANAGER_NEEDED_MESSAGE,
  SIGNED_OUT_CHANNELS,
  createStaffSession,
  gateIpcMain,
  mayCall
} from '../src/main/lib/roleGate.js'

const ADMIN: StaffSummary = { id: 1, name: 'Admin', role: 'admin' }
const CASHIER: StaffSummary = { id: 2, name: 'Cashier', role: 'cashier' }

/** C6, item by item, as the channels that carry it. */
const C6: Record<string, string[]> = {
  "correct a shift's figures (224), and its override (244)": ['shifts:correct'],
  'move a sale (244), and its override': ['shifts:move-sale', 'shifts:move-sale-preview'],
  'merge shifts (239)': ['shifts:merge', 'shifts:merge-preview'],
  'approve manual M-Pesa (246)': ['reports:approve-shift', 'reports:approve-day', 'mpesa:reconcile'],
  export: ['reports:export-csv'],
  settings: [
    'config:set',
    'config:save',
    'config:clear',
    'setup:save-etims-config',
    'store:set-identity',
    'secrets:set-etims-password',
    'secrets:set-mpesa-credentials',
    'secrets:set-shopify-token',
    'shopify:set-store-url',
    'stocktake:save-settings',
    'app:restart'
  ],
  staff: ['staff:create', 'staff:resetPin'],
  printers: ['printers:save', 'printers:delete', 'printers:test', 'printers:find-windows'],
  integrations: ['integrations:set-config', 'integrations:get-config', 'config:test-etims', 'config:test-mpesa'],
  location: ['location:set', 'location:list'],
  void: ['orders:void'],
  "other cashiers' sales": [
    'reports:invoice-list',
    'reports:sales-summary',
    'reports:daily-summary',
    'reports:end-of-day',
    'reports:shift-end-of-day',
    'reports:end-of-day-shifts',
    'reports:fiscal-by-day',
    'reports:fiscal-reconciliation',
    'reports:window-report',
    'reports:shifts-list',
    'fiscal:needs-attention',
    'fiscal:vat-mismatches',
    'fiscal:unprinted-slips',
    'fiscal:resend',
    'mpesa:get-logs',
    'mpesa:list-payments',
    'mpesa:list-unreconciled',
    'held:discarded-for-day'
  ]
}
const C6_CHANNELS = Object.values(C6).flat()

const SOURCE = readFileSync(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8').replace(/\r\n/g, '\n')
const REGISTERED = [...SOURCE.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map((match) => match[1])

function freshDb(): RubisDatabase {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  return db
}
const conn = (db: RubisDatabase): SqliteConnection => (db as unknown as { conn: SqliteConnection }).conn

/** Every table's row count. */
function countEveryTable(db: RubisDatabase): Record<string, number> {
  const tables = conn(db)
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>
  return Object.fromEntries(
    tables.map(({ name }) => [name, (conn(db).prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n])
  )
}

/**
 * The gate over a fake `ipcMain`, with a stand-in handler for each channel that writes a settings row and a shift
 * correction's worth of data, as the real handlers write, so a handler that ran would show in the counts.
 */
function gated(db: RubisDatabase, channels: string[]) {
  const session = createStaffSession()
  const registered = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const fake = { handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => registered.set(channel, listener), on: vi.fn() }
  const ipc = gateIpcMain(fake as unknown as Pick<IpcMain, 'handle' | 'on'>, session)
  const ran: string[] = []
  for (const channel of channels) {
    ipc.handle(channel, () => {
      ran.push(channel)
      db.setSetting(`touched:${channel}`, '1')
      conn(db).prepare("INSERT INTO shifts (staff_id, clock_in, status) VALUES (9, '2026-10-07T00:00:00.000Z', 'closed')").run()
      return { success: true }
    })
  }
  const call = (channel: string): unknown => registered.get(channel)!({}, { managerId: 1, managerPin: '1234' })
  return { session, call, ran }
}

describe('the C6 actions, called as a cashier', () => {
  it.each(Object.entries(C6))('%s: refused with "This needs a manager.", and nothing is written', (_item, channels) => {
    const db = freshDb()
    const { session, call, ran } = gated(db, channels)
    session.signIn(CASHIER)
    const before = countEveryTable(db)

    for (const channel of channels) {
      expect(call(channel)).toEqual({ success: false, error: MANAGER_NEEDED_MESSAGE })
    }

    expect(ran).toEqual([])
    expect(countEveryTable(db)).toEqual(before)
  })

  it('are each registered in index.ts, and none is on the cashier list', () => {
    for (const channel of C6_CHANNELS) {
      expect(REGISTERED, channel).toContain(channel)
      expect(CASHIER_CHANNELS.has(channel), channel).toBe(false)
    }
  })
})

describe('an admin (C7)', () => {
  it('passes every channel the till registers, C6 included', () => {
    const db = freshDb()
    const { session, call, ran } = gated(db, REGISTERED)
    session.signIn(ADMIN)

    for (const channel of REGISTERED) {
      expect(call(channel), channel).toEqual({ success: true })
    }
    expect(ran).toEqual(REGISTERED)
  })
})

describe('deny by default', () => {
  it('refuses a cashier a channel that is on no list, as a new handler would be', () => {
    expect(mayCall('anything:added-later', CASHIER)).toBe(false)
    expect(mayCall('anything:added-later', ADMIN)).toBe(true)
  })

  it('lists only channels the till registers, so a typo cannot leave a cashier without a screen', () => {
    for (const channel of [...CASHIER_CHANNELS, ...SIGNED_OUT_CHANNELS]) {
      expect(REGISTERED, channel).toContain(channel)
    }
  })

  it('lets a cashier reach what a manager authorises with a PIN at the till, where the PIN stays the authority', () => {
    for (const channel of ['held:discard', 'cart:record-removals', 'fiscal:print-duplicate']) {
      expect(mayCall(channel, CASHIER), channel).toBe(true)
    }
  })

  it('with nobody signed in: the cashier list and onboarding only', () => {
    expect(mayCall('config:save', null)).toBe(true)
    expect(mayCall('config:validate', null)).toBe(true)
    expect(mayCall('staff:list', null)).toBe(true)
    expect(mayCall('staff:create', null)).toBe(false)
    expect(mayCall('shifts:correct', null)).toBe(false)
    expect(mayCall('config:save', CASHIER)).toBe(false)
  })
})

describe('index.ts registers every handler through the gate', () => {
  it("imports Electron's ipcMain under another name and hands it only to the gate", () => {
    expect(SOURCE).toContain("ipcMain as electronIpcMain")
    const codeLines = SOURCE.split('\n').filter((line) => line.includes('electronIpcMain') && !/^\s*(\*|\/\/|\/\*)/.test(line))
    expect(codeLines).toHaveLength(2)
    expect(SOURCE).not.toMatch(/electronIpcMain\./)
    expect(SOURCE).toContain('const ipcMain = gateIpcMain(electronIpcMain, staffSession)')
    const electronImports = SOURCE.split('\n').filter((line) => line.includes("from 'electron'"))
    for (const line of electronImports) expect(line).not.toMatch(/[{,]\s*ipcMain\s*[,}]/)
  })

  it('registers a channel once, so no second, ungated handler can stand behind one', () => {
    expect(new Set(REGISTERED).size).toBe(REGISTERED.length)
  })
})

describe('the session', () => {
  const body = (channel: string): string => {
    const start = SOURCE.indexOf(`'${channel}'`)
    return SOURCE.slice(start, SOURCE.indexOf('ipcMain.handle(', start + 10))
  }

  it('is decided by loginWithSession on login, and ended on logout', () => {
    expect(body('auth:login')).toContain('return loginWithSession(db, staffSession, validation.data)')
    expect(body('auth:logout')).toContain('staffSession.signOut()')
  })

  it('holds a copy of who signed in, and nobody after sign out', () => {
    const session = createStaffSession()
    const staff = { ...CASHIER }
    session.signIn(staff)
    staff.role = 'admin'
    expect(session.current()).toEqual(CASHIER)
    session.signOut()
    expect(session.current()).toBeNull()
  })

  it('is never started by the manager PIN prompt, which checks a PIN with two arguments', () => {
    const modal = readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'components', 'ManagerPinModal.tsx'), 'utf8')
    expect(modal).toContain('window.api.login(selectedAdminId, trimmedPin)')
  })
})
