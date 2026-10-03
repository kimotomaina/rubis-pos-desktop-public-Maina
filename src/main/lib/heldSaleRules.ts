/**
 * The limit on held sales (docs/phase-217), enforced in the main process.
 *
 * The renderer keeps its own copy beside the ageing thresholds in
 * `src/renderer/src/lib/heldSale.ts` (the renderer cannot import values from
 * `main/`); `tests/heldSales.test.ts` fails if the two differ. Changing the
 * limit is the owner's decision: change both.
 */

/** Most sales one till may hold at once; a fourth hold is refused. */
export const MAX_HELD_SALES = 3

/** Longest label a held sale may carry. */
export const MAX_HELD_LABEL_LENGTH = 40
