/**
 * Shared connectivity types — split out of the old `ConnectivityBadges`
 * component (removed once `NavStatusButton` consolidated the header's
 * status indicators into one button/dialog) so `ConnectivityModal`,
 * `ConnectivityToast`, `connectivityStore` and `NavStatusButton` keep a
 * single source for these shapes without depending on a UI component
 * file for its types.
 */

/** Result of one reachability probe, mirroring `ConnectivityCheckPayload` in the preload layer. */
export interface ConnectivityCheckPayload {
  connected: boolean
  lastCheckedAt: string
  latencyMs?: number
  error?: string
}

/** Mirrors `ConnectivityStatusPayload` in the preload layer. */
export interface ConnectivityStatusPayload {
  mpesa: ConnectivityCheckPayload
  fiscal: ConnectivityCheckPayload
  printer: ConnectivityCheckPayload
}

/** Which integration a badge/modal refers to. */
export type ConnectivityIntegration = 'mpesa' | 'fiscal' | 'printer' | 'barcode'

/** Barcode scanner state — there is no way to detect a keyboard-wedge scanner passively, only via a manual test. */
export type BarcodeStatus = 'unknown' | 'connected'
