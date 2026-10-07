/**
 * Who may call which IPC channel, checked in the main process (docs/phase-254).
 *
 * The main process now knows who is signed in: the login screen's `auth:login` starts a session and `auth:logout`
 * ends it. The manager PIN prompt checks a PIN through the same channel without starting one, so a manager authorising
 * an action at a cashier's till never turns the till into the manager's.
 *
 * Every handler in `index.ts` is registered through {@link gateIpcMain}:
 * - an admin may call every channel;
 * - a cashier may call only {@link CASHIER_CHANNELS}. Any other channel, including one added later, is refused with
 *   {@link MANAGER_NEEDED_MESSAGE} before its handler runs, so nothing is read or written;
 * - with nobody signed in, the cashier's channels and onboarding's ({@link SIGNED_OUT_CHANNELS}), which runs before
 *   any staff member can sign in.
 *
 * A channel a manager authorises with a PIN at the cashier's till (a held sale's discard, a cart removal, an ETR copy)
 * is a cashier's channel: the PIN, re-verified by `requireAdminPin`, is the authority there, as before.
 */

import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import type { ShiftRow, StaffSummary } from '../services/database.js'

/** The refusal a cashier sees for anything that needs a manager. */
export const MANAGER_NEEDED_MESSAGE = 'This needs a manager.'

/**
 * Every channel a signed-in cashier may call: what the selling screen, the Orders tab, the shift dialogs, the update
 * prompt and "My shifts and sales" use. Reads that show other cashiers' sales are left out (C6); the Orders tab and
 * the Z report are read for a cashier with their own filter, in their handlers.
 */
export const CASHIER_CHANNELS: ReadonlySet<string> = new Set([
  'ping',
  'checkFit:getForcedScreen',
  'app:get-version',
  'auth:login',
  'auth:logout',
  'staff:list',
  'config:get-status',
  'setup:check-etims-completion',
  'catalog:sync',
  'products:fetch',
  'products:cached',
  'network:get-status',
  'connectivity:get-status',
  'connectivity:test-all',
  'shopify:get-reconciliation-status',
  'fiscal:is-live',
  'fiscal:unfiled-count',
  'fiscal:correct-pin-and-resend',
  'fiscal:print-duplicate',
  'log:till-event',
  'cart:save-draft',
  'cart:load-draft',
  'cart:clear-draft',
  'cart:record-removals',
  'held:list',
  'held:hold',
  'held:rename',
  'held:resume',
  'held:discard',
  'orders:checkout',
  'orders:getLocal',
  'orders:retrySync',
  'orders:mine',
  'receipt:print',
  'integrations:mpesa-stk-push',
  'integrations:mpesa-capabilities',
  'mpesa:log-transaction',
  'mpesa:query-status',
  'shifts:current',
  'shifts:window-status',
  'shifts:open',
  'shifts:close',
  'shifts:mine',
  'reports:z-report',
  'updater:startup-check',
  'updater:download',
  'updater:install'
])

/** Onboarding (`OnboardingScreen`) saves the Shopify connection before any staff member can sign in. */
export const SIGNED_OUT_CHANNELS: ReadonlySet<string> = new Set(['config:validate', 'config:save'])

/** The staff member signed in at this till, as the main process knows it. */
export interface StaffSession {
  current(): StaffSummary | null
  signIn(staff: StaffSummary): void
  signOut(): void
}

/**
 * @returns {StaffSession} nobody signed in until the login screen starts a session
 */
export function createStaffSession(): StaffSession {
  let signedIn: StaffSummary | null = null
  return {
    current: () => signedIn,
    signIn: (staff) => {
      signedIn = { id: staff.id, name: staff.name, role: staff.role }
    },
    signOut: () => {
      signedIn = null
    }
  }
}

/**
 * @param {string} channel
 * @param {StaffSummary | null} staff — who is signed in
 * @returns {boolean}
 */
export function mayCall(channel: string, staff: StaffSummary | null): boolean {
  if (staff?.role === 'admin') return true
  if (CASHIER_CHANNELS.has(channel)) return true
  return staff === null && SIGNED_OUT_CHANNELS.has(channel)
}

/** The Z report of an open shift is locked: it is printed, and a cashier sees it, once the shift is closed. */
export const Z_REPORT_LOCKED_MESSAGE = 'This shift is still open. Close the shift first: its Z report is locked until then.'

/**
 * Whether the person signed in may see a shift's Z report (C3, A1): an admin any shift; anyone else the shifts they
 * opened or closed. Nobody signed in, none.
 *
 * @param {Pick<ShiftRow, 'staff_id' | 'closed_by_staff_id'>} shift
 * @param {StaffSummary | null} staff
 * @returns {boolean}
 */
export function mayReadShift(shift: Pick<ShiftRow, 'staff_id' | 'closed_by_staff_id'>, staff: StaffSummary | null): boolean {
  if (!staff) return false
  if (staff.role === 'admin') return true
  return shift.staff_id === staff.id || shift.closed_by_staff_id === staff.id
}

/**
 * Why a Z report may not be shown or printed, or `null` when it may. While the shift is open its Z is locked: nobody
 * prints it, and only an admin sees its running figures on screen (the Reports tab). Once closed, {@link mayReadShift}.
 *
 * @param {Pick<ShiftRow, 'status' | 'staff_id' | 'closed_by_staff_id'>} shift
 * @param {StaffSummary | null} staff
 * @param {'view' | 'print'} action
 * @returns {string | null}
 */
export function zReportRefusal(
  shift: Pick<ShiftRow, 'status' | 'staff_id' | 'closed_by_staff_id'>,
  staff: StaffSummary | null,
  action: 'view' | 'print'
): string | null {
  if (shift.status === 'open' && (action === 'print' || staff?.role !== 'admin')) return Z_REPORT_LOCKED_MESSAGE
  return mayReadShift(shift, staff) ? null : MANAGER_NEEDED_MESSAGE
}

/** The part of `ipcMain` that `index.ts` registers with. `any[]` as Electron's own: each handler types its own arguments. */
export interface GatedIpcMain {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(channel: string, listener: (event: IpcMainEvent, ...args: any[]) => void): void
}

/**
 * Wraps `ipcMain` so every handler registered through it is refused to anyone {@link mayCall} turns away. `on` passes
 * straight through: its one use, `cart:flush-done`, only acknowledges a flush the main process asked for.
 *
 * @param {Pick<IpcMain, 'handle' | 'on'>} ipcMain — Electron's
 * @param {StaffSession} session
 * @returns {GatedIpcMain}
 */
export function gateIpcMain(ipcMain: Pick<IpcMain, 'handle' | 'on'>, session: StaffSession): GatedIpcMain {
  return {
    handle(channel, listener) {
      ipcMain.handle(channel, (event, ...args) =>
        mayCall(channel, session.current()) ? listener(event, ...args) : { success: false, error: MANAGER_NEEDED_MESSAGE }
      )
    },
    on(channel, listener) {
      ipcMain.on(channel, listener)
    }
  }
}
