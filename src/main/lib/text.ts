/**
 * Small pure text helpers.
 */

/**
 * A person's name for display: lower-cased, then the first letter of each word
 * upper-cased, where a word starts after the beginning, a space, a hyphen or an
 * apostrophe (docs/phase-198-2). Surrounding space is trimmed and runs of spaces
 * collapse to one. Digits and anything that is not a letter are left as they are.
 * Presentation only: stored names and login matching never go through this.
 *
 * "LILIAN ANYANGO" is "Lilian Anyango"; "mary-anne o'neil" is "Mary-Anne O'Neil".
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
