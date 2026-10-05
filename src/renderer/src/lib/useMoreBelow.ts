import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

/**
 * Whether a scroll region has content below the part showing. A pixel of
 * rounding slack keeps a region scrolled fully down from reading as "more".
 *
 * @param {Pick<HTMLElement, 'scrollTop' | 'clientHeight' | 'scrollHeight'>} region
 * @returns {boolean}
 */
export function hasMoreBelow(region: Pick<HTMLElement, 'scrollTop' | 'clientHeight' | 'scrollHeight'>): boolean {
  return region.scrollHeight - region.scrollTop - region.clientHeight > 1
}

/**
 * Tracks whether the scroll region it is attached to has more below, so a
 * fade can say so (docs/phase-220). Re-measured after every render, on
 * scroll, and when the window is resized.
 *
 * @returns {{ ref: RefObject<T | null>, moreBelow: boolean, onScroll: () => void }}
 */
export function useMoreBelow<T extends HTMLElement>(): {
  ref: RefObject<T | null>
  moreBelow: boolean
  onScroll: () => void
} {
  const ref = useRef<T>(null)
  const [moreBelow, setMoreBelow] = useState(false)

  const measure = useCallback((): void => {
    setMoreBelow(ref.current ? hasMoreBelow(ref.current) : false)
  }, [])

  useEffect(measure)

  useEffect(() => {
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [measure])

  return { ref, moreBelow, onScroll: measure }
}
