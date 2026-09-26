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
