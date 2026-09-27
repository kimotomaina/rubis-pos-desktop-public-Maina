/**
 * `check:fit`'s renderer force-show hook (docs/phase-166 Commit E3,
 * extended docs/phase-167 Part B item 1) — a pure resolver, split out
 * of `main/index.ts`'s `checkFit:getForcedScreen` handler so it can be
 * unit tested directly (`main/index.ts` itself imports Electron at
 * module load time and is not importable in a test run, the same
 * constraint every other IPC handler in this codebase has).
 */

/**
 * Resolves `RUBIS_CHECK_FIT_SCREEN` to the screen id `check:fit` wants
 * force-shown, or `null` when unset — always `null` on every real
 * launch, since no real launch ever sets this variable (mirrors
 * `RUBIS_CHECK_FIT_SIZE`'s own `parseCheckFitSize`).
 *
 * @param {string | undefined} raw
 * @returns {string | null}
 */
export function resolveCheckFitForcedScreen(raw: string | undefined): string | null {
  return raw ?? null
}
