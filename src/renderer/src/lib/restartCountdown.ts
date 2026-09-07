/**
 * Countdown timer driving `RestartCountdownModal` — ticks once per
 * second down from `durationMs`, calling `onTick` with the time
 * remaining and `onComplete` exactly once at zero. Framework-free
 * (mirrors `mpesaPaymentPoller.ts`) so it's unit-testable with plain
 * fake timers, no component-test harness.
 */

/** Total countdown duration before an automatic restart, in milliseconds. */
export const RESTART_COUNTDOWN_MS = 10_000

/** Callbacks driving the UI in response to the countdown's progress. */
export interface RestartCountdownCallbacks {
  /** Called once per tick with the time remaining. */
  onTick: (msRemaining: number) => void
  /** Called exactly once, when the countdown reaches zero. */
  onComplete: () => void
}

/** Options accepted by {@link createRestartCountdown}. */
export interface RestartCountdownOptions {
  callbacks: RestartCountdownCallbacks
  /** Defaults to {@link RESTART_COUNTDOWN_MS}. */
  durationMs?: number
  /** Defaults to 1000ms (one tick per second). */
  intervalMs?: number
}

/** Handle returned by {@link createRestartCountdown}. */
export interface RestartCountdown {
  /** Starts the countdown, immediately reporting the full duration via `onTick`. A no-op if already started or already settled. */
  start(): void
  /** Stops the countdown. Idempotent — safe to call any number of times. */
  stop(): void
}

/**
 * Creates a countdown for one restart prompt. Never calls
 * `onComplete` more than once, and never after `stop()`.
 *
 * @param {RestartCountdownOptions} options
 * @returns {RestartCountdown}
 */
export function createRestartCountdown(options: RestartCountdownOptions): RestartCountdown {
  const { callbacks } = options
  const durationMs = options.durationMs ?? RESTART_COUNTDOWN_MS
  const intervalMs = options.intervalMs ?? 1000

  let timer: ReturnType<typeof setInterval> | null = null
  let elapsedMs = 0
  let settled = false

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    settled = true
  }

  function tick(): void {
    if (settled) return
    elapsedMs += intervalMs
    const remaining = Math.max(0, durationMs - elapsedMs)
    if (remaining <= 0) {
      stop()
      callbacks.onComplete()
      return
    }
    callbacks.onTick(remaining)
  }

  function start(): void {
    if (timer !== null || settled) return
    callbacks.onTick(durationMs)
    timer = setInterval(tick, intervalMs)
  }

  return { start, stop }
}
