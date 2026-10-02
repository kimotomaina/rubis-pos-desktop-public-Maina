/**
 * docs/phase-210: the order tag's slug, and the location a sale is allowed to carry.
 */

import { describe, it, expect } from 'vitest'
import { locationSlug, locationTag, LOCATION_SLUG_MAX_LENGTH } from '../src/main/lib/locationSlug.js'
import { resolveCheckoutLocation } from '../src/main/lib/checkoutLocation.js'

describe('locationSlug', () => {
  it.each([
    ['Rubis Kisumu', 'rubis-kisumu'],
    ['Enjoy Haile Selassie', 'enjoy-haile-selassie'],
    ['  HQ  ', 'hq'],
    ['Rubis   Enjoy   Karen', 'rubis-enjoy-karen'],
    ["Rubis (Kitengela) & Co.", 'rubis-kitengela-co'],
    ['Rubis -- Kisumu', 'rubis-kisumu'],
    ['###', '']
  ])('%j becomes %j', (name, slug) => {
    expect(locationSlug(name)).toBe(slug)
  })

  it('is at most 40 characters', () => {
    const slug = locationSlug('a'.repeat(80))

    expect(slug).toHaveLength(LOCATION_SLUG_MAX_LENGTH)
  })
})

describe('locationTag', () => {
  it('is location:<slug>', () => {
    expect(locationTag('Rubis Kisumu')).toBe('location:rubis-kisumu')
  })

  it('is null, never an empty tag, when the name leaves no slug', () => {
    expect(locationTag('###')).toBeNull()
    expect(locationTag('')).toBeNull()
  })
})

describe('resolveCheckoutLocation', () => {
  it('returns the id and name when both are set', () => {
    expect(resolveCheckoutLocation('gid://shopify/Location/1', 'Rubis Kisumu')).toEqual({
      id: 'gid://shopify/Location/1',
      name: 'Rubis Kisumu'
    })
  })

  it.each([
    [undefined, 'Rubis Kisumu'],
    ['gid://shopify/Location/1', undefined],
    ['', 'Rubis Kisumu'],
    ['gid://shopify/Location/1', ''],
    ['   ', '   ']
  ])('is null for id %j and name %j (the settings reset writes empty strings)', (id, name) => {
    expect(resolveCheckoutLocation(id, name)).toBeNull()
  })
})
