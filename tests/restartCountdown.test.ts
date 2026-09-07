/**
 * `restartCountdown` tests.
 *
 * `createRestartCountdown` is plain TypeScript (no React), exercised
 * directly with fake timers — mirrors `mpesaPaymentPoller.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRestartCountdown, RESTART_COUNTDOWN_MS } from '../src/renderer/src/lib/restartCountdown.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('createRestartCountdown', () => {
  it('reports the full duration immediately on start()', () => {
    const onTick = vi.fn()
    const onComplete = vi.fn()
    const countdown = createRestartCountdown({ callbacks: { onTick, onComplete } })

    countdown.start()

    expect(onTick).toHaveBeenCalledTimes(1)
    expect(onTick).toHaveBeenCalledWith(RESTART_COUNTDOWN_MS)
  })

  it('ticks down once per second and calls onComplete exactly once at zero', () => {
    const onTick = vi.fn()
    const onComplete = vi.fn()
    const countdown = createRestartCountdown({ callbacks: { onTick, onComplete } })

    countdown.start()
    vi.advanceTimersByTime(1000)
    expect(onTick).toHaveBeenLastCalledWith(RESTART_COUNTDOWN_MS - 1000)

    vi.advanceTimersByTime(RESTART_COUNTDOWN_MS - 1000)

    expect(onComplete).toHaveBeenCalledTimes(1)
    // No further ticks after completion.
    vi.advanceTimersByTime(5000)
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('stop() is idempotent and prevents further ticks', () => {
    const onTick = vi.fn()
    const onComplete = vi.fn()
    const countdown = createRestartCountdown({ callbacks: { onTick, onComplete } })

    countdown.start()
    onTick.mockClear()
    countdown.stop()
    countdown.stop()
    vi.advanceTimersByTime(RESTART_COUNTDOWN_MS)

    expect(onTick).not.toHaveBeenCalled()
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('supports a custom duration and interval', () => {
    const onTick = vi.fn()
    const onComplete = vi.fn()
    const countdown = createRestartCountdown({
      callbacks: { onTick, onComplete },
      durationMs: 3000,
      intervalMs: 1000
    })

    countdown.start()
    vi.advanceTimersByTime(3000)

    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(onTick.mock.calls.map((call) => call[0])).toEqual([3000, 2000, 1000])
  })
})
