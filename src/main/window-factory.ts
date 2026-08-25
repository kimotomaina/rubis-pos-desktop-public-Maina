import { join } from 'node:path'

/**
 * Immutable configuration object returned to the main-process caller.
 * Contains every BrowserWindow option that affects security.
 */
export interface BrowserWindowConfig {
  width: number
  height: number
  minWidth: number
  minHeight: number
  show: boolean
  resizable: boolean
  fullscreenable: boolean
  autoHideMenuBar: boolean
  backgroundColor: string
  title: string
  icon: string
  webPreferences: {
    preload: string
    sandbox: boolean
    contextIsolation: boolean
    nodeIntegration: boolean
    webSecurity: boolean
    allowRunningInsecureContent: boolean
  }
}

/**
 * Runtime options consumed by {@link createBrowserWindowConfig}.
 */
export interface CreateWindowOptions {
  isDev: boolean
  preloadPath: string
  rendererHtmlPath: string
  /** Only consumed by {@link createBrowserWindowConfig} — optional so callers of {@link resolveLoadTarget} can omit it. */
  iconPath?: string
  devServerUrl?: string
}

/**
 * Resolved load target that tells the BrowserWindow how to reach the
 * renderer — either a URL (dev server) or a local HTML file (prod).
 */
export type LoadTarget = { type: 'url'; url: string } | { type: 'file'; path: string }

/**
 * Builds a hardened BrowserWindow configuration with the secure defaults
 * that every Electron app should enforce:
 *
 *  • `contextIsolation` — isolates the preload context from the renderer.
 *  • `sandbox`           — restricts Node APIs inside the renderer.
 *  • `nodeIntegration: false` — no direct Node access from renderer JS.
 *  • `webSecurity: true` — blocks mixed-content and remote-file loads.
 *  • `allowRunningInsecureContent: false` — belt-and-braces alongside
 *    `webSecurity`; blocks active mixed content (e.g. an `http://`
 *    script) even if some future code path relaxed `webSecurity`
 *    without touching this line (Phase 12, Task 3).
 *
 * Extracting this function keeps the security policy unit-testable without
 * booting the real Electron runtime.
 *
 * @param {CreateWindowOptions} options — runtime paths and dev flag
 * @returns {BrowserWindowConfig} the immutable window configuration
 */
export function createBrowserWindowConfig(options: CreateWindowOptions): BrowserWindowConfig {
  return {
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 768,
    show: false,
    // Resizable so the native Windows maximize/restore button works —
    // previously locked to prevent cashiers from dragging the window
    // around, but that also disabled that button entirely. F11 (wired
    // in main/index.ts) still offers true fullscreen (title bar hidden).
    resizable: true,
    fullscreenable: true,
    autoHideMenuBar: true,
    backgroundColor: '#0f172a',
    title: 'RUBIS POS',
    icon: options.iconPath ?? '',
    webPreferences: {
      preload: options.preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  }
}

/**
 * Decides whether the renderer is loaded from the Vite dev server
 * (development) or from a bundled HTML file (production).
 *
 * @param {CreateWindowOptions} options — runtime paths and dev flag
 * @returns {LoadTarget} a URL target in dev, a file path in prod
 */
export function resolveLoadTarget(options: CreateWindowOptions): LoadTarget {
  if (options.isDev && options.devServerUrl) {
    return { type: 'url', url: options.devServerUrl }
  }
  return { type: 'file', path: options.rendererHtmlPath }
}

/**
 * Convenience helper that joins a path relative to the main-process
 * bundle directory (the `out/main/` folder in production).
 *
 * @param {...string[]} segments
 * @returns {string} the absolute path
 */
export function resolveMainWindowPath(...segments: string[]): string {
  return join(__dirname, ...segments)
}
