/**
 * Plain-language display for the Rule-3 safety-net count (phase-95) —
 * kept pure and framework-free, tested directly, matching how
 * `fiscalNotice.ts`/`needsAttention.ts` are tested independently of the
 * components that render them.
 */

/** How the unfiled sales badge should read and look at a given count. */
export interface UnfiledCountDisplay {
  label: string
  /** `'quiet'` at zero — nothing needs attention; `'alert'` otherwise. */
  tone: 'quiet' | 'alert'
}

/**
 * @param {number} count
 * @returns {UnfiledCountDisplay}
 */
export function describeUnfiledCount(count: number): UnfiledCountDisplay {
  if (count <= 0) {
    return { label: 'All sales filed', tone: 'quiet' }
  }
  return {
    label: count === 1 ? '1 sale not filed' : `${count} sales not filed`,
    tone: 'alert'
  }
}
