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

/**
 * A failure raised by the fiscal **server** itself (`<Err Source="Server">`)
 * rather than by the device: the raw `<Res Code>` and the server's own
 * `<Message>`.
 *
 * The message is carried alongside the code because the code alone is not
 * enough to explain Code 31 — the server issues it at two different stages
 * and only the message text tells them apart. See
 * {@link describeDeviceNotAnswering}.
 */
export interface FiscalServerFailure {
  code: string
  message: string
}

/**
 * Why a device that answered `ReadStatus` still cannot file. Set from the
 * status bits themselves, never inferred from message text — matching
 * words is how the wrong hop got reported in the first place.
 */
export type FiscalNotReadyReason = 'not-fiscalized' | 'not-paired'

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
 * The one fragment of the server's `<Message>` that identifies the
 * **password** stage of a Code 31. Kept as short as it can be while still
 * being unambiguous, so a vendor reword is less likely to break it.
 *
 * Observed live: `"Missing password authentication answer"` (the real
 * wrong-password signature, captured in
 * `tests/fixtures/wire/readstatus-code31-authfail.xml`), versus
 * `"Missing first ping answer"` (the session died *before* the password
 * was ever presented — see `docs/phase-97.md` §5).
 */
const CODE_31_PASSWORD_FRAGMENT = 'password'

/**
 * Turns a server-level failure into something a branch manager can act
 * on. Codes are from the vendor SDK's `Tremol.ServerErrorType`
 * (`Libs/JS/fp_core.js:529-565`, quoted in `tracker/SDK_RECON.md` §6.3)
 * — the number itself is never shown.
 *
 * Every code here means the same thing to the person at the till: **the
 * device did not answer**. That is hop 2's job, which is why the
 * `settings()` hop and the `ReadStatus` hop share this one function
 * rather than each having their own — an earlier split reported the same
 * cause two different ways depending on which command hit it.
 *
 * Code 31 is the exception that needs the message text as well: the
 * server issues it both when the password was rejected and when the
 * device never answered the initial ping, long before any password is
 * presented. Only the message separates them, so anything that is not
 * positively the password variant is reported as a connection problem —
 * a false "wrong password" sends someone to change a setting that was
 * never wrong, which is exactly the wasted chase this exists to prevent.
 *
 * @param {FiscalServerFailure} failure
 * @returns {string}
 */
export function describeDeviceNotAnswering(failure: FiscalServerFailure): string {
  switch (failure.code) {
    case '19':
      return 'The fiscal device did not answer because it still has a session open from an earlier connection. Wait a minute and try again, and if it keeps happening switch the device off and on.'
    case '30':
      return 'The fiscal server is running, but the fiscal device did not answer. Check the device is switched on and on the same network, and that the IP address and port above are right.'
    case '31':
      return failure.message.toLowerCase().includes(CODE_31_PASSWORD_FRAGMENT)
        ? 'The fiscal device refused the password. Check the fiscal device password above and save it again.'
        : 'The fiscal device did not respond to the connection. Check the device is switched on and reachable at the IP address and port above.'
    case '32':
      return 'The fiscal server rejected the device address. Check the IP address and port above.'
    case '34':
      return 'The fiscal device is busy with another till. Try again in a moment.'
    case '53':
      return 'The session with the fiscal device was lost. Try the test again.'
    case '63':
      return 'The fiscal server rejected the request from this till. That is a fault in this app rather than in the device, so report it.'
    default:
      return 'The fiscal server could not open a session with the device. Check the device details above.'
  }
}

/**
 * Message for a device that answered `ReadStatus` and reported, in its
 * own status bits, that it cannot file. This is the **only** case the
 * "contact the device supplier" guidance is correct for: the device is
 * present and talking, and what it needs is provisioning nobody at the
 * branch can do.
 *
 * @param {FiscalNotReadyReason} reason
 * @returns {string}
 */
export function describeNotReady(reason: FiscalNotReadyReason): string {
  return reason === 'not-fiscalized'
    ? 'The fiscal device answered but reports it has not been fiscalized. It cannot file sales yet — contact the device supplier.'
    : 'The fiscal device answered but is not paired with KRA TIMS. It cannot file sales yet — contact the device supplier.'
}

/**
 * Message for a device that answered `ReadStatus` but rejected the
 * command, so its readiness could not be read either way. Distinct from
 * {@link describeNotReady} (which reports a status the device actually
 * gave) and from {@link describeDeviceNotAnswering} (where nothing
 * answered at all) — saying "not ready" here would assert a status that
 * was never read.
 */
export const STATUS_UNREADABLE_MESSAGE =
  'The fiscal device answered but could not report whether it is ready to file. Try again, and if it keeps happening contact the device supplier.'

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
