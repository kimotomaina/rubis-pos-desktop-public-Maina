/**
 * Trader system invoice number formatting, for reporting only.
 *
 * docs/phase-158's brief asked for the CSV export and invoice list to
 * use "the SAME function as real-etims-provider.ts:1408-1420; import it,
 * do not re-implement it" — but that function
 * (`RealFiscalizationProvider.buildTraderSystemInvNum`) is a *private*
 * class method on the fiscal provider, and this phase's own hard rule
 * forbids changing `real-etims-provider.ts` at all (fiscal code is out
 * of scope here). Exporting the method would mean editing that file,
 * which the hard rule takes precedence over. This is therefore a
 * deliberate, byte-for-byte duplicate of that method's logic — not the
 * literal same function — with `tests/traderSystemInvoiceNumber.test.ts`
 * asserting the two produce identical output for a range of inputs, so
 * any future drift between them is caught immediately rather than
 * silently. See docs/phase-158.md for the full reasoning.
 */

import { MAX_TRADER_SYSTEM_INV_NUM_LENGTH } from '../services/integrations/real-etims-provider.js'

export { MAX_TRADER_SYSTEM_INV_NUM_LENGTH }

/**
 * Builds the `TraderSystemInvNum` a fiscalised order was filed under —
 * for display/export only, never sent to a device from here. Mirrors
 * `RealFiscalizationProvider.buildTraderSystemInvNum` exactly: prefers a
 * zero-padded `INV-<localId>`, falling back to a dash-stripped
 * `clientOrderUuid` when no local order id is available.
 *
 * @param {number | undefined} localId
 * @param {string} clientOrderUuid
 * @returns {string}
 */
export function buildTraderSystemInvNum(
  localId: number | undefined,
  clientOrderUuid: string
): string {
  const raw =
    typeof localId === 'number'
      ? `INV-${String(localId).padStart(9, '0')}`
      : clientOrderUuid.replace(/-/g, '')
  return raw.slice(0, MAX_TRADER_SYSTEM_INV_NUM_LENGTH)
}

/** Origin of the sequence (docs/phase-211): 2026-01-01T00:00:00Z. */
export const TRADER_SEQ_EPOCH_MS = Date.UTC(2026, 0, 1)

/** Width of the sequence in base 36; 36^6 seconds is about 69 years. */
export const TRADER_SEQ_LENGTH = 6

/** First character of every number built from a location; a legacy `INV-` number can never equal one. */
export const TRADER_NUMBER_PREFIX = 'L'

/**
 * The location's numeric Shopify id as an uppercase base 36 string: 7 characters
 * today, 8 once ids pass 36^7 (78,364,164,096).
 *
 * @param {string} locationId e.g. `gid://shopify/Location/77557989479`
 * @returns {string} e.g. `ZMO0VON`
 * @throws {Error} when the id is not a Shopify location id
 */
export function locationCode(locationId: string): string {
  const match = /^gid:\/\/shopify\/Location\/(\d+)$/.exec(locationId)
  if (!match) throw new Error(`Cannot build a trader number: "${locationId}" is not a Shopify location id`)
  return BigInt(match[1]).toString(36).toUpperCase()
}

/**
 * The next sequence value: whole seconds since {@link TRADER_SEQ_EPOCH_MS}, but never
 * less than `last + 1`. A negative clock reading counts as 0. This is a uniqueness
 * device, not a fiscal rule: it needs no configuration, a reinstalled till continues
 * from the clock instead of from 1, a clock set back cannot repeat a number, and two
 * sales in one second get consecutive values.
 *
 * @param {number} nowMs
 * @param {number} last the last value used on this till, 0 if none
 * @returns {number}
 */
export function nextTraderSeq(nowMs: number, last: number): number {
  const clock = Math.max(0, Math.floor((nowMs - TRADER_SEQ_EPOCH_MS) / 1000))
  return clock > last ? clock : last + 1
}

/**
 * Builds the trader system invoice number for a new sale (docs/phase-211):
 * `L` + the location id in base 36 + a 6-character base 36 sequence, 14 or 15
 * characters. It never truncates: a result over the device's 15-character limit
 * throws, because two numbers cut to the same prefix would collide.
 *
 * @param {string} locationId
 * @param {number} seq from {@link nextTraderSeq}
 * @returns {string} e.g. `LZMO0VON0E59C0`
 * @throws {Error} on a bad location id, a sequence that does not fit, or a number over 15 characters
 */
export function buildLocationTraderInvNum(locationId: string, seq: number): string {
  const seqText = Number.isSafeInteger(seq) && seq >= 0 ? seq.toString(36).toUpperCase().padStart(TRADER_SEQ_LENGTH, '0') : ''
  if (!seqText || seqText.length > TRADER_SEQ_LENGTH) {
    throw new Error(`Cannot build a trader number: sequence ${seq} does not fit ${TRADER_SEQ_LENGTH} characters`)
  }
  const value = `${TRADER_NUMBER_PREFIX}${locationCode(locationId)}${seqText}`
  if (value.length > MAX_TRADER_SYSTEM_INV_NUM_LENGTH) {
    throw new Error(`Cannot build a trader number: "${value}" is longer than ${MAX_TRADER_SYSTEM_INV_NUM_LENGTH} characters`)
  }
  return value
}

/**
 * The number a sale was (or will be) filed under for display and export: the stored
 * one, or the legacy `INV-<local_id>` form only for a sale that has none.
 *
 * @param {string | null | undefined} stored `orders.fiscal_trader_inv_num`
 * @param {number | undefined} localId
 * @param {string} clientOrderUuid
 * @returns {string}
 */
export function resolveTraderSystemInvNum(
  stored: string | null | undefined,
  localId: number | undefined,
  clientOrderUuid: string
): string {
  return stored || buildTraderSystemInvNum(localId, clientOrderUuid)
}
