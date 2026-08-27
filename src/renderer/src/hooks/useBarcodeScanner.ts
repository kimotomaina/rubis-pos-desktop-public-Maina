/**
 * Barcode scanner hook with multi-scanner prefix routing.
 *
 * Datalogic (and most USB-HID) barcode scanners behave like a very
 * fast keyboard: they type out the barcode's characters and finish
 * with an Enter keypress. This hook listens on `window` — so it works
 * without a focused input field — and distinguishes a scan from
 * manual typing purely by keystroke timing: consecutive characters
 * arriving faster than `maxIntervalMs` apart are buffered together;
 * any gap larger than that resets the buffer, so a human typist's
 * naturally slower, irregular pace never accumulates enough
 * characters to be mistaken for a scan.
 *
 * A second guard suppresses an accidental duplicate: the exact same
 * `(source, barcode)` pair flushed again within
 * `DEFAULT_DUPLICATE_SUPPRESS_MS` of the last successful scan —
 * e.g. a cashier double-pulling the trigger — is silently dropped
 * instead of invoking `onScan` (and adding the item) twice.
 *
 * Multi-scanner routing works without any native HID module: the
 * Datalogic QD2100 (and similar USB-HID scanners) can be programmed,
 * by scanning a barcode out of its own manual, to prepend a fixed
 * text prefix to every scan it sends — e.g. `SC1:` for the till-1
 * station or `KITCHEN:` for a back-of-house unit. This hook simply
 * detects and strips a recognized prefix from the flushed buffer; an
 * unprogrammed scanner sends no prefix at all, so its scans keep
 * working exactly as before, just labeled `source: 'UNKNOWN'`.
 */

import { useEffect, useRef } from 'react'

/** Max milliseconds between characters for them to count as one scan. */
export const DEFAULT_SCAN_MAX_INTERVAL_MS = 50

/** Minimum buffered characters before Enter to treat input as a scan. */
export const DEFAULT_SCAN_MIN_LENGTH = 3

/**
 * Window (ms) within which the exact same `(source, barcode)` pair is
 * treated as an accidental duplicate — e.g. a double-pulled trigger or
 * a scanner that fires twice on one pass — and silently ignored rather
 * than invoked a second time.
 */
export const DEFAULT_DUPLICATE_SUPPRESS_MS = 1000

/**
 * Which programmed scanner station a scan came from.
 * `'UNKNOWN'` covers every scan with no recognized prefix — including
 * any unprogrammed scanner, so existing hardware needs no
 * reconfiguration to keep working.
 */
export type ScanSource = 'SC1' | 'SC2' | 'KITCHEN' | 'UNKNOWN'

/** One parsed scan: its source station and the barcode data with any prefix stripped. */
export interface ScanResult {
  source: ScanSource
  barcode: string
}

/**
 * Matches an optional `SC1:`/`SC2:`/`KITCHEN:` prefix (as programmed
 * into a Datalogic scanner) at the start of a flushed buffer, capturing
 * the remainder as the barcode. The prefix group is optional, and
 * `(.+)` requires at least one character, so an unprefixed buffer
 * matches with the whole string as the barcode — this pattern can
 * never fail to match a non-empty buffer.
 */
const SCAN_PREFIX_PATTERN = /^(SC1:|SC2:|KITCHEN:)?(.+)$/s

/** Maps a matched prefix literal (including its trailing colon) to a {@link ScanSource}. */
const PREFIX_SOURCES: Record<string, ScanSource> = {
  'SC1:': 'SC1',
  'SC2:': 'SC2',
  'KITCHEN:': 'KITCHEN'
}

/**
 * Parses a flushed scan buffer into its {@link ScanSource} and barcode,
 * stripping a recognized prefix when present.
 *
 * @param {string} raw — the full buffer flushed on Enter
 * @returns {ScanResult}
 */
function parseScan(raw: string): ScanResult {
  const match = SCAN_PREFIX_PATTERN.exec(raw)
  if (!match) return { source: 'UNKNOWN', barcode: raw }
  const [, prefix, barcode] = match
  return { source: prefix ? PREFIX_SOURCES[prefix] : 'UNKNOWN', barcode }
}

/** Tuning knobs for {@link useBarcodeScanner}. */
export interface UseBarcodeScannerOptions {
  /** Max ms between keystrokes to remain part of the same scan. */
  maxIntervalMs?: number
  /** Minimum barcode length (after stripping any prefix) to accept (rejects stray Enter presses). */
  minLength?: number
  /** Set false to detach the listener without unmounting the caller. */
  enabled?: boolean
}

/**
 * Listens for rapid, Enter-terminated keystroke sequences characteristic
 * of a barcode scanner and invokes `onScan` with the parsed
 * {@link ScanResult} — its source station and barcode.
 *
 * @param {(result: ScanResult) => void} onScan
 * @param {UseBarcodeScannerOptions} [options]
 */
export function useBarcodeScanner(
  onScan: (result: ScanResult) => void,
  options?: UseBarcodeScannerOptions
): void {
  const onScanRef = useRef(onScan)
  onScanRef.current = onScan

  const maxIntervalMs = options?.maxIntervalMs ?? DEFAULT_SCAN_MAX_INTERVAL_MS
  const minLength = options?.minLength ?? DEFAULT_SCAN_MIN_LENGTH
  const enabled = options?.enabled ?? true

  useEffect(() => {
    if (!enabled) return

    let buffer: string[] = []
    let lastTimestamp = 0
    let lastScanKey: string | null = null
    let lastScanTime = 0

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Enter') {
        const raw = buffer.join('')
        buffer = []
        if (!raw) return

        const result = parseScan(raw)
        if (result.barcode.length < minLength) return

        const now = Date.now()
        const scanKey = `${result.source}:${result.barcode}`
        if (scanKey === lastScanKey && now - lastScanTime < DEFAULT_DUPLICATE_SUPPRESS_MS) {
          return
        }

        lastScanKey = scanKey
        lastScanTime = now
        onScanRef.current(result)
        return
      }

      if (event.key.length !== 1) return

      const now = Date.now()
      if (buffer.length > 0 && now - lastTimestamp > maxIntervalMs) {
        buffer = []
      }
      buffer.push(event.key)
      lastTimestamp = now
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [enabled, maxIntervalMs, minLength])
}
