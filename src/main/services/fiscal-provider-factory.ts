/**
 * Chooses which {@link FiscalizationProvider} a till runs.
 *
 * Split out of `main/index.ts`'s bootstrap so the one decision that can
 * breach Rule 2 — printing a fiscal block for a sale that was never
 * filed — is a single testable function rather than an inline ternary.
 *
 * A packaged build resolves to {@link RealFiscalizationProvider}
 * unconditionally. The mock is reached only through a dev-only dynamic
 * import, so `import.meta.env.DEV` also keeps `mock-etims-provider.ts`
 * out of the production bundle; `scripts/verify-no-mock-provider.cjs`
 * asserts that at build time rather than trusting tree-shaking.
 */

import type { FiscalizationProvider } from './integrations/etims.js'
import {
  RealFiscalizationProvider,
  type RealFiscalizationProviderOptions
} from './integrations/real-etims-provider.js'

/** Minimal logging surface, matching the convention in `real-etims-provider.ts`. */
export interface FiscalProviderLogger {
  log(message: string): void
  warn(message: string): void
}

/** Options accepted by {@link resolveFiscalizationProvider}. */
export interface ResolveFiscalizationProviderOptions {
  /**
   * `app.isPackaged`. Passed in rather than imported so this module has
   * no Electron dependency and can be unit tested. `true` forces the
   * real provider regardless of {@link mockRequested}.
   */
  isPackaged: boolean
  /** Whether the till's config asked for the mock provider. */
  mockRequested: boolean
  /** Constructor options forwarded to {@link RealFiscalizationProvider}. */
  realOptions: RealFiscalizationProviderOptions
  /** Defaults to `console`. */
  logger?: FiscalProviderLogger
}

/**
 * Resolves the fiscalization provider for this run.
 *
 * @param {ResolveFiscalizationProviderOptions} options
 * @returns {Promise<FiscalizationProvider>}
 */
export async function resolveFiscalizationProvider(
  options: ResolveFiscalizationProviderOptions
): Promise<FiscalizationProvider> {
  const logger = options.logger ?? console

  if (options.mockRequested && options.isPackaged) {
    logger.warn(
      '[rubis-pos] Mock fiscalization was requested but this is a packaged build — ' +
        'using the real fiscal device. The mock provider is not shipped.'
    )
  }

  if (options.mockRequested && !options.isPackaged && import.meta.env.DEV) {
    const { MockFiscalizationProvider } = await import('./integrations/mock-etims-provider.js')
    logger.warn(
      '[rubis-pos] Using MockFiscalizationProvider — invoice numbers are synthetic ' +
        'and nothing is filed with KRA. Development only.'
    )
    return new MockFiscalizationProvider()
  }

  return new RealFiscalizationProvider(options.realOptions)
}
