/**
 * The Admin screens scroll (docs/phase-247). The wrapper that holds every Admin page was `overflow-hidden` (docs/phase-167), so a
 * list longer than the screen (staff, printers, Needs Attention, Stock Take, the fiscal test hops) was cut off. jsdom has no
 * layout, so this pins the wrapper's classes in `App.tsx` and that the Reports tab, which fills the height it is given, is
 * unchanged. Layout: not checked by check:fit (owner's rule). For the owner to check on the till.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (...parts: string[]): string => readFileSync(join(process.cwd(), 'src', 'renderer', 'src', ...parts), 'utf8').replace(/\r\n/g, '\n')

/** The element that holds `<AdminScreen`, as written in App.tsx. */
function adminWrapper(): string {
  const app = read('App.tsx')
  const at = app.indexOf('<AdminScreen')
  const open = app.lastIndexOf('<div', at)
  return app.slice(open, app.indexOf('>', open) + 1)
}

describe('the Admin wrapper', () => {
  it('scrolls vertically, with the always-visible bar, inside the height the page gives it', () => {
    const wrapper = adminWrapper()

    expect(wrapper).toContain('overflow-y-auto')
    expect(wrapper).toContain('touch-scrollbar')
    expect(wrapper).toContain('min-h-0 flex-1')
    expect(wrapper).not.toContain('overflow-hidden')
  })

  it('has the Reports tab fill the height it is given, so only its sections scroll there', () => {
    const admin = read('components', 'AdminScreen.tsx')

    expect(admin).toContain("activeTab === 'reports' ? ' flex flex-col'")
    expect(admin).toContain('h-full min-h-full')
  })
})
