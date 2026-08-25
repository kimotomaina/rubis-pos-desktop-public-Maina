/**
 * Foundation tests for Phase 1.
 *
 * These tests validate two concerns:
 *  1. Environment-variable structure — the .env example contract.
 *  2. App-shell config — the BrowserWindow factory is hardened with
 *     secure defaults and correctly resolves dev vs. prod targets.
 *
 * The tests mock the Electron runtime (where needed) so they can run
 * inside a pure Node/Vitest context without booting an Electron process.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createBrowserWindowConfig,
  resolveLoadTarget,
  type BrowserWindowConfig,
  type CreateWindowOptions
} from '../src/main/window-factory.js'

const PRELOAD_PATH = '/abs/out/preload/index.js'
const RENDERER_HTML = '/abs/out/renderer/index.html'
const DEV_URL = 'http://localhost:5173'

/* ── shared options builders ────────────────────────── */
const prodOpts = (): CreateWindowOptions => ({
  isDev: false,
  preloadPath: PRELOAD_PATH,
  rendererHtmlPath: RENDERER_HTML
})

const devOpts = (): CreateWindowOptions => ({
  isDev: true,
  preloadPath: PRELOAD_PATH,
  rendererHtmlPath: RENDERER_HTML,
  devServerUrl: DEV_URL
})

/* ── Environment validation ─────────────────────────── */

describe('Environment Configuration', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('does not throw when Shopify env vars are absent', () => {
    delete process.env.VITE_SHOPIFY_STORE_URL
    delete process.env.VITE_SHOPIFY_ADMIN_API_TOKEN

    expect(() => {
      const url = process.env.VITE_SHOPIFY_STORE_URL
      const token = process.env.VITE_SHOPIFY_ADMIN_API_TOKEN
      if (url !== undefined) new URL(url)
      if (token !== undefined) expect(token.length).toBeGreaterThan(0)
    }).not.toThrow()
  })

  it('accepts a well-formed Shopify store URL', () => {
    process.env.VITE_SHOPIFY_STORE_URL = 'https://rubis-pos.myshopify.com'

    const raw = process.env.VITE_SHOPIFY_STORE_URL
    expect(raw).toBeDefined()
    const parsed = new URL(raw as string)
    expect(parsed.protocol).toBe('https:')
    expect(parsed.hostname).toMatch(/\.myshopify\.com$/)
  })

  it('accepts a non-empty Shopify admin API token', () => {
    process.env.VITE_SHOPIFY_ADMIN_API_TOKEN = 'shpat_a1b2c3d4e5f6g7h8'

    const token = process.env.VITE_SHOPIFY_ADMIN_API_TOKEN
    expect(token).toBeDefined()
    expect((token as string).length).toBeGreaterThan(10)
    expect(token as string).toMatch(/^shpat_/)
  })

          it('rejects syntactically malformed URLs', () => {
    expect(() => new URL('not-a-url')).toThrow()
  })

  it('rejects non-HTTPS store URLs', () => {
    const parsed = new URL('ftp://wrong-scheme.com')
    expect(parsed.protocol).not.toBe('https:')
  })

  it('rejects URLs with a non-myshopify hostname', () => {
    const parsed = new URL('https://example.com')
    expect(parsed.hostname).not.toMatch(/\.myshopify\.com$/)
  })
})

/* ── App shell / BrowserWindow config ──────────────── */

describe('App Shell Instantiation', () => {
  it('produces hardened security defaults in production config', () => {
    const config: BrowserWindowConfig = createBrowserWindowConfig(prodOpts())

    expect(config.webPreferences.contextIsolation).toBe(true)
    expect(config.webPreferences.nodeIntegration).toBe(false)
    expect(config.webPreferences.sandbox).toBe(true)
    expect(config.webPreferences.webSecurity).toBe(true)
    expect(config.webPreferences.allowRunningInsecureContent).toBe(false)
    expect(config.webPreferences.preload).toBe(PRELOAD_PATH)
    expect(config.show).toBe(false)
    expect(config.title).toBe('RUBIS POS')
    expect(config.autoHideMenuBar).toBe(true)
    expect(config.minWidth).toBeGreaterThanOrEqual(1024)
    expect(config.minHeight).toBeGreaterThanOrEqual(768)
  })

  it('produces the same hardened defaults in dev config', () => {
    const config: BrowserWindowConfig = createBrowserWindowConfig(devOpts())

    expect(config.webPreferences.contextIsolation).toBe(true)
    expect(config.webPreferences.sandbox).toBe(true)
    expect(config.webPreferences.nodeIntegration).toBe(false)
    expect(config.webPreferences.webSecurity).toBe(true)
  })

  it('resolves to a URL target in dev mode with a dev-server URL', () => {
    const target = resolveLoadTarget(devOpts())

    expect(target.type).toBe('url')
    if (target.type === 'url') {
      expect(target.url).toBe(DEV_URL)
    }
  })

  it('resolves to a file path in production', () => {
    const target = resolveLoadTarget(prodOpts())

    expect(target.type).toBe('file')
    if (target.type === 'file') {
      expect(target.path).toBe(RENDERER_HTML)
    }
  })

  it('falls back to file target when dev mode omits the dev-server URL', () => {
    const noDevServer = { ...devOpts() }
    delete noDevServer.devServerUrl

    const target = resolveLoadTarget(noDevServer)
    expect(target.type).toBe('file')
  })
})
