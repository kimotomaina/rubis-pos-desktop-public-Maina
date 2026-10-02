/** The longest slug a tag carries (docs/phase-210, the owner's rule). */
export const LOCATION_SLUG_MAX_LENGTH = 40

/**
 * Turns a Shopify location name into the readable part of the order tag
 * (docs/phase-210): lowercased, spaces to hyphens, anything outside
 * `[a-z0-9-]` removed, runs of hyphens collapsed, at most 40 characters.
 *
 * @param {string} name e.g. `Rubis Kisumu`
 * @returns {string} e.g. `rubis-kisumu`; empty when nothing usable remains
 */
export function locationSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, LOCATION_SLUG_MAX_LENGTH)
}

/**
 * The tag every pushed order carries so the Shopify order list filters by shop.
 *
 * @param {string} name
 * @returns {string | null} `location:<slug>`, or `null` when the name leaves no slug
 */
export function locationTag(name: string): string | null {
  const slug = locationSlug(name)
  return slug ? `location:${slug}` : null
}
