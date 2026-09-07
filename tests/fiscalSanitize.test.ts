/**
 * Fiscal text sanitizer tests — per the G03 manual, symbols outside a
 * conservative allow-list can silently block a request from reaching
 * TIMS, so every free-text fiscal field must be scrubbed before use.
 */

import { describe, it, expect } from 'vitest'
import { sanitizeFiscalText } from '../src/main/services/integrations/fiscal-sanitize.js'

describe('sanitizeFiscalText', () => {
  it('keeps letters, digits, spaces, periods, commas, and hyphens', () => {
    expect(sanitizeFiscalText('Rubis Energy Ltd., Nairobi-Town', 100)).toBe(
      'Rubis Energy Ltd., Nairobi-Town'
    )
  })

  it('strips symbols the G03 manual warns can block TIMS submission', () => {
    expect(sanitizeFiscalText('Rubis@Energy #1 (KE)!', 100)).toBe('RubisEnergy 1 KE')
  })

  it('collapses whitespace left behind after stripping symbols', () => {
    expect(sanitizeFiscalText('A & B    Traders', 100)).toBe('A B Traders')
  })

  it('trims leading/trailing whitespace', () => {
    expect(sanitizeFiscalText('   Rubis   ', 100)).toBe('Rubis')
  })

  it('truncates to maxLen after cleaning', () => {
    expect(sanitizeFiscalText('A Very Long Company Name That Exceeds Thirty Characters', 30)).toHaveLength(
      30
    )
    expect(sanitizeFiscalText('A Very Long Company Name That Exceeds Thirty Characters', 30)).toBe(
      'A Very Long Company Name That '
    )
  })

  it('returns an empty string for null/undefined input', () => {
    expect(sanitizeFiscalText(undefined, 30)).toBe('')
    expect(sanitizeFiscalText(null, 30)).toBe('')
  })

  it('returns an empty string when every character is stripped', () => {
    expect(sanitizeFiscalText('@#$%^&*()', 30)).toBe('')
  })
})
