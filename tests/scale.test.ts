/**
 * `computeZoom` and `applyAutoZoom` (phase-143, Phase E1).
 *
 * `computeZoom` is driven directly, the pure-function pattern
 * `checkoutMath.test.ts`/`paginate.test.ts` use. `applyAutoZoom` is
 * driven against a plain fake satisfying `ZoomableWindow` — no Electron
 * runtime needed, since the interface was written narrow for exactly
 * this (see its doc comment in `scale.ts`).
 *
 * The menu-lockdown and window-wiring assertions (no zoom accelerators,
 * `setVisualZoomLevelLimits(1, 1)`, `applyAutoZoom` actually called from
 * `createWindow`) are source-inspection tests, the `stockTakeGuard`
 * pattern: `main/index.ts` does full app/IPC/database bring-up at import
 * time and cannot be unit-imported the way `lib/scale.ts` can.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  computeZoom,
  applyAutoZoom,
  DESIGN_WIDTH,
  DESIGN_HEIGHT,
  MIN_ZOOM,
  MAX_ZOOM,
  type ZoomableWindow
} from '../src/main/lib/scale.js'

/** The 9 supported cases (phase-142's own CDP emulation sizes), CSS/DIP px. */
const CASES = [
  { name: '1366x768@100', w: 1366, h: 768 },
  { name: '1366x768@125', w: 1093, h: 614 },
  { name: '1366x768@150', w: 911, h: 512 },
  { name: '1920x1080@100', w: 1920, h: 1080 },
  { name: '1920x1080@125', w: 1536, h: 864 },
  { name: '1920x1080@150', w: 1280, h: 720 },
  { name: '2560x1440@100', w: 2560, h: 1440 },
  { name: '2560x1440@125', w: 2048, h: 1152 },
  { name: '2560x1440@150', w: 1707, h: 960 }
]

describe('computeZoom', () => {
  it('is 1 at exactly the design box', () => {
    expect(computeZoom(DESIGN_WIDTH, DESIGN_HEIGHT)).toBe(1)
  })

  it.each(CASES)('$name resolves to the exact measured zoom', ({ w, h }) => {
    const expected = Math.min(w / DESIGN_WIDTH, h / DESIGN_HEIGHT)
    expect(computeZoom(w, h)).toBeCloseTo(expected, 10)
  })

  it('the smallest of the 9 cases is 1366x768@150 (the physical-key floor case)', () => {
    const zooms = CASES.map((c) => computeZoom(c.w, c.h))
    const smallest = CASES[zooms.indexOf(Math.min(...zooms))]
    expect(smallest.name).toBe('1366x768@150')
  })

  it('is monotonically increasing in width, height held fixed', () => {
    const heights = 772
    const widths = [800, 1000, 1366, 1600, 2000, 2600]
    const zooms = widths.map((w) => computeZoom(w, heights))
    for (let i = 1; i < zooms.length; i += 1) {
      expect(zooms[i]).toBeGreaterThanOrEqual(zooms[i - 1])
    }
  })

  it('is monotonically increasing in height, width held fixed', () => {
    const width = 1366
    const heights = [400, 500, 772, 900, 1200, 1600]
    const zooms = heights.map((h) => computeZoom(width, h))
    for (let i = 1; i < zooms.length; i += 1) {
      expect(zooms[i]).toBeGreaterThanOrEqual(zooms[i - 1])
    }
  })

  it('clamps to MIN_ZOOM for a window far smaller than the design box', () => {
    expect(computeZoom(200, 150)).toBe(MIN_ZOOM)
  })

  it('the smallest window this app allows (900x500, window-factory.ts) still computes an unclamped zoom', () => {
    // Confirms the new floor and the design box were chosen so the till
    // never bottoms out at MIN_ZOOM in ordinary use — MIN_ZOOM exists
    // for pathological sizes, not the app's own supported minimum.
    const z = computeZoom(900, 500)
    expect(z).toBeCloseTo(500 / 772, 10) // height binds: 500/772 < 900/1366
    expect(z).toBeGreaterThan(MIN_ZOOM)
  })

  it('clamps to MAX_ZOOM for a window far larger than any supported display', () => {
    expect(computeZoom(10000, 10000)).toBe(MAX_ZOOM)
  })

  it('none of the 9 supported cases hits either clamp', () => {
    for (const { w, h } of CASES) {
      const z = computeZoom(w, h)
      expect(z).toBeGreaterThan(MIN_ZOOM)
      expect(z).toBeLessThan(MAX_ZOOM)
    }
  })

  it('treats a non-positive or non-finite dimension as 0 (never NaN/Infinity out), so it always degrades to the safe MIN_ZOOM rather than guessing', () => {
    expect(computeZoom(0, 772)).toBe(MIN_ZOOM)
    expect(computeZoom(1366, 0)).toBe(MIN_ZOOM)
    expect(computeZoom(-100, 772)).toBe(MIN_ZOOM)
    expect(computeZoom(NaN, 772)).toBe(MIN_ZOOM)
    expect(computeZoom(1366, Infinity)).toBe(MIN_ZOOM) // Infinity is not finite either — untrustworthy, not "very large"
    expect(Number.isFinite(computeZoom(NaN, NaN))).toBe(true)
  })

  describe('the invariant: content / zoom >= the design box, for every in-range input', () => {
    /** width/height pairs whose *unclamped* ratio falls inside [MIN_ZOOM, MAX_ZOOM] — extremes are excluded on purpose (§ "clamps to" tests above cover those). */
    const inRangePairs = [
      ...CASES.map((c) => [c.w, c.h] as const),
      [700, 400] as const,
      [1366, 772] as const,
      [3000, 1800] as const,
      [3200, 1200] as const // wide, short — height binds
    ]

    it.each(inRangePairs)('holds for %dx%d', (w, h) => {
      const z = computeZoom(w, h)
      expect(z).toBeGreaterThan(MIN_ZOOM)
      expect(z).toBeLessThan(MAX_ZOOM)
      // A tiny epsilon absorbs floating-point rounding, not a real shortfall.
      expect(w / z).toBeGreaterThanOrEqual(DESIGN_WIDTH - 1e-9)
      expect(h / z).toBeGreaterThanOrEqual(DESIGN_HEIGHT - 1e-9)
    })
  })
})

describe('applyAutoZoom', () => {
  /** A fake satisfying ZoomableWindow, recording every setZoomFactor call and letting the test fire each trigger by name. */
  function fakeWindow(initialBounds: { width: number; height: number }) {
    const listeners: Record<string, (() => void)[]> = {
      readyToShow: [],
      resize: [],
      move: [],
      didFinishLoad: [],
      zoomChanged: []
    }
    let bounds = initialBounds
    const zoomCalls: number[] = []
    const win: ZoomableWindow = {
      getContentBounds: () => bounds,
      setZoomFactor: (factor) => zoomCalls.push(factor),
      onReadyToShow: (l) => listeners.readyToShow.push(l),
      onResize: (l) => listeners.resize.push(l),
      onMove: (l) => listeners.move.push(l),
      onDidFinishLoad: (l) => listeners.didFinishLoad.push(l),
      onZoomChanged: (l) => listeners.zoomChanged.push(l)
    }
    return {
      win,
      zoomCalls,
      setBounds: (next: { width: number; height: number }) => {
        bounds = next
      },
      fire: (trigger: keyof typeof listeners) => listeners[trigger].forEach((l) => l())
    }
  }

  it.each([
    ['ready-to-show', 'readyToShow'],
    ['resize', 'resize'],
    ['move', 'move'],
    ['did-finish-load', 'didFinishLoad'],
    ['zoom-changed', 'zoomChanged']
  ] as const)('calls setZoomFactor with the computed zoom when %s fires', (_label, trigger) => {
    const { win, zoomCalls, fire } = fakeWindow({ width: 1920, height: 1080 })
    applyAutoZoom(win)

    zoomCalls.length = 0 // clear whatever registering triggered, if anything
    fire(trigger)

    expect(zoomCalls).toEqual([computeZoom(1920, 1080)])
  })

  it('registers exactly one listener per trigger — one wiring, not a growing pile', () => {
    const { win } = fakeWindow({ width: 1366, height: 768 })
    let calls = 0
    const counting: ZoomableWindow = {
      ...win,
      onReadyToShow: (l) => {
        calls += 1
        win.onReadyToShow(l)
      }
    }
    applyAutoZoom(counting)
    expect(calls).toBe(1)
  })

  it('zoom-changed restores the CURRENT computed factor, recomputed from bounds each time', () => {
    const { win, zoomCalls, fire, setBounds } = fakeWindow({ width: 1920, height: 1080 })
    applyAutoZoom(win)
    zoomCalls.length = 0

    // A resize lands first (e.g. the window moved to a bigger monitor)...
    setBounds({ width: 2560, height: 1440 })
    fire('resize')
    // ...then a stray zoom gesture fires. It must be reverted to the
    // factor for the CURRENT bounds, not the one computed at wiring time.
    fire('zoomChanged')

    expect(zoomCalls).toEqual([computeZoom(2560, 1440), computeZoom(2560, 1440)])
  })

  it('every one of the 9 cases, applied via ready-to-show, matches computeZoom exactly', () => {
    for (const { w, h } of CASES) {
      const { win, zoomCalls, fire } = fakeWindow({ width: w, height: h })
      applyAutoZoom(win)
      zoomCalls.length = 0
      fire('readyToShow')
      expect(zoomCalls).toEqual([computeZoom(w, h)])
    }
  })
})

describe('the main process locks the zoom this till shows down to what applyAutoZoom computes', () => {
  const mainSource = readFileSync(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8')

  it('removes the application menu entirely, not just hides the bar', () => {
    // autoHideMenuBar (window-factory.ts) only hides the bar; Electron's
    // default menu still registers Ctrl+Plus/Minus/0 as zoom
    // accelerators underneath it regardless. Only a null application
    // menu removes those accelerators.
    expect(mainSource).toMatch(/Menu\.setApplicationMenu\(null\)/)
  })

  it('never builds a menu carrying a zoom role', () => {
    expect(mainSource).not.toMatch(/role:\s*['"](zoomIn|zoomOut|resetZoom)['"]/)
  })

  it('disables pinch-to-zoom / Ctrl+scroll page zoom', () => {
    expect(mainSource).toMatch(/setVisualZoomLevelLimits\(\s*1\s*,\s*1\s*\)/)
  })

  it('wires applyAutoZoom into window creation', () => {
    expect(mainSource).toContain('applyAutoZoom(')
    expect(mainSource).toMatch(/import\s*\{\s*applyAutoZoom\s*\}\s*from\s*['"]\.\/lib\/scale\.js['"]/)
  })

  it('drives the adapter from the real window/webContents, not a stand-in', () => {
    const start = mainSource.indexOf('applyAutoZoom({')
    expect(start).toBeGreaterThan(-1)
    const end = mainSource.indexOf('})', start)
    const adapter = mainSource.slice(start, end)
    expect(adapter).toContain('mainWindow.getContentBounds()')
    expect(adapter).toContain('mainWindow.webContents.setZoomFactor')
    expect(adapter).toContain("mainWindow.on('ready-to-show'")
    expect(adapter).toContain("mainWindow.on('resize'")
    expect(adapter).toContain("mainWindow.on('move'")
    expect(adapter).toContain("mainWindow.webContents.on('did-finish-load'")
    expect(adapter).toContain("mainWindow.webContents.on('zoom-changed'")
  })
})

describe('receipts never read the renderer zoom (phase-142 §1, confirmed again here)', () => {
  it('the PDF and thermal-printer receipt services never touch webContents or a BrowserWindow', () => {
    for (const file of ['pdf-receipt.ts', 'printer.ts']) {
      const source = readFileSync(join(process.cwd(), 'src', 'main', 'services', file), 'utf8')
      expect(source).not.toMatch(/webContents|BrowserWindow|printToPDF/)
    }
  })
})

/** Guards the constants this whole file's expectations are pinned to. */
describe('design constants', () => {
  it('match the POS screen natural size phase-142 measured', () => {
    expect(DESIGN_WIDTH).toBe(1366)
    expect(DESIGN_HEIGHT).toBe(772)
  })
})
