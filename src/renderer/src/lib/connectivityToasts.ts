/**
 * Turns a stream of per-integration connectivity results into
 * user-facing toast events, decoupled from the raw 30-second poll so
 * a flaky connection doesn't spam a toast on every check. A
 * disconnected toast only fires after `failureThreshold` consecutive
 * failed checks; a recovery toast fires as soon as a check succeeds
 * again, but only if a disconnected toast was actually shown first —
 * so a transient blip that never crosses the failure threshold stays
 * silent on the way back up too.
 */

/** One integration's toast-debounce state, tracked across polls. */
export interface ToastDebounceState {
  consecutiveFailures: number
  /** The last toast actually shown for this integration, or `null` before any has fired. */
  lastToasted: 'connected' | 'disconnected' | null
}

/** Starting state for a fresh integration, before any check has been observed. */
export function initialToastDebounceState(): ToastDebounceState {
  return { consecutiveFailures: 0, lastToasted: null }
}

/** Result of feeding one new check outcome into {@link nextToastDebounceState}. */
export interface ToastDebounceResult {
  state: ToastDebounceState
  /** The toast to show, or `null` if this check shouldn't trigger one. */
  toast: 'connected' | 'disconnected' | null
}

/**
 * Advances `prev` with one new check outcome, deciding whether it
 * warrants a toast. Idempotent: feeding the same `connected` value
 * repeatedly after a toast has already fired for that state never
 * fires a duplicate.
 *
 * @param {ToastDebounceState} prev
 * @param {boolean} connected
 * @param {number} [failureThreshold=3]
 * @returns {ToastDebounceResult}
 */
export function nextToastDebounceState(
  prev: ToastDebounceState,
  connected: boolean,
  failureThreshold = 3
): ToastDebounceResult {
  if (connected) {
    const shouldToast = prev.lastToasted === 'disconnected'
    return {
      state: { consecutiveFailures: 0, lastToasted: 'connected' },
      toast: shouldToast ? 'connected' : null
    }
  }

  const consecutiveFailures = prev.consecutiveFailures + 1
  const shouldToast = consecutiveFailures >= failureThreshold && prev.lastToasted !== 'disconnected'
  return {
    state: {
      consecutiveFailures,
      lastToasted: shouldToast ? 'disconnected' : prev.lastToasted
    },
    toast: shouldToast ? 'disconnected' : null
  }
}
