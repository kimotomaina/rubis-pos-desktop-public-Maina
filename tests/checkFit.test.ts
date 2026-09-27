/**
 * `resolveCheckFitForcedScreen` tests (docs/phase-167 Part B item 1).
 *
 * Pure, framework-free, tested directly — split out of `main/index.ts`
 * specifically so this could be unit tested at all (that file imports
 * Electron at module load time and is not importable in a test run).
 */

import { describe, it, expect } from 'vitest'
import { resolveCheckFitForcedScreen } from '../src/main/lib/checkFit.js'

describe('resolveCheckFitForcedScreen', () => {
  it('returns null when unset — the real state of every actual launch', () => {
    expect(resolveCheckFitForcedScreen(undefined)).toBeNull()
  })

  it('returns the raw value unchanged when set', () => {
    expect(resolveCheckFitForcedScreen('zReport')).toBe('zReport')
    expect(resolveCheckFitForcedScreen('variantModal')).toBe('variantModal')
    expect(resolveCheckFitForcedScreen('mpesaManualKeyboard')).toBe('mpesaManualKeyboard')
  })

  it('treats an empty string as set, not as unset — only a genuinely absent variable resolves to null', () => {
    expect(resolveCheckFitForcedScreen('')).toBe('')
  })
})
