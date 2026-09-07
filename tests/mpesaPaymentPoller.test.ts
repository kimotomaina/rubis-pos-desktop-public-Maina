/**
 * `mpesaPaymentPoller` tests.
 *
 * `createMpesaPaymentPoller` is plain TypeScript (no React), so it's
 * exercised directly with fake timers — no component-test harness
 * needed. Mirrors the fake-timer style already used for
 * `connectivityMonitor.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createMpesaPaymentPoller,
  MPESA_POLL_INTERVAL_MS,
  MPESA_POLL_TIMEOUT_MS
} from '../src/renderer/src/lib/mpesaPaymentPoller.js'
import type { ServiceResult } from '../src/main/services/shopify-types.js'
import type { StkPushStatusResult } from '../src/main/services/integrations/mpesa.js'

function makeCallbacks() {
  return {
    onPending: vi.fn(),
    onSuccess: vi.fn(),
    onFailed: vi.fn(),
    onTimeout: vi.fn()
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('createMpesaPaymentPoller success/failure resolution', () => {
  it('reports pending on inconclusive polls, then resolves success with the receipt number', async () => {
    const queryStatus = vi
      .fn<(id: string) => Promise<ServiceResult<StkPushStatusResult>>>()
      .mockResolvedValueOnce({ success: true, data: { status: 'pending' } })
      .mockResolvedValueOnce({ success: true, data: { status: 'success', receiptNumber: 'NLJ7RT61SV' } })
    const callbacks = makeCallbacks()
    const poller = createMpesaPaymentPoller({ checkoutRequestId: 'ws_CO_1', queryStatus, callbacks })

    poller.start()
    await vi.advanceTimersByTimeAsync(MPESA_POLL_INTERVAL_MS)
    expect(callbacks.onPending).toHaveBeenCalledTimes(1)
    expect(callbacks.onPending).toHaveBeenCalledWith(MPESA_POLL_TIMEOUT_MS - MPESA_POLL_INTERVAL_MS)

    await vi.advanceTimersByTimeAsync(MPESA_POLL_INTERVAL_MS)
    expect(callbacks.onSuccess).toHaveBeenCalledTimes(1)
    expect(callbacks.onSuccess).toHaveBeenCalledWith('NLJ7RT61SV')
    expect(callbacks.onFailed).not.toHaveBeenCalled()
    expect(callbacks.onTimeout).not.toHaveBeenCalled()

    // Polling has stopped — no further queries after resolving.
    await vi.advanceTimersByTimeAsync(MPESA_POLL_INTERVAL_MS * 3)
    expect(queryStatus).toHaveBeenCalledTimes(2)
  })

  it('resolves failed with the Daraja result description', async () => {
    const queryStatus = vi
      .fn<(id: string) => Promise<ServiceResult<StkPushStatusResult>>>()
      .mockResolvedValue({
        success: true,
        data: { status: 'failed', resultDesc: 'Request cancelled by user' }
      })
    const callbacks = makeCallbacks()
    const poller = createMpesaPaymentPoller({ checkoutRequestId: 'ws_CO_1', queryStatus, callbacks })

    poller.start()
    await vi.advanceTimersByTimeAsync(MPESA_POLL_INTERVAL_MS)

    expect(callbacks.onFailed).toHaveBeenCalledTimes(1)
    expect(callbacks.onFailed).toHaveBeenCalledWith('Request cancelled by user')
    expect(callbacks.onSuccess).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(MPESA_POLL_INTERVAL_MS * 3)
    expect(queryStatus).toHaveBeenCalledTimes(1)
  })

  it('falls back to a generic failure reason when Daraja omits resultDesc', async () => {
    const queryStatus = vi
      .fn<(id: string) => Promise<ServiceResult<StkPushStatusResult>>>()
      .mockResolvedValue({ success: true, data: { status: 'failed' } })
    const callbacks = makeCallbacks()
    const poller = createMpesaPaymentPoller({ checkoutRequestId: 'ws_CO_1', queryStatus, callbacks })

    poller.start()
    await vi.advanceTimersByTimeAsync(MPESA_POLL_INTERVAL_MS)

    expect(callbacks.onFailed).toHaveBeenCalledWith('M-Pesa payment failed or was cancelled')
  })

  it('treats a failed status query as pending rather than erroring out', async () => {
    const queryStatus = vi
      .fn<(id: string) => Promise<ServiceResult<StkPushStatusResult>>>()
      .mockResolvedValue({ success: false, error: 'network error' })
    const callbacks = makeCallbacks()
    const poller = createMpesaPaymentPoller({ checkoutRequestId: 'ws_CO_1', queryStatus, callbacks })

    poller.start()
    await vi.advanceTimersByTimeAsync(MPESA_POLL_INTERVAL_MS)

    expect(callbacks.onPending).toHaveBeenCalledTimes(1)
    expect(callbacks.onFailed).not.toHaveBeenCalled()
  })
})

describe('createMpesaPaymentPoller timeout', () => {
  it('calls onTimeout after timeoutMs of persistent pending status, then stops', async () => {
    const queryStatus = vi
      .fn<(id: string) => Promise<ServiceResult<StkPushStatusResult>>>()
      .mockResolvedValue({ success: true, data: { status: 'pending' } })
    const callbacks = makeCallbacks()
    const poller = createMpesaPaymentPoller({ checkoutRequestId: 'ws_CO_1', queryStatus, callbacks })

    poller.start()
    await vi.advanceTimersByTimeAsync(MPESA_POLL_TIMEOUT_MS)

    expect(callbacks.onTimeout).toHaveBeenCalledTimes(1)
    expect(callbacks.onSuccess).not.toHaveBeenCalled()
    expect(callbacks.onFailed).not.toHaveBeenCalled()
    // The final tick that crosses the timeout threshold fires onTimeout
    // instead of issuing one more query.
    expect(queryStatus).toHaveBeenCalledTimes(MPESA_POLL_TIMEOUT_MS / MPESA_POLL_INTERVAL_MS - 1)

    await vi.advanceTimersByTimeAsync(MPESA_POLL_INTERVAL_MS * 3)
    expect(callbacks.onTimeout).toHaveBeenCalledTimes(1)
  })
})

describe('createMpesaPaymentPoller cleanup and overlap guards', () => {
  it('never queries when stopped before the first tick', async () => {
    const queryStatus = vi.fn<(id: string) => Promise<ServiceResult<StkPushStatusResult>>>()
    const callbacks = makeCallbacks()
    const poller = createMpesaPaymentPoller({ checkoutRequestId: 'ws_CO_1', queryStatus, callbacks })

    poller.start()
    poller.stop()
    await vi.advanceTimersByTimeAsync(MPESA_POLL_TIMEOUT_MS)

    expect(queryStatus).not.toHaveBeenCalled()
    expect(callbacks.onTimeout).not.toHaveBeenCalled()
  })

  it('discards a response that resolves after stop() was called', async () => {
    let resolveQuery: (value: ServiceResult<StkPushStatusResult>) => void = () => {}
    const queryStatus = vi.fn<(id: string) => Promise<ServiceResult<StkPushStatusResult>>>(
      () =>
        new Promise((resolve) => {
          resolveQuery = resolve
        })
    )
    const callbacks = makeCallbacks()
    const poller = createMpesaPaymentPoller({ checkoutRequestId: 'ws_CO_1', queryStatus, callbacks })

    poller.start()
    await vi.advanceTimersByTimeAsync(MPESA_POLL_INTERVAL_MS)
    expect(queryStatus).toHaveBeenCalledTimes(1)

    poller.stop()
    resolveQuery({ success: true, data: { status: 'success', receiptNumber: 'LATE123' } })
    await vi.advanceTimersByTimeAsync(0)

    expect(callbacks.onSuccess).not.toHaveBeenCalled()
  })

  it('does not overlap a slow in-flight query with the next tick', async () => {
    let resolveFirst: (value: ServiceResult<StkPushStatusResult>) => void = () => {}
    const queryStatus = vi
      .fn<(id: string) => Promise<ServiceResult<StkPushStatusResult>>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockResolvedValue({ success: true, data: { status: 'pending' } })
    const callbacks = makeCallbacks()
    const poller = createMpesaPaymentPoller({ checkoutRequestId: 'ws_CO_1', queryStatus, callbacks })

    poller.start()
    await vi.advanceTimersByTimeAsync(MPESA_POLL_INTERVAL_MS)
    expect(queryStatus).toHaveBeenCalledTimes(1)

    // A second interval elapses while the first query is still in flight.
    await vi.advanceTimersByTimeAsync(MPESA_POLL_INTERVAL_MS)
    expect(queryStatus).toHaveBeenCalledTimes(1)

    resolveFirst({ success: true, data: { status: 'pending' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(callbacks.onPending).toHaveBeenCalledTimes(1)
  })

  it('stop() is idempotent and safe to call multiple times', () => {
    const queryStatus = vi.fn<(id: string) => Promise<ServiceResult<StkPushStatusResult>>>()
    const callbacks = makeCallbacks()
    const poller = createMpesaPaymentPoller({ checkoutRequestId: 'ws_CO_1', queryStatus, callbacks })

    poller.start()
    expect(() => {
      poller.stop()
      poller.stop()
      poller.stop()
    }).not.toThrow()
  })
})
