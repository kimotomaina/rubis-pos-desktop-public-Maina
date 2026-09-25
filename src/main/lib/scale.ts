/**
 * Whole-window scaling (phase-143, Phase E1).
 *
 * The touchscreen till showed a horizontal scrollbar, a vertical
 * scrollbar and a clipped Complete Sale button at 1920x1080 under
 * Windows 150% display scaling (phase-142's audit). The fix is not a
 * responsive layout — it's the same trick Windows' own display scaling
 * uses: render the whole page bigger or smaller as one image, via
 * Electron's `webContents.setZoomFactor`, so every screen keeps the
 * exact layout it was designed at ({@link DESIGN_WIDTH}x{@link
 * DESIGN_HEIGHT}) and simply appears larger on a roomier screen, smaller
 * on a cramped one.
 *
 * `computeZoom` is pure and takes the window's real content-area size in
 * DIP (`BrowserWindow.getContentBounds()`) — never the renderer's
 * `innerWidth`, which the zoom itself changes. Feeding the zoom's own
 * output back into its input would be a feedback loop; DIP content
 * bounds don't move when zoom changes, so there is none.
 */

/**
 * The layout every screen is designed to fit, in CSS px, at zoom 1 —
 * the POS catalog screen's own natural size (header 80 + the Cash
 * checkout stack 692, phase-142 §3). Every other screen is smaller.
 */
export const DESIGN_WIDTH = 1366
export const DESIGN_HEIGHT = 772

/**
 * Zoom bounds. 0.5 and 2.5 are far outside anything the 9 supported
 * cases ever compute (phase-142's measured range is ~0.66-1.87) — they
 * exist only so a window dragged to an extreme size (a stray 200px
 * sliver, a wall of 8K monitors) gets a sane, capped zoom instead of an
 * unreadable or absurdly oversized one.
 */
export const MIN_ZOOM = 0.5
export const MAX_ZOOM = 2.5

/**
 * `dimension / design`, guarding the division: a non-finite (including
 * `Infinity`, not just `NaN`) or non-positive dimension — a minimized
 * window, a transient 0x0 during a resize — yields 0 rather than
 * `NaN`/`Infinity`. An untrustworthy reading always degrades to the
 * safe {@link MIN_ZOOM} rather than being read as "very large" and
 * pushed toward {@link MAX_ZOOM}.
 */
function ratio(dimension: number, design: number): number {
  return Number.isFinite(dimension) && dimension > 0 ? dimension / design : 0
}

/**
 * The zoom factor that makes the window's content area show at least a
 * {@link DESIGN_WIDTH}x{@link DESIGN_HEIGHT} CSS viewport, in both axes,
 * clamped to [{@link MIN_ZOOM}, {@link MAX_ZOOM}].
 *
 * Taking the smaller of the two axis ratios as the zoom is what
 * guarantees both: zoom `z = min(contentWidth/W, contentHeight/H)`
 * satisfies `z <= contentWidth/W` (so `contentWidth/z >= W`) and
 * likewise for height. The other axis gets whatever extra room the
 * window's aspect ratio leaves over — never less than the design box.
 *
 * @param {number} contentWidth — DIP, from `BrowserWindow.getContentBounds()`
 * @param {number} contentHeight — DIP, from `BrowserWindow.getContentBounds()`
 * @returns {number} the zoom factor to pass to `setZoomFactor`
 */
export function computeZoom(contentWidth: number, contentHeight: number): number {
  const raw = Math.min(ratio(contentWidth, DESIGN_WIDTH), ratio(contentHeight, DESIGN_HEIGHT))
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, raw))
}

/**
 * The slice of `BrowserWindow`/`WebContents` {@link applyAutoZoom} needs,
 * as one named hook per trigger rather than a generic `on(event, …)` —
 * `BrowserWindow.on` is overloaded per event name with no single
 * signature covering all five at once, so a generic pass-through here
 * would fight TypeScript's overload resolution for no benefit. Named
 * methods also make the interface trivial to satisfy with a plain fake
 * in tests instead of booting Electron.
 */
export interface ZoomableWindow {
  getContentBounds: () => { width: number; height: number }
  setZoomFactor: (factor: number) => void
  onReadyToShow: (listener: () => void) => void
  onResize: (listener: () => void) => void
  onMove: (listener: () => void) => void
  onDidFinishLoad: (listener: () => void) => void
  onZoomChanged: (listener: () => void) => void
}

/**
 * Wires `win` so its zoom is always {@link computeZoom} of its current
 * content bounds, and stays that way.
 *
 * Five triggers, each covering a way the "right" zoom can change or be
 * undone:
 *  - `ready-to-show` — the window's first real size (post-`maximize()`,
 *    though `resize` below catches it too if bounds aren't final yet).
 *  - `resize`, `move` — a Windows DPI change, or the window crossing
 *    onto a differently-scaled monitor, arrives as one of these.
 *  - `did-finish-load` — every navigation (including a dev-mode reload)
 *    resets `webContents`' zoom to 1, so it must be reapplied after load,
 *    not just once at window creation.
 *  - `zoom-changed` — Chromium's own page-zoom-level change (Ctrl+scroll,
 *    a pinch gesture). Re-applying the *computed* value here, rather
 *    than just blocking the event, immediately undoes it: this till has
 *    exactly one correct zoom, derived from the window size, and no
 *    other one is ever valid. Recomputing from `getContentBounds()`
 *    again (not reusing a cached factor) means this is correct even if
 *    the window was also resized in the same instant.
 *
 * There is no feedback loop: every handler reads `getContentBounds()`
 * (DIP, set by the OS/window manager) and writes `setZoomFactor`
 * (Chromium's render scale) — one always drives the other, never itself.
 *
 * @param {ZoomableWindow} win
 * @returns {void}
 */
export function applyAutoZoom(win: ZoomableWindow): void {
  const reapply = (): void => {
    const { width, height } = win.getContentBounds()
    win.setZoomFactor(computeZoom(width, height))
  }

  win.onReadyToShow(reapply)
  win.onResize(reapply)
  win.onMove(reapply)
  win.onDidFinishLoad(reapply)
  win.onZoomChanged(reapply)
}
