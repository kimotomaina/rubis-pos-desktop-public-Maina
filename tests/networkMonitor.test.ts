/**
 * Network monitor tests (Phase 3).
 *
 * The probe and emitter are injected fakes driven by fake timers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createNetworkMonitor } from '../src/main/services/network.js'

describe('createNetworkMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('start() takes a silent baseline without emitting', () => {
    const probe = vi.fn(() => true)
    const emit = vi.fn()
    const monitor = createNetworkMonitor({ isOnline: probe, emit })

    monitor.start()

    expect(probe).toHaveBeenCalledTimes(1)
    expect(emit).not.toHaveBeenCalled()
    expect(monitor.isOnline()).toBe(true)
  })

  it('emits only when connectivity actually changes', () => {
    let state = true
    const probe = vi.fn(() => state)
    const emit = vi.fn()
    const monitor = createNetworkMonitor({
      isOnline: probe,
      emit,
      intervalMs: 5_000
    })

    monitor.start()
    vi.advanceTimersByTime(10_000)
    expect(emit).not.toHaveBeenCalled()

    state = false
    vi.advanceTimersByTime(5_000)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith(false)
    expect(monitor.isOnline()).toBe(false)

    // stable again — no further emits
    vi.advanceTimersByTime(10_000)
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('checkNow() probes immediately and emits on transition', () => {
    let state = true
    const probe = vi.fn(() => state)
    const emit = vi.fn()
    const monitor = createNetworkMonitor({ isOnline: probe, emit })
    monitor.start()

    state = false
    const result = monitor.checkNow()

    expect(result).toBe(false)
    expect(emit).toHaveBeenCalledWith(false)
  })

  it('stop() cancels the poll timer', () => {
    const probe = vi.fn(() => true)
    const emit = vi.fn()
    const monitor = createNetworkMonitor({
      isOnline: probe,
      emit,
      intervalMs: 5_000
    })

    monitor.start()
    monitor.stop()
    vi.advanceTimersByTime(60_000)

    // only the baseline probe fired
    expect(probe).toHaveBeenCalledTimes(1)
  })
})
