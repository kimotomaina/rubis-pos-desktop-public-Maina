/**
 * How long each toast kind stays up before auto-dismissing (phase-84).
 * Centralized so every producer's duration is a named, tested constant
 * rather than a magic number buried in a component.
 */

/** `ConnectivityToast` — unchanged from its pre-unification value. */
export const CONNECTIVITY_TOAST_TIMEOUT_MS = 5000

/** Barcode-scan / product-search feedback — unchanged from its pre-unification value. */
export const SCAN_TOAST_TIMEOUT_MS = 2500

/** The sale-complete confirmation toast. */
export const SALE_COMPLETE_TOAST_TIMEOUT_MS = 5000

/** The automatic end-of-sale print's "printer offline" notice (docs/phase-165). */
export const AUTO_PRINT_OFFLINE_TOAST_TIMEOUT_MS = 5000

/** The "cart restored after a restart" notice (docs/phase-197). */
export const CART_RESTORED_TOAST_TIMEOUT_MS = 8000

/** The notice that a manager-approved cart change was not made (docs/phase-197). */
export const CART_CHANGE_BLOCKED_TOAST_TIMEOUT_MS = 6000

/** The notice that a hold, resume, rename or discard of a held sale did not happen (docs/phase-217). */
export const HELD_SALE_NOTICE_TOAST_TIMEOUT_MS = 6000

/**
 * `UpdateToast`. Long on purpose (an available/downloaded update must
 * not be lost) and, per `toastStore.ts`'s `updatedAt` stamp, reset on
 * every new status event — a `download-progress` tick re-arms it, so it
 * can't disappear mid-download; it only starts counting down once
 * events go idle. The update itself is never actually lost either way:
 * `autoInstallOnAppQuit` defaults to `true` and is never overridden
 * (`src/main/services/updater.ts`), so a downloaded update installs on
 * the app's next normal restart whether or not this toast was ever
 * seen or clicked.
 */
export const UPDATE_TOAST_TIMEOUT_MS = 5 * 60 * 1000

/**
 * The fiscal outcome notice (`FiscalNotice.tsx`) never auto-dismisses.
 * The sale's `needs_fixing`/`waiting` status is already persisted on the
 * order row (phase-71/76) before the notice ever renders, so nothing is
 * lost if it's dismissed — but until Step 4's back-office list exists,
 * this toast is the ONLY place a flagged sale surfaces to a person, and
 * with the device password currently wrong every sale flags as
 * `waiting`. An auto-timeout here could let a flagged sale scroll away
 * unseen. Revisit once Step 4 lands.
 */
export const FISCAL_NOTICE_TIMEOUT_MS: number | null = null
