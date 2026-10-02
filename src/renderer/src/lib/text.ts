/**
 * Renderer-side twin of `titleCaseName` in `main/lib/text.ts` (docs/phase-198-2).
 * Kept as its own copy because every existing renderer import from `main/` is
 * `import type` only (main-process code is never bundled into the renderer), the
 * same convention as `vatLabel.ts`. `tests/titleCaseName.test.ts` runs both over
 * the same names, so the two cannot drift apart.
 *
 * @param {string} name
 * @returns {string}
 */
export function titleCaseName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/(^|[ \-'’])(\p{L})/gu, (_match, boundary: string, letter: string) => boundary + letter.toUpperCase())
}
