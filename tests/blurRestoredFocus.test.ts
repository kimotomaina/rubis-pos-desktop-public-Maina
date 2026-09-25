/**
 * Reload-focus bug (phase-142 §11, Phase E2(d)): Electron restores focus
 * to the last-focused setup field across a renderer reload, and focus
 * opens the docked keyboard, so a crash-restart could land on a setup
 * screen with the sheet already open over a field nobody tapped.
 *
 * `blurRestoredFocus` is exercised directly here (it needs no React and
 * no timers, so a plain DOM test is the most direct proof of its logic);
 * a source-inspection check separately confirms both setup screens wire
 * it into a mount-time `useLayoutEffect`, since simulating Chromium's own
 * cross-reload focus restoration through `createRoot` isn't practical —
 * `createRoot` always mounts into a container with nothing focused yet.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { blurRestoredFocus } from '../src/renderer/src/lib/blurRestoredFocus.js'

describe('blurRestoredFocus', () => {
  it('blurs a focused descendant of root', () => {
    const root = document.createElement('div')
    const input = document.createElement('input')
    root.appendChild(input)
    document.body.appendChild(root)
    input.focus()
    expect(document.activeElement).toBe(input)

    blurRestoredFocus(root)

    expect(document.activeElement).not.toBe(input)
    root.remove()
  })

  it('does nothing when nothing inside root is focused', () => {
    const root = document.createElement('div')
    const input = document.createElement('input')
    root.appendChild(input)
    document.body.appendChild(root)
    // Nothing focused — document.activeElement is document.body.
    expect(document.activeElement).not.toBe(input)

    expect(() => blurRestoredFocus(root)).not.toThrow()
    expect(document.activeElement).not.toBe(input)
    root.remove()
  })

  it('never blurs focus that lives outside root — a real tap elsewhere is untouched', () => {
    const root = document.createElement('div')
    const outside = document.createElement('input')
    document.body.appendChild(root)
    document.body.appendChild(outside)
    outside.focus()
    expect(document.activeElement).toBe(outside)

    blurRestoredFocus(root)

    expect(document.activeElement).toBe(outside)
    root.remove()
    outside.remove()
  })

  it('is a no-op when root itself is null (unmounted / not yet attached)', () => {
    expect(() => blurRestoredFocus(null)).not.toThrow()
  })

  it('does not blur root itself, only a descendant', () => {
    const root = document.createElement('div')
    root.tabIndex = -1
    document.body.appendChild(root)
    root.focus()
    expect(document.activeElement).toBe(root)

    blurRestoredFocus(root)

    expect(document.activeElement).toBe(root)
    root.remove()
  })
})

describe('blurRestoredFocus wiring (source inspection)', () => {
  /**
   * `createRoot` always mounts into an empty, unfocused container, so a
   * true end-to-end "reload restored focus before mount" scenario can't
   * be driven through React here — this confirms the call site instead:
   * both setup screens import the guard and run it from a mount-only
   * (`useLayoutEffect(..., [])`) effect, not from the field's own
   * `onFocus` (which must keep opening the keyboard for a real tap,
   * exactly as `setupScreens.test.ts` asserts).
   */
  const SCREENS = [
    join('src', 'renderer', 'src', 'components', 'EtimsSetupGate.tsx'),
    join('src', 'renderer', 'src', 'components', 'OnboardingScreen.tsx')
  ]

  it.each(SCREENS)('%s blurs restored focus once at mount, via useLayoutEffect', (path) => {
    const contents = readFileSync(join(process.cwd(), path), 'utf8')

    expect(contents).toContain("import { blurRestoredFocus } from '../lib/blurRestoredFocus.js'")
    expect(contents).toMatch(/useLayoutEffect\(\(\) => \{\s*blurRestoredFocus\(rootRef\.current\)\s*\}, \[\]\)/)
    expect(contents).toContain('ref={rootRef}')
  })

  it.each(SCREENS)('%s no longer reserves pb-keyboard-sheet', (path) => {
    const contents = readFileSync(join(process.cwd(), path), 'utf8')
    expect(contents).not.toContain('pb-keyboard-sheet')
  })
})
