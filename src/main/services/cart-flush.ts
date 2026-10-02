/**
 * Asks the renderer to save its cart draft before the app quits
 * (docs/phase-197-1).
 *
 * The renderer debounces its draft writes by 300 ms, so a change made just
 * before a clean quit would otherwise be lost. The main process asks it to
 * write now and waits for its answer, but never longer than `timeoutMs`:
 * a hung or missing renderer must not stop the app from quitting. A kill
 * still loses the last 300 ms; nothing here can help with that.
 */

/** How the request ended. */
export type CartFlushResult = 'flushed' | 'timeout' | 'unavailable'

/** Dependencies of {@link createCartFlushCoordinator}; the timer ones are injectable for tests. */
export interface CartFlushCoordinatorDeps {
  /** Sends the flush request to the renderer. Throws when there is no renderer to ask. */
  send: () => void
  timeoutMs?: number
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

/** Handle returned by {@link createCartFlushCoordinator}. */
export interface CartFlushCoordinator {
  /** Asks for a flush and resolves when the renderer answers, the timeout passes, or there is no renderer. */
  request: () => Promise<CartFlushResult>
  /** Called when the renderer reports that its flush has completed. */
  acknowledge: () => void
}

/** How long a quit waits for the renderer's flush. */
export const CART_FLUSH_TIMEOUT_MS = 500

/**
 * @param {CartFlushCoordinatorDeps} deps
 * @returns {CartFlushCoordinator}
 */
export function createCartFlushCoordinator(deps: CartFlushCoordinatorDeps): CartFlushCoordinator {
  const timeoutMs = deps.timeoutMs ?? CART_FLUSH_TIMEOUT_MS
  const setTimer = deps.setTimer ?? setTimeout
  const clearTimer = deps.clearTimer ?? clearTimeout
  let settle: ((result: CartFlushResult) => void) | null = null
  let inFlight: Promise<CartFlushResult> | null = null

  return {
    request: () => {
      if (inFlight) return inFlight
      inFlight = new Promise<CartFlushResult>((resolve) => {
        const timer = setTimer(() => finish('timeout'), timeoutMs)
        function finish(result: CartFlushResult): void {
          clearTimer(timer)
          settle = null
          inFlight = null
          resolve(result)
        }
        settle = finish
        try {
          deps.send()
        } catch {
          finish('unavailable')
        }
      })
      return inFlight
    },
    acknowledge: () => settle?.('flushed')
  }
}
