/**
 * Connectivity monitor tests, mirroring `networkMonitor.test.ts`'s
 * fake-timer conventions. `checkHttpReachable`/`checkTcpReachable`
 * are tested separately against real (but local/deterministic)
 * network behavior rather than mocked, since they're thin I/O
 * wrappers with little logic worth mocking around.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import axios from 'axios'
import {
  createConnectivityMonitor,
  checkHttpReachable,
  checkTcpReachable,
  mockConnectedResult,
  mockDisconnectedResult,
  type ConnectivityCheckResult
} from '../src/main/services/connectivityMonitor.js'

function ok(): ConnectivityCheckResult {
  return { connected: true, lastCheckedAt: new Date().toISOString(), latencyMs: 5 }
}

function fail(error = 'unreachable'): ConnectivityCheckResult {
  return { connected: false, lastCheckedAt: new Date().toISOString(), error }
}

describe('createConnectivityMonitor', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('runs an immediate check on start() before any interval elapses', async () => {
    const checkMpesa = vi.fn().mockResolvedValue(ok())
    const checkFiscal = vi.fn().mockResolvedValue(ok())
    const checkPrinter = vi.fn().mockResolvedValue(ok())
    const emit = vi.fn()
    const monitor = createConnectivityMonitor({ checkMpesa, checkFiscal, checkPrinter, emit, intervalMs: 30_000 })

    monitor.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(checkMpesa).toHaveBeenCalledTimes(1)
    expect(checkFiscal).toHaveBeenCalledTimes(1)
    expect(checkPrinter).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('polls again every intervalMs', async () => {
    const checkMpesa = vi.fn().mockResolvedValue(ok())
    const checkFiscal = vi.fn().mockResolvedValue(ok())
    const checkPrinter = vi.fn().mockResolvedValue(ok())
    const emit = vi.fn()
    const monitor = createConnectivityMonitor({ checkMpesa, checkFiscal, checkPrinter, emit, intervalMs: 30_000 })

    monitor.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(30_000)

    expect(checkMpesa).toHaveBeenCalledTimes(3)
    expect(emit).toHaveBeenCalledTimes(3)
  })

  it('emits the full status on every pass, even with no change', async () => {
    const checkMpesa = vi.fn().mockResolvedValue(ok())
    const checkFiscal = vi.fn().mockResolvedValue(ok())
    const checkPrinter = vi.fn().mockResolvedValue(ok())
    const emit = vi.fn()
    const monitor = createConnectivityMonitor({ checkMpesa, checkFiscal, checkPrinter, emit, intervalMs: 30_000 })

    monitor.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(30_000)

    expect(emit).toHaveBeenNthCalledWith(2, {
      mpesa: expect.objectContaining({ connected: true }),
      fiscal: expect.objectContaining({ connected: true }),
      printer: expect.objectContaining({ connected: true })
    })
  })

  it('stop() cancels the timer', async () => {
    const checkMpesa = vi.fn().mockResolvedValue(ok())
    const checkFiscal = vi.fn().mockResolvedValue(ok())
    const checkPrinter = vi.fn().mockResolvedValue(ok())
    const emit = vi.fn()
    const monitor = createConnectivityMonitor({ checkMpesa, checkFiscal, checkPrinter, emit, intervalMs: 30_000 })

    monitor.start()
    await vi.advanceTimersByTimeAsync(0)
    monitor.stop()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(checkMpesa).toHaveBeenCalledTimes(1)
  })

  it('checkNow() runs an ad-hoc check and updates getStatus()', async () => {
    const checkMpesa = vi.fn().mockResolvedValue(fail('device offline'))
    const checkFiscal = vi.fn().mockResolvedValue(ok())
    const checkPrinter = vi.fn().mockResolvedValue(ok())
    const emit = vi.fn()
    const monitor = createConnectivityMonitor({ checkMpesa, checkFiscal, checkPrinter, emit })

    const result = await monitor.checkNow()

    expect(result.mpesa.connected).toBe(false)
    expect(monitor.getStatus().mpesa.error).toBe('device offline')
  })

  it('coalesces overlapping checkNow() calls into a single in-flight run', async () => {
    vi.useRealTimers()
    let resolveMpesa: (value: ConnectivityCheckResult) => void = () => {}
    const checkMpesa = vi.fn(
      () => new Promise<ConnectivityCheckResult>((resolve) => { resolveMpesa = resolve })
    )
    const checkFiscal = vi.fn().mockResolvedValue(ok())
    const checkPrinter = vi.fn().mockResolvedValue(ok())
    const emit = vi.fn()
    const monitor = createConnectivityMonitor({ checkMpesa, checkFiscal, checkPrinter, emit })

    const first = monitor.checkNow()
    const second = monitor.checkNow()
    resolveMpesa(ok())
    await Promise.all([first, second])

    expect(checkMpesa).toHaveBeenCalledTimes(1)
  })

  it('getStatus() reports a "not yet checked" placeholder before the first check', () => {
    const monitor = createConnectivityMonitor({
      checkMpesa: vi.fn(),
      checkFiscal: vi.fn(),
      checkPrinter: vi.fn(),
      emit: vi.fn()
    })

    expect(monitor.getStatus().mpesa).toEqual({
      connected: false,
      lastCheckedAt: '',
      error: 'Not yet checked'
    })
  })
})

describe('mockConnectedResult', () => {
  it('always reports connected with zero latency', () => {
    const result = mockConnectedResult()
    expect(result.connected).toBe(true)
    expect(result.latencyMs).toBe(0)
  })
})

describe('mockDisconnectedResult', () => {
  it('always reports disconnected with a mock-mode message', () => {
    const result = mockDisconnectedResult()
    expect(result.connected).toBe(false)
    expect(result.error).toBe('Mock mode enabled — not a real connection')
  })

  it('accepts a custom message', () => {
    const result = mockDisconnectedResult('M-Pesa mock mode enabled')
    expect(result.error).toBe('M-Pesa mock mode enabled')
  })
})

describe('checkHttpReachable', () => {
  it('reports connected on any HTTP response, including a 4xx', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 404 })

    const result = await checkHttpReachable('https://example.invalid')

    expect(result.connected).toBe(true)
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    vi.restoreAllMocks()
  })

  it('reports disconnected on a transport-level failure', async () => {
    vi.spyOn(axios, 'get').mockRejectedValue(new Error('ECONNREFUSED'))

    const result = await checkHttpReachable('https://example.invalid')

    expect(result.connected).toBe(false)
    expect(result.error).toBe('ECONNREFUSED')
    vi.restoreAllMocks()
  })
})

describe('checkTcpReachable', () => {
  it('reports disconnected when nothing listens on the target port', async () => {
    const result = await checkTcpReachable('tcp://127.0.0.1:1', 2000)

    expect(result.connected).toBe(false)
    expect(result.error).toBeTruthy()
  }, 10_000)

  it('reports disconnected with a parse error for a malformed interface string', async () => {
    const result = await checkTcpReachable('not-a-url')

    expect(result.connected).toBe(false)
    expect(result.error).toMatch(/Invalid printer interface/)
  })
})
