/**
 * The "no dark screens" guard (phase-136).
 *
 * Every pre-login screen used to carry its own hard-coded dark palette
 * (slate-800/900 surfaces, rose-950 error chips). They now share the
 * logged-in `app-theme`. A comment asking people not to reintroduce the
 * dark classes would not survive; this test fails the build instead, in
 * the same way `stockTakeGuard.test.ts` does.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const COMPONENTS = join('src', 'renderer', 'src', 'components')

/**
 * Every file that renders before the POS shell: onboarding, login, both
 * location gates, the shared location list, the fiscal setup gate, the
 * manager PIN modal shown over location confirmation, and `App.tsx`
 * itself (its config-loading placeholder).
 */
const PRE_LOGIN_FILES = [
  join(COMPONENTS, 'OnboardingScreen.tsx'),
  join(COMPONENTS, 'LoginScreen.tsx'),
  join(COMPONENTS, 'LocationConfirmScreen.tsx'),
  join(COMPONENTS, 'LocationPendingScreen.tsx'),
  join(COMPONENTS, 'LocationPicker.tsx'),
  join(COMPONENTS, 'EtimsSetupGate.tsx'),
  join(COMPONENTS, 'ManagerPinModal.tsx'),
  join('src', 'renderer', 'src', 'App.tsx')
]

/** The dark-theme classes the phase-135 audit found on those screens. */
const FORBIDDEN = [
  'bg-slate-700',
  'bg-slate-800',
  'bg-slate-900',
  'hover:bg-slate-600',
  'border-slate-600',
  'placeholder-slate-500',
  'bg-rose-950',
  'bg-emerald-950',
  'text-rose-300',
  'text-emerald-300',
  'ring-rose-900',
  'text-amber-400',
  'text-slate-300',
  'hover:text-slate-200'
]

function read(repoPath: string): string {
  return readFileSync(join(process.cwd(), repoPath), 'utf8')
}

describe('pre-login screens never use the old dark theme', () => {
  it('no pre-login file names a dark-theme class', () => {
    const offenders: string[] = []
    for (const file of PRE_LOGIN_FILES) {
      const contents = read(file)
      for (const token of FORBIDDEN) {
        if (contents.includes(token)) offenders.push(`${file} uses ${token}`)
      }
    }
    expect(offenders).toEqual([])
  })

  /** A renamed file would otherwise silently shrink the guard to nothing. */
  it('guards files that still exist', () => {
    for (const file of PRE_LOGIN_FILES) {
      expect(read(file).length).toBeGreaterThan(0)
    }
  })

  it('the logged-in shell and the loading placeholder use the same app-theme root class', () => {
    const roots = read(join('src', 'renderer', 'src', 'App.tsx')).match(/className="app-theme\b/g) ?? []
    expect(roots.length).toBeGreaterThanOrEqual(2)
  })

  it('the window background matches app-theme, so no dark frame shows before first paint', () => {
    expect(read(join('src', 'main', 'window-factory.ts'))).toContain("backgroundColor: '#f8fafc'")
  })
})
