/**
 * Types and plain-language phrasing for the Admin screen's "Test
 * connection" button.
 *
 * Reaching the fiscal device is three separate hops, and they fail for
 * unrelated reasons a branch manager can act on differently. Reporting
 * one blended "connection failed" would tell them nothing, so the test
 * names the hop that broke and what to do about it — no codes, no
 * command names, no `Res Code` numbers.
 *
 * The mapping is pure so it can be unit tested without a device or a
 * server; `RealFiscalizationProvider.testConnection` supplies the
 * outcomes.
 */

/** The three hops between this till and a filed invoice. */
export type FiscalConnectionHop = 'server' | 'device' | 'ready'

/** One hop's outcome, for the checklist the Admin screen renders. */
export interface FiscalConnectionHopResult {
  hop: FiscalConnectionHop
  /** What this hop is, in the operator's words. */
  label: string
  /** `undefined` when an earlier hop failed and this one was never attempted. */
  passed?: boolean
}

/** Result of {@link RealFiscalizationProvider.testConnection}. */
export interface FiscalConnectionTestResult {
  ok: boolean
  /** Absent when every hop passed. */
  failedAt?: FiscalConnectionHop
  /** One sentence naming what happened and what to check. */
  message: string
  hops: FiscalConnectionHopResult[]
}

/** Human label for each hop, shown as a checklist row. */
const HOP_LABELS: Record<FiscalConnectionHop, string> = {
  server: 'Fiscal server on this till',
  device: 'Fiscal device answering',
  ready: 'Device ready to file'
}

/**
 * Builds the three-row checklist, marking hops after `failedAt` as not
 * attempted (`passed: undefined`) rather than failed — they were never
 * tried, and showing them as failures would send someone chasing the
 * wrong problem.
 *
 * @param {FiscalConnectionHop} [failedAt]
 * @returns {FiscalConnectionHopResult[]}
 */
function buildHops(failedAt?: FiscalConnectionHop): FiscalConnectionHopResult[] {
  const order: FiscalConnectionHop[] = ['server', 'device', 'ready']
  const failedIndex = failedAt ? order.indexOf(failedAt) : -1

  return order.map((hop, index) => {
    const label = HOP_LABELS[hop]
    if (failedIndex === -1) return { hop, label, passed: true }
    if (index < failedIndex) return { hop, label, passed: true }
    if (index === failedIndex) return { hop, label, passed: false }
    return { hop, label }
  })
}

/**
 * Every hop passed.
 *
 * @returns {FiscalConnectionTestResult}
 */
export function connectionTestPassed(): FiscalConnectionTestResult {
  return {
    ok: true,
    message: 'The fiscal device answered and is ready to file sales.',
    hops: buildHops()
  }
}

/**
 * A hop failed.
 *
 * @param {FiscalConnectionHop} failedAt
 * @param {string} message — already in plain language.
 * @returns {FiscalConnectionTestResult}
 */
export function connectionTestFailed(
  failedAt: FiscalConnectionHop,
  message: string
): FiscalConnectionTestResult {
  return { ok: false, failedAt, message, hops: buildHops(failedAt) }
}

/** Message used when the till has no device details saved yet. */
export const NOT_CONFIGURED_MESSAGE =
  'The fiscal device has not been set up on this till yet. Fill in the address, IP, port and password above, then save.'

/**
 * Reason recorded against a sale that could not be filed because the
 * device was never set up. Shown on the needs-attention list, so it says
 * what happened and what fixes it — the sale itself is fine and will
 * file once someone completes the setup and resends.
 */
export const NOT_CONFIGURED_REASON =
  'The fiscal device has not been set up on this till yet. Enter its details in Admin, then resend this sale.'

/**
 * Turns a `settings()` server code into something a branch manager can
 * act on. Codes are from the vendor SDK's `Tremol.ServerErrorType`
 * (`Libs/JS/fp_core.js:529-565`, quoted in `tracker/SDK_RECON.md` §6.3)
 * — the number itself is never shown.
 *
 * @param {string | undefined} code
 * @returns {string}
 */
export function describeSettingsFailure(code: string | undefined): string {
  switch (code) {
    case '30':
      return 'The fiscal server is running, but the fiscal device did not answer. Check the device is switched on and on the same network, and that the IP address and port above are right.'
    case '31':
      return 'The fiscal device refused the password. Check the fiscal device password above and save it again.'
    case '32':
      return 'The fiscal server rejected the device address. Check the IP address and port above.'
    case '34':
      return 'The fiscal device is busy with another till. Try again in a moment.'
    default:
      return 'The fiscal server could not open a session with the device. Check the device details above.'
  }
}

/**
 * Message for a device that answered but is not in a state where it can
 * file a sale. `readStatus` already phrases these as sentences, so this
 * only supplies the fallback.
 *
 * @param {string | undefined} error
 * @returns {string}
 */
export function describeNotReady(error: string | undefined): string {
  if (error?.includes('not fiscalized')) {
    return 'The fiscal device answered but reports it has not been fiscalized. It cannot file sales yet — contact the device supplier.'
  }
  if (error?.includes('not paired')) {
    return 'The fiscal device answered but is not paired with KRA TIMS. It cannot file sales yet — contact the device supplier.'
  }
  return 'The fiscal device answered but is not ready to file sales. Contact the device supplier.'
}

/**
 * Message for a fiscal server this till could not reach at all.
 *
 * Deliberately says "the fiscal server software" rather than naming
 * ZFPLabServer: a branch manager reads this, and the vendor's service
 * name means nothing to them. The name an installer needs is in
 * `docs/GO_LIVE.md`.
 */
export const SERVER_UNREACHABLE_MESSAGE =
  'Could not reach the fiscal server on this till. Check that the fiscal server software is running, and that the fiscal server address above is right.'
