/**
 * `describeUnfiledCount` tests (phase-95) — pure display logic for the
 * unfiled sales badge, tested directly without mounting the component,
 * matching `needsAttention.test.ts`/`fiscalNotice.test.ts`'s convention.
 */

import { describe, it, expect } from 'vitest'
import { describeUnfiledCount } from '../src/renderer/src/lib/unfiledCount.js'

describe('describeUnfiledCount', () => {
  it('reads quiet and clean at zero', () => {
    expect(describeUnfiledCount(0)).toEqual({ label: 'All sales filed', tone: 'quiet' })
  })

  it('is singular for exactly one', () => {
    expect(describeUnfiledCount(1)).toEqual({ label: '1 sale not filed', tone: 'alert' })
  })

  it('is plural and noticeable for more than one', () => {
    expect(describeUnfiledCount(3)).toEqual({ label: '3 sales not filed', tone: 'alert' })
  })

  it('never shows a code or jargon, just plain counts', () => {
    const { label } = describeUnfiledCount(12)
    expect(label).toBe('12 sales not filed')
    expect(label).not.toMatch(/code|error|kind/i)
  })
})
