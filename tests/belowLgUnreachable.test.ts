/**
 * Below-`lg` stacking is unreachable once the zoom invariant holds
 * (phase-142 §7f / Phase E2(f)).
 *
 * The catalog view stacks the cart and checkout panel vertically below
 * Tailwind's `lg` breakpoint (1024px) instead of the normal 65/35 split.
 * `computeZoom` (`src/main/lib/scale.ts`) guarantees the window's
 * effective CSS width is always at least `DESIGN_WIDTH` (1366px) — safely
 * above 1024 — so that stacked branch can never actually render on this
 * till. The spec calls for proving that with a test rather than
 * restyling or removing the `lg:` classes, so this asserts the
 * invariant numerically (reusing the same 9 real-world cases
 * `tests/scale.test.ts` covers) and confirms via source inspection that
 * the `lg:` stacking classes are still there, untouched.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { computeZoom, DESIGN_WIDTH } from '../src/main/lib/scale.js'

/** Tailwind's default `lg` breakpoint — the width below which App.tsx stacks the catalog view. */
const LG_BREAKPOINT = 1024

/** The same 9 supported-display cases measured in phase-142 and covered by tests/scale.test.ts. */
const CASES: { name: string; width: number; height: number }[] = [
  { name: '1366x768 @100%', width: 1366, height: 768 },
  { name: '1366x768 @125%', width: 1093, height: 614 },
  { name: '1366x768 @150%', width: 911, height: 512 },
  { name: '1920x1080 @100%', width: 1920, height: 1080 },
  { name: '1920x1080 @125%', width: 1536, height: 864 },
  { name: '1920x1080 @150%', width: 1280, height: 720 },
  { name: '2560x1440 @100%', width: 2560, height: 1440 },
  { name: '2560x1440 @125%', width: 2048, height: 1152 },
  { name: '2560x1440 @150%', width: 1707, height: 960 }
]

describe('below-lg stacking is unreachable under the zoom invariant', () => {
  it.each(CASES)('$name: effective width stays above the lg breakpoint', ({ width, height }) => {
    const zoom = computeZoom(width, height)
    const effectiveWidth = width / zoom
    expect(effectiveWidth).toBeGreaterThanOrEqual(DESIGN_WIDTH)
    expect(effectiveWidth).toBeGreaterThan(LG_BREAKPOINT)
  })

  it('holds for the new window floor (900x500) too', () => {
    const zoom = computeZoom(900, 500)
    expect(900 / zoom).toBeGreaterThan(LG_BREAKPOINT)
  })

  it('DESIGN_WIDTH itself is comfortably above the lg breakpoint, so the invariant alone proves this for any supported size', () => {
    expect(DESIGN_WIDTH).toBeGreaterThan(LG_BREAKPOINT)
  })

  it('App.tsx still stacks below lg — this test replaces restyling it, per the spec, not the classes themselves', () => {
    const appTsx = readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'App.tsx'), 'utf8')
    expect(appTsx).toContain('lg:flex-row')
    expect(appTsx).toContain('lg:w-[65%]')
    expect(appTsx).toContain('lg:w-[35%]')
  })
})
