/**
 * Security hardening tests (Phase 5.1; Phase 14 adds
 * `buildDevContentSecurityPolicy` coverage).
 *
 * Verifies the Content-Security-Policy header builders in isolation —
 * the actual `session.defaultSession.webRequest.onHeadersReceived`
 * wiring lives in `src/main/index.ts` and requires a live Electron
 * `session`, so it isn't re-asserted here; this covers the pure,
 * testable policy contracts instead.
 */

import { describe, it, expect } from 'vitest'
import {
  buildCspHeaders,
  buildDevContentSecurityPolicy,
  CONTENT_SECURITY_POLICY
} from '../src/main/window-factory.js'

describe('Content-Security-Policy', () => {
  it('restricts default and script sources to the app itself', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'self'")
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'")
  })

  it('allows connections to the app itself and any Shopify store subdomain', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("connect-src 'self' https://*.myshopify.com")
  })

  it('allows inline styles (required by the Tailwind runtime) but nothing else for style-src', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("style-src 'self' 'unsafe-inline'")
  })

  it('allows self, data URIs, and https images', () => {
    expect(CONTENT_SECURITY_POLICY).toContain('img-src \'self\' data: https:')
  })

  it('builds a header map keyed by Content-Security-Policy with a single value', () => {
    const headers = buildCspHeaders()

    expect(Object.keys(headers)).toEqual(['Content-Security-Policy'])
    expect(headers['Content-Security-Policy']).toEqual([CONTENT_SECURITY_POLICY])
  })

  it('never permits unsafe-eval or a wildcard script source', () => {
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe-eval')
    expect(CONTENT_SECURITY_POLICY.split(';').find((d) => d.trim().startsWith('script-src'))).not.toContain('*')
  })
})

describe('buildDevContentSecurityPolicy (Phase 14)', () => {
  const devPolicy = buildDevContentSecurityPolicy('http://localhost:5173')

  it('allows inline scripts — required for @vitejs/plugin-react\'s Fast Refresh preamble', () => {
    const scriptSrc = devPolicy.split(';').find((d) => d.trim().startsWith('script-src'))
    expect(scriptSrc).toContain("'unsafe-inline'")
  })

  it('includes the dev server origin on every directive that needs it', () => {
    expect(devPolicy).toContain('http://localhost:5173')
  })

  it('includes the dev server\'s WebSocket origin in connect-src for HMR', () => {
    const connectSrc = devPolicy.split(';').find((d) => d.trim().startsWith('connect-src'))
    expect(connectSrc).toContain('ws://localhost:5173')
  })

  it('still permits the Shopify Admin API domain in connect-src', () => {
    const connectSrc = devPolicy.split(';').find((d) => d.trim().startsWith('connect-src'))
    expect(connectSrc).toContain('https://*.myshopify.com')
  })

  it('never permits unsafe-eval', () => {
    expect(devPolicy).not.toContain('unsafe-eval')
  })

  it('derives a wss:// origin from an https:// dev server URL', () => {
    const policy = buildDevContentSecurityPolicy('https://localhost:5173')
    const connectSrc = policy.split(';').find((d) => d.trim().startsWith('connect-src'))
    expect(connectSrc).toContain('wss://localhost:5173')
  })
})

describe('buildCspHeaders() with an explicit policy (Phase 14)', () => {
  it('defaults to the strict production policy when no argument is given', () => {
    expect(buildCspHeaders()['Content-Security-Policy']).toEqual([CONTENT_SECURITY_POLICY])
  })

  it('uses the given policy verbatim when one is passed', () => {
    const devPolicy = buildDevContentSecurityPolicy('http://localhost:5173')
    expect(buildCspHeaders(devPolicy)['Content-Security-Policy']).toEqual([devPolicy])
  })
})
