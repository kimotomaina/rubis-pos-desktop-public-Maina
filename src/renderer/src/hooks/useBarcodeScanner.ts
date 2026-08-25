/**
 * Barcode scanner hook (Phase 5 — Hardware Integration).
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
 * A second guard (Phase 5.2 hardening) suppresses an accidental
 * duplicate: the exact same barcode flushed again within
 * `DEFAULT_DUPLICATE_SUPPRESS_MS` of the last successful scan — e.g. a
 * cashier double-pulling the trigger — is silently dropped instead of
 * invoking `onScan` (and adding the item) twice.
 */

import { useEffect, useRef } from 'react'

/** Max milliseconds between characters for them to count as one scan. */
export const DEFAULT_SCAN_MAX_INTERVAL_MS = 50

/** Minimum buffered characters before Enter to treat input as a scan. */
export const DEFAULT_SCAN_MIN_LENGTH = 3

/**
 * Window (ms) within which the exact same barcode is treated as an
 * accidental duplicate — e.g. a double-pulled trigger or a scanner
 * that fires twice on one pass — and silently ignored rather than
 * invoked a second time.
 */
export const DEFAULT_DUPLICATE_SUPPRESS_MS = 1000

/** Tuning knobs for {@link useBarcodeScanner}. */
export interface UseBarcodeScannerOptions {
  /** Max ms between keystrokes to remain part of the same scan. */
  maxIntervalMs?: number
  /** Minimum barcode length to accept (rejects stray Enter presses). */
  minLength?: number
  /** Set false to detach the listener without unmounting the caller. */
  enabled?: boolean
}

/**
 * Listens for rapid, Enter-terminated keystroke sequences characteristic
 * of a barcode scanner and invokes `onScan` with the assembled code.
 *
 * @param {(barcode: string) => void} onScan
 * @param {UseBarcodeScannerOptions} [options]
 */
export function useBarcodeScanner(
  onScan: (barcode: string) => void,
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
    let lastScanCode: string | null = null
    let lastScanTime = 0

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Enter') {
        const barcode = buffer.join('')
        buffer = []
        if (barcode.length < minLength) return

        const now = Date.now()
        if (
          barcode === lastScanCode &&
          now - lastScanTime < DEFAULT_DUPLICATE_SUPPRESS_MS
        ) {
          return
        }

        lastScanCode = barcode
        lastScanTime = now
        onScanRef.current(barcode)
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
