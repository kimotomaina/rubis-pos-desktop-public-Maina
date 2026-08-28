# Phase 22 — Explicit Location Selection: Verification, No Change

**Date:** 2026-08-27 · **Branch:** `main` · **Previous:** [Phase 21](./phase-21.md)

## 1. Objective

A request came in describing a critical gap: "when the Shopify Store
URL and Admin API Token are already configured (e.g. via `.env`), the
admin is never asked to select a location — it's auto-detected in the
background." The brief asked for a new `src/main/services/configStore.ts`,
a `hasConfig()` check that fails without a `locationId`, an onboarding
"Location Selection" step, a `locations:fetch` IPC handler, and a
"Change Location" affordance in the Admin screen.

## 2. Finding: already fixed, undocumented

Tracing `App.tsx` → `main/index.ts` → `LocationConfirmScreen.tsx`
against the exact repro (store URL/token pre-set, no location env var,
login as the seeded default `Admin` account) showed the described bug
does not reproduce on this codebase as it stands. The fix — a
mandatory, PIN-gated, post-login location confirmation gate — was
already built, in the squashed `chore: cleanup` commit that also
carries Phases 16–20, but never got its own `docs/phase-N.md` (there
is a gap in the phase numbering between 18 and 20 where this most
likely belongs).

`LocationConfirmScreen.tsx`'s own doc comment names the bug directly:
it "replaces the old silent 'Phase 4' auto-detect that picked
whichever location Shopify returned first with no admin ever
reviewing it."

## 3. Current flow (for reference)

1. `config:get-status` → `configStatus`: `hasConfig = storeUrl && token`
   only — this gates `OnboardingScreen` (credential entry), not
   location. Deliberate: Phase 18 §2 already rejected a second
   persistence mechanism (`configStore.ts`) in favor of the existing
   `settings` table + `secretStore.ts` vault, to avoid two competing
   sources of truth for the same three values.
2. `LoginScreen` — always shown once credentials exist, regardless of
   how they were set (`.env` or the wizard).
3. Post-login, a second gate — `locationConfirmed`, from the
   `settings` table's `location_confirmed` flag, set only by an
   explicit save — blocks further access:
   - Admin → `LocationConfirmScreen`: fetches locations via
     `location:list` (`validateAndFetchLocations`, the same GraphQL
     shape the brief's `locations:fetch` describes), auto-selects a
     single result, requires a tap for multiple, and calls
     `location:set` — Manager-PIN-gated (`requireAdminPin`) — to
     persist and confirm.
   - Non-admin → `LocationPendingScreen`: fully blocked, "ask a
     manager," Log Out only.
4. `AdminScreen.tsx`'s Shopify Connection section already has "Change
   Location," clearing nothing destructively — it re-opens the same
   `LocationPicker` flow and re-saves via `location:set`.

This is strictly stronger than the brief's Task 3 design: doing
location selection inside `OnboardingScreen` would run *before* any
login, so anyone with physical till access could pick the location
unauthenticated. The existing post-login, PIN-gated placement was kept
rather than moved.

## 4. Deviation from the brief: no code changes

Implementing the brief literally — a new `configStore.ts`, a second
`hasConfig()`, a new `locations:fetch` IPC channel duplicating
`location:list` — would have built a parallel system next to one that
already does the same job and is already tested
(`configSaveSchema`/`locationSetSchema` in `tests/ipcValidator.test.ts`
already require a non-empty `locationId`). Per this project's
"preserve functionality" constraint and Phase 18's own precedent for
rejecting duplicate persistence, no source change was made this pass.

## 5. Verification

- `npm run typecheck` — clean (both `node` and `web` projects),
  unchanged.
- `npm test` — 463/463 passing, unchanged (no test needed updating
  since no behavior changed).
- Confirmed via code reading (not a live packaged run) that the exact
  reported scenario — pre-set `.env` credentials, fresh DB, login as
  the seeded default `Admin` account — reaches `LocationConfirmScreen`
  before any catalog/checkout UI renders.
