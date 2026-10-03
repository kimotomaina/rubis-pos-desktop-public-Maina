/** A Shopify location a sale belongs to. */
export interface TillLocation {
  id: string
  name: string
}

/** Shown when a sale is attempted on a till with no confirmed Shopify location (docs/phase-210). */
export const NO_LOCATION_MESSAGE =
  'This till has no shop location set, so the sale cannot be recorded. Set the location in Admin and try again.'

/** A Shopify location id, the only form the trader number (docs/phase-211) and `fulfillment.locationId` accept. */
const LOCATION_GID = /^gid:\/\/shopify\/Location\/\d+$/

/**
 * The location a sale is recorded against, or `null` when the till has none.
 * Unset means undefined or empty for the id and for the name: the settings
 * reset writes empty strings, and an env override gives an id before its
 * name has been fetched. An id that is not a Shopify location id counts as
 * unset, so the sale is refused up front instead of failing in the number builder.
 *
 * @param {string | undefined} id
 * @param {string | undefined} name
 * @returns {TillLocation | null}
 */
export function resolveCheckoutLocation(id: string | undefined, name: string | undefined): TillLocation | null {
  const trimmedId = id?.trim()
  const trimmedName = name?.trim()
  return trimmedId && LOCATION_GID.test(trimmedId) && trimmedName ? { id: trimmedId, name: trimmedName } : null
}
