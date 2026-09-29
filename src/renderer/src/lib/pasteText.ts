import type { KeyboardMode } from '../stores/keyboardStore.js'

/**
 * What pasting `pasted` after `current` should leave in a field, given the
 * key set that field's on-screen keyboard offers.
 *
 * Pasting has to produce what typing the same characters would have, or a
 * field could hold a value its own keyboard can never make (a lowercase
 * KRA PIN, letters in a port). So the text is cut down to the mode's own
 * character set, and to `maxLength`, exactly as a key press past either
 * limit is a no-op.
 *
 * Line breaks and tabs are always dropped, and the ends are trimmed: a
 * token or password copied from a page or a message nearly always drags a
 * trailing newline or space with it, which no keyboard key could type and
 * which would make a correct secret fail. Spaces inside the text stay.
 *
 * @param {string} current the field's value now
 * @param {string} pasted the clipboard text
 * @param {KeyboardMode | undefined} mode the keyboard's mode (`caps` when omitted)
 * @param {number} [maxLength]
 * @returns {string} the new value; `current` unchanged when nothing usable was pasted
 */
export function pasteIntoValue(
  current: string,
  pasted: string,
  mode: KeyboardMode | undefined,
  maxLength?: number
): string {
  let text = pasted.replace(/[\r\n\t]+/g, '').trim()
  switch (mode ?? 'caps') {
    case 'numeric':
      text = text.replace(/[^0-9]/g, '')
      break
    case 'decimal': {
      let allowDot = !current.includes('.')
      text = [...text.replace(/[^0-9.]/g, '')]
        .filter((char) => {
          if (char !== '.') return true
          const keep = allowDot
          allowDot = false
          return keep
        })
        .join('')
      break
    }
    case 'ip':
      text = text.replace(/[^0-9.]/g, '')
      break
    case 'caps':
      text = text.toUpperCase()
      break
    case 'text':
      break
  }
  const next = current + text
  return maxLength !== undefined ? next.slice(0, maxLength) : next
}