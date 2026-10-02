/**
 * Per-item VAT class rules (docs/phase-194): the resolver, the device-group
 * arithmetic and the checkout gate. Pure functions, no device.
 */

import { describe, it, expect } from 'vitest'
import {
  compareVatGroups,
  expectedGroupTotals,
  hasNonAClass,
  resolveVatClass
} from '../src/main/lib/vatClass.js'
import { findVatClassRefusal } from '../src/main/lib/vatClassGate.js'

describe('resolveVatClass', () => {
  it.each(['A', 'B', 'C', 'D', 'E'])('keeps the known class %s', (letter) => {
    expect(resolveVatClass(letter)).toBe(letter)
  })

  it.each([undefined, null, '', ' ', '   '])('treats an absent or blank class (%j) as A', (raw) => {
    expect(resolveVatClass(raw)).toBe('A')
  })

  it.each(['e', ' E', 'c ', ' d '])('trims and upper-cases %j before matching', (raw) => {
    expect(resolveVatClass(raw)).toBe(raw.trim().toUpperCase())
  })

  it.each(['Z', 'AA', 'F', '0', 'EXEMPT', 5, true, {}])('returns null for the unknown class %j, never A', (raw) => {
    expect(resolveVatClass(raw)).toBeNull()
  })
})

describe('expectedGroupTotals / hasNonAClass', () => {
  const lines = [
    { unitPrice: 100, quantity: 2 },
    { unitPrice: 1, quantity: 1, vatClass: 'C' },
    { unitPrice: 0.5, quantity: 3, vatClass: 'e' },
    { unitPrice: 9, quantity: 1, vatClass: '' },
    { unitPrice: 7, quantity: 1, vatClass: 'Z' }
  ]

  it('sums amount per resolved class and leaves an unknown line out', () => {
    expect(expectedGroupTotals(lines)).toEqual({ A: 209, B: 0, C: 1, D: 0, E: 1.5 })
  })

  it('is true only when some line resolves to a class other than A', () => {
    expect(hasNonAClass(lines)).toBe(true)
    expect(hasNonAClass([{ unitPrice: 1, quantity: 1 }, { unitPrice: 1, quantity: 1, vatClass: ' ' }])).toBe(false)
    expect(hasNonAClass([{ unitPrice: 1, quantity: 1, vatClass: 'Z' }])).toBe(false)
  })
})

describe('compareVatGroups', () => {
  const expected = { A: 100, B: 0, C: 1, D: 0, E: 2.5 }

  it('agrees when every non-A group matches, ignoring group A entirely', () => {
    expect(compareVatGroups(expected, { A: '999.00', C: '1.00', E: '2.50' })).toBeNull()
    expect(compareVatGroups(expected, { C: '1', E: '2.5', B: '0.00' })).toBeNull()
  })

  it('reports an amount filed in the wrong group', () => {
    expect(compareVatGroups(expected, { C: '3.50' })).toMatch(/group C.*3\.50.*1\.00/)
    expect(compareVatGroups(expected, { C: '1.00', E: '0.00' })).toMatch(/group E/)
  })

  it('reports an amount in a group no line belongs to', () => {
    expect(compareVatGroups({ A: 5, B: 0, C: 0, D: 0, E: 0 }, { A: '5.00', D: '0.50' })).toMatch(/group D/)
  })

  it('treats an unparsable device amount as a disagreement', () => {
    expect(compareVatGroups(expected, { C: 'n/a', E: '2.50' })).toMatch(/group C/)
  })

  it('tolerates one cent', () => {
    expect(compareVatGroups(expected, { C: '1.01', E: '2.50' })).toBeNull()
    expect(compareVatGroups(expected, { C: '1.02', E: '2.50' })).not.toBeNull()
  })
})

describe('findVatClassRefusal (the checkout gate)', () => {
  const plain = { title: 'Bread', variantTitle: 'Default Title' }
  const exempt = { title: 'Maize flour', variantTitle: 'Default Title', vatClass: 'E', hsCode: '0013.12.02', hsName: 'Maize' }

  it('lets class A, absent and blank classes through with no HS data', () => {
    expect(findVatClassRefusal([plain, { ...plain, vatClass: 'A' }, { ...plain, vatClass: '' }])).toBeNull()
  })

  it('lets a non-A line through with a well-formed HS code and a name', () => {
    expect(findVatClassRefusal([plain, exempt, { ...exempt, vatClass: 'c', hsCode: ' 0015.12.00 ' }])).toBeNull()
  })

  it('refuses an unknown class and names the item', () => {
    const message = findVatClassRefusal([plain, { title: 'Sugar', variantTitle: '2kg', vatClass: 'Z' }])
    expect(message).toContain('"Sugar (2kg)"')
    expect(message).toContain('"Z"')
  })

  it.each([undefined, '', 'maize', '0013.12', '00131202', '0013.12.0X', '0013.12.020'])(
    'refuses a non-A line whose HS code is %j, naming the item',
    (hsCode) => {
      const message = findVatClassRefusal([{ ...exempt, hsCode }])
      expect(message).toContain('"Maize flour"')
      expect(message).toMatch(/HS code/)
    }
  )

  it('refuses a non-A line with no HS name, naming the item', () => {
    const message = findVatClassRefusal([{ ...exempt, hsName: ' ' }])
    expect(message).toContain('"Maize flour"')
    expect(message).toMatch(/HS name/)
  })

  it('names the first offending line, not a later one', () => {
    const message = findVatClassRefusal([{ ...exempt, title: 'First', hsCode: '' }, { ...exempt, title: 'Second', hsCode: '' }])
    expect(message).toContain('"First"')
    expect(message).not.toContain('"Second"')
  })
})
