import { useCallback, useEffect, useState } from 'react'
import type { ShiftWindowStatus } from '../../../main/services/shift-window-status.js'

/**
 * The shift window status (docs/phase-231) for a screen, read from the main process and read again every
 * `refreshMs`, so a banner or a Close Shift button follows the clock without the screen holding a time rule of its
 * own. A failure, or a bridge without the call, reads as no status: the notes are a courtesy and never block a sale.
 *
 * @param {number} [refreshMs]
 * @returns {{ status: ShiftWindowStatus | null; reload: () => Promise<void> }}
 */
export function useShiftWindowStatus(refreshMs = 15_000): { status: ShiftWindowStatus | null; reload: () => Promise<void> } {
  const [status, setStatus] = useState<ShiftWindowStatus | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    try {
      const result = await window.api.getShiftWindowStatus?.()
      setStatus(result?.success && result.data ? result.data : null)
    } catch {
      setStatus(null)
    }
  }, [])

  useEffect(() => {
    void reload()
    const timer = setInterval(() => void reload(), refreshMs)
    return () => clearInterval(timer)
  }, [reload, refreshMs])

  return { status, reload }
}
