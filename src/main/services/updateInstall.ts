/**
 * Lets the till's background work finish before an update installs (docs/phase-219).
 *
 * The fiscal engine retries queued sales and the Shopify engine pushes on their own timers.
 * Quitting halfway through a retry can leave a receipt open on the control unit, or a sale
 * filed on the device with its reply never recorded. So the one install path (the prompt, the
 * App & Updates panel and the toast all use it) stops both engines from starting a tick, waits
 * for any tick already running, and only then installs.
 */

/** What the install needs from each background engine (`fiscal-engine.ts`, `sync-engine.ts`). */
export interface PausableEngine {
  pause(): void
  resume(): void
  whenIdle(): Promise<void>
}

/** The outcome of an install attempt; the same shape `installUpdate` returns. */
export interface InstallOutcome {
  success: boolean
  error?: string
}

/** How long a running tick is waited for before the install is cancelled. */
export const BACKGROUND_WAIT_MS = 60_000

/** Shown when a tick is still running after {@link BACKGROUND_WAIT_MS}. */
export const STILL_SENDING_MESSAGE = 'A sale is still being sent to the tax device. Try again in a minute.'

/**
 * Pauses the engines, waits up to `waitMs` for running ticks, then runs `install`.
 * If a tick is still running at the limit, nothing is installed, the engines are
 * resumed and the till keeps running. If `install` fails, the engines are resumed too.
 * After a successful `install` they stay paused: the app is quitting.
 *
 * @param {object} params
 * @param {PausableEngine[]} params.engines - the engines to hold still
 * @param {() => Promise<InstallOutcome>} params.install - backs up, then `quitAndInstall`
 * @param {number} [params.waitMs] - the wait limit, default {@link BACKGROUND_WAIT_MS}
 * @returns {Promise<InstallOutcome>}
 */
export async function installWhenQuiet(params: {
  engines: PausableEngine[]
  install: () => Promise<InstallOutcome>
  waitMs?: number
}): Promise<InstallOutcome> {
  const { engines, install } = params
  const waitMs = params.waitMs ?? BACKGROUND_WAIT_MS

  engines.forEach((engine) => engine.pause())

  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), waitMs)
  })
  const idle = Promise.all(engines.map((engine) => engine.whenIdle())).then(() => 'idle' as const)
  const settled = await Promise.race([idle, limit])
  clearTimeout(timer)

  if (settled === 'timeout') {
    engines.forEach((engine) => engine.resume())
    return { success: false, error: STILL_SENDING_MESSAGE }
  }

  const outcome = await install()
  if (!outcome.success) engines.forEach((engine) => engine.resume())
  return outcome
}
