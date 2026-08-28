/**
 * KRA PIN format helper tests.
 */

import { describe, it, expect } from 'vitest'
import { isValidKraPinFormat, KRA_PIN_MAX_LENGTH } from '../src/renderer/src/lib/kraPin.js'

describe('isValidKraPinFormat', () => {
  it('accepts a standard individual PIN starting with P', () => {
    expect(isValidKraPinFormat('P051234567Z')).toBe(true)
  })

  it('accepts a standard PIN starting with A', () => {
    expect(isValidKraPinFormat('A123456789B')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isValidKraPinFormat('p051234567z')).toBe(true)
  })

  it('tolerates surrounding whitespace', () => {
    expect(isValidKraPinFormat('  P051234567Z  ')).toBe(true)
  })

  it('rejects a PIN with the wrong leading letter', () => {
    expect(isValidKraPinFormat('X051234567Z')).toBe(false)
  })

  it('rejects a PIN missing the trailing letter', () => {
    expect(isValidKraPinFormat('P0512345678')).toBe(false)
  })

  it('rejects a PIN that is too short', () => {
    expect(isValidKraPinFormat('P05123Z')).toBe(false)
  })

  it('rejects a PIN that is too long', () => {
    expect(isValidKraPinFormat('P051234567890Z')).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(isValidKraPinFormat('')).toBe(false)
  })

  it('exposes the standard PIN length as a constant', () => {
    expect(KRA_PIN_MAX_LENGTH).toBe(11)
  })
})
