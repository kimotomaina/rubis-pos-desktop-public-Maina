/**
 * Renderer-side twin of `formatVatRateLabel` in `main/services/reports.ts`
 * (docs/phase-158-1). Kept as its own one-line copy rather than a value
 * import from `main/services` because every existing renderer import from
 * that directory is `import type` only (main-process code is never
 * bundled into the renderer) — this repo's own convention, not a new one.
 */
export function formatVatRateLabel(rate: number): string {
  return `VAT included (calculated at ${Math.round(rate * 100)}%)`
}
