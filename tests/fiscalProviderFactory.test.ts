/**
 * Provider-selection tests — the one decision that can breach Rule 2 by
 * printing a fiscal block for a sale that was never filed.
 *
 * The build-time half of the guarantee (the mock never reaching the
 * production bundle) is asserted by `scripts/verify-no-mock-provider.cjs`
 * on every `npm run build`; this covers the runtime half.
 */

import { describe, it, expect, vi } from 'vitest'
import { resolveFiscalizationProvider } from '../src/main/services/fiscal-provider-factory.js'
import { RealFiscalizationProvider } from '../src/main/services/integrations/real-etims-provider.js'
import { MockFiscalizationProvider } from '../src/main/services/integrations/mock-etims-provider.js'

/** Silent logger so the mock/packaged warnings don't pollute test output. */
const silentLogger = { log: vi.fn(), warn: vi.fn() }

describe('resolveFiscalizationProvider', () => {
  it('returns the real provider in a packaged build even when mock is requested', async () => {
    const provider = await resolveFiscalizationProvider({
      isPackaged: true,
      mockRequested: true,
      realOptions: {},
      logger: silentLogger
    })

    expect(provider).toBeInstanceOf(RealFiscalizationProvider)
    expect(provider).not.toBeInstanceOf(MockFiscalizationProvider)
  })

  it('warns when a packaged build asked for the mock, so the override is not silent', async () => {
    const logger = { log: vi.fn(), warn: vi.fn() }

    await resolveFiscalizationProvider({
      isPackaged: true,
      mockRequested: true,
      realOptions: {},
      logger
    })

    expect(logger.warn).toHaveBeenCalledOnce()
    expect(logger.warn.mock.calls[0][0]).toMatch(/packaged build/i)
  })

  it('returns the real provider when mock was not requested', async () => {
    const provider = await resolveFiscalizationProvider({
      isPackaged: false,
      mockRequested: false,
      realOptions: {},
      logger: silentLogger
    })

    expect(provider).toBeInstanceOf(RealFiscalizationProvider)
  })

  it('returns the real provider in a packaged build when mock was not requested', async () => {
    const provider = await resolveFiscalizationProvider({
      isPackaged: true,
      mockRequested: false,
      realOptions: {},
      logger: silentLogger
    })

    expect(provider).toBeInstanceOf(RealFiscalizationProvider)
  })

  it('returns the mock provider only in an unpackaged build that asked for it', async () => {
    const provider = await resolveFiscalizationProvider({
      isPackaged: false,
      mockRequested: true,
      realOptions: {},
      logger: silentLogger
    })

    expect(provider).toBeInstanceOf(MockFiscalizationProvider)
  })

  it('forwards the real provider its constructor options', async () => {
    const provider = await resolveFiscalizationProvider({
      isPackaged: true,
      mockRequested: false,
      realOptions: { baseUrl: 'http://192.168.1.9:4444/', defaultVatClass: 'B' },
      logger: silentLogger
    })

    expect(provider).toBeInstanceOf(RealFiscalizationProvider)
    // `defaultVatClass` is private; the observable proof the options were
    // threaded through is the axios instance's resolved base URL.
    const http = (provider as unknown as { http: { defaults: { baseURL?: string } } }).http
    expect(http.defaults.baseURL).toBe('http://192.168.1.9:4444/')
  })
})
