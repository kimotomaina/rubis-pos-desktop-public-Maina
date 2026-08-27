/**
 * Main-process network connectivity monitor.
 *
 * Polls an injected `isOnline` probe (Electron's `net.isOnline()`) and
 * notifies listeners only when the connectivity state *changes*.
 *
 * Kept free of Electron imports so the module stays importable in
 * tests; `src/main/index.ts` wires the real probe.
 */

/** Dependencies for {@link createNetworkMonitor}. */
export interface NetworkMonitorOptions {
  /** Connectivity probe (main process passes `() => net.isOnline()`). */
  isOnline: () => boolean
  /** Called with the new state on every offline/online transition. */
  emit: (online: boolean) => void
  /** Poll interval in milliseconds (default 5 s). */
  intervalMs?: number
}

/** Handle returned by {@link createNetworkMonitor}. */
export interface NetworkMonitor {
  /** Takes a silent baseline reading and starts the poll timer. */
  start(): void
  /** Stops the poll timer. */
  stop(): void
  /** Runs a single probe outside the timer (e.g. on power-resume). */
  checkNow(): boolean
  /** Current connectivity state (last probe result). */
  isOnline(): boolean
}

/**
 * Creates the connectivity monitor.
 *
 * @param {NetworkMonitorOptions} options
 * @returns {NetworkMonitor}
 */
export function createNetworkMonitor(options: NetworkMonitorOptions): NetworkMonitor {
  const { isOnline: probe, emit } = options
  const intervalMs = options.intervalMs ?? 5_000

  let timer: ReturnType<typeof setInterval> | null = null
  let online = true
  let started = false

  /**
   * Runs one probe and emits only on a transition.
   *
   * @returns {boolean} the freshly probed state
   */
  function checkNow(): boolean {
    const current = probe()
    if (started && current !== online) {
      online = current
      emit(current)
    } else {
      online = current
    }
    return current
  }

  return {
    start(): void {
      if (timer) return
      started = true
      online = probe()
      timer = setInterval(() => checkNow(), intervalMs)
    },

    stop(): void {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },

    checkNow,

    isOnline(): boolean {
      return online
    }
  }
}
