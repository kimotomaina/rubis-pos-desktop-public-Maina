/**
 * Enjoy brand tokens (phase-136).
 *
 * `index.css` is the single source of the app's colours and font. These
 * tests pin the brand values exactly (no substitutes) and check that the
 * `rose-600`/`rose-700` steps every primary button already uses resolve
 * to the brand red, and that the bundled Quicksand files it points at
 * actually exist.
 */

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const CSS_PATH = join(process.cwd(), 'src', 'renderer', 'src', 'index.css')
const css = readFileSync(CSS_PATH, 'utf8')

describe('theme tokens', () => {
  it('declares the brand red, white and black exactly', () => {
    expect(css).toMatch(/--color-brand-red:\s*#E31A37;/)
    expect(css).toMatch(/--color-brand-white:\s*#FFFFFF;/)
    expect(css).toMatch(/--color-brand-black:\s*#000000;/)
  })

  it('points the primary rose-600 at the brand red', () => {
    expect(css).toMatch(/--color-rose-600:\s*var\(--color-brand-red\);/)
  })

  it('derives the rose-700 pressed shade from the brand red and black only', () => {
    expect(css).toMatch(
      /--color-rose-700:\s*color-mix\(in oklab, var\(--color-brand-red\) \d+%, var\(--color-brand-black\)\);/
    )
  })

  it('makes Quicksand the sans font', () => {
    expect(css).toMatch(/--font-sans:\s*'Quicksand',/)
  })

  it('emits every token even when no utility names it directly', () => {
    expect(css).toMatch(/@theme static\s*\{/)
  })

  it('bundles every Quicksand file it references, with its licence', () => {
    const urls = Array.from(css.matchAll(/url\('([^']+)'\)/g), (m) => m[1])
    expect(urls.length).toBeGreaterThan(0)
    for (const url of urls) {
      expect(existsSync(join(dirname(CSS_PATH), url))).toBe(true)
    }
    expect(existsSync(join(dirname(CSS_PATH), 'assets', 'fonts', 'OFL.txt'))).toBe(true)
  })

  it('defines the shared app-theme root class', () => {
    expect(css).toMatch(/@utility app-theme\s*\{/)
  })
})
