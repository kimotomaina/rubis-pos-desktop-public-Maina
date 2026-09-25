/**
 * Blurs `root`'s currently focused descendant, if any (phase-142 §11,
 * Phase E2(d)).
 *
 * Electron restores focus to the last-focused element across a renderer
 * reload. On the pre-login setup screens, focus opens the docked
 * on-screen keyboard (`onFocus` on each field), so a crash-restart could
 * otherwise land the operator on a setup screen with the keyboard already
 * open over a field nobody tapped. Called once, synchronously, from a
 * `useLayoutEffect` with an empty dependency array at mount — before the
 * operator has had any chance to interact — so it only ever undoes focus
 * the browser itself restored, never a real tap or Tab-focus afterward
 * (`setupScreens.test.ts` asserts that a field's own focus still opens
 * its key set).
 *
 * @param {HTMLElement | null} root
 * @returns {void}
 */
export function blurRestoredFocus(root: HTMLElement | null): void {
  const active = document.activeElement
  if (root && active instanceof HTMLElement && active !== root && root.contains(active)) {
    active.blur()
  }
}
