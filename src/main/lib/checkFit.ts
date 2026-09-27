/**
 * `check:fit`'s renderer force-show hook (docs/phase-166 Commit E3,
 * extended docs/phase-167 Part B item 1) — a pure resolver, split out
 * of `main/index.ts`'s `checkFit:getForcedScreen` handler so it can be
 * unit tested directly (`main/index.ts` itself imports Electron at
 * module load time and is not importable in a test run, the same
 * constraint every other IPC handler in this codebase has).
 */

/**
 * Resolves `RUBIS_CHECK_FIT_SCREEN` to the screen id `check:fit` wants
 * force-shown, or `null` when unset — always `null` on every real
 * launch, since no real launch ever sets this variable (mirrors
 * `RUBIS_CHECK_FIT_SIZE`'s own `parseCheckFitSize`).
 *
 * @param {string | undefined} raw
 * @returns {string | null}
 */
export function resolveCheckFitForcedScreen(raw: string | undefined): string | null {
  return raw ?? null
}

/**
 * Resolves `RUBIS_CHECK_FIT` (docs/phase-169-1 commit A) — whether this
 * launch must never send anything real: no Shopify push, no fiscal
 * device command, no M-Pesa STK push/poll, no non-mock printer job.
 * `main/index.ts` reads this once at startup to decide whether to start
 * the sync engine, the fiscal engine, and the M-Pesa SMS poller, and
 * each of the four sending IPC handlers reads it again before doing
 * anything.
 *
 * Set only by `scripts/check-fit.mjs`, alongside the existing
 * `RUBIS_CHECK_FIT_SIZE`/`RUBIS_CHECK_FIT_SCREEN` hooks — always unset
 * (so always `false` here) on every real launch. Any non-empty value
 * counts as "on"; `check-fit.mjs` always sets `'1'`, and this flag's
 * only job is a plain fail-safe, not a settings format to parse.
 *
 * @param {string | undefined} raw
 * @returns {boolean}
 */
export function resolveCheckFitSendingDisabled(raw: string | undefined): boolean {
  return raw !== undefined && raw !== ''
}

/** The plain, cashier/operator-facing refusal every guarded handler returns. */
export const CHECK_FIT_SENDING_DISABLED_MESSAGE = 'check:fit mode: sending is disabled'

/**
 * The single decision every sending IPC handler makes: refuse, or let
 * the request through. Centralised so the same wording and the same
 * condition are used everywhere, rather than four/five near-identical
 * `if` blocks that could drift apart.
 *
 * `receipt:print` is the one handler with an exception: printing
 * through the MOCK printer touches no real hardware at all (it only
 * logs and, for the PDF fallback, writes a local file), so it is let
 * through even when sending is otherwise disabled — pass
 * `skipWhenMock: true` there.
 *
 * @param {boolean} sendingDisabled - this launch's `RUBIS_CHECK_FIT` state
 * @param {{ skipWhenMock?: boolean }} [options]
 * @returns the refusal to return from the handler, or `null` to proceed
 */
export function guardCheckFitSending(
  sendingDisabled: boolean,
  options?: { skipWhenMock?: boolean }
): { success: false; error: string } | null {
  if (!sendingDisabled) return null
  if (options?.skipWhenMock) return null
  return { success: false, error: CHECK_FIT_SENDING_DISABLED_MESSAGE }
}

/**
 * Whether the sync engine, the fiscal engine, and the M-Pesa SMS poller
 * should be started at all this launch. A plain negation, but named and
 * exported so it is one tested unit rather than an inline `if` repeated
 * at three call sites in `main/index.ts` — which cannot itself be unit
 * tested (it imports Electron at module load time).
 *
 * @param {boolean} sendingDisabled
 * @returns {boolean}
 */
export function shouldStartBackgroundSenders(sendingDisabled: boolean): boolean {
  return !sendingDisabled
}
