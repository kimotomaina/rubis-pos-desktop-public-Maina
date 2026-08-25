/**
 * Vitest global setup file.
 *
 * Declares the jsdom environment as React-act-aware so hooks mounted
 * directly via `react-dom/client` (Phase 5's `useBarcodeScanner`
 * tests) don't log the "not configured to support act()" warning.
 */
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

export {}