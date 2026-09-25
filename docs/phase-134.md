# Phase 134 — The till names itself "Enjoy" instead of "RUBIS Energie"

- **Date:** 2026-09-25
- **Requested:** Change the till's name from "RUBIS Energie" to "Enjoy".
- **Outcome:** Implemented
- **Branch / base commit:** staging @ 6e2f3d1
- **Previous:** [phase-133](./phase-133.md)

## 1. Audit — every occurrence of "RUBIS Energie"

A case-insensitive search of `src/`, `tests/`, `scripts/`, `resources/`,
`build/`, and the config files found **exactly five**. All five are the
logo's `alt` text:

| File | Screen |
| --- | --- |
| [App.tsx:373](../src/renderer/src/App.tsx#L373) | main header |
| [LoginScreen.tsx:86](../src/renderer/src/components/LoginScreen.tsx#L86) | login |
| [OnboardingScreen.tsx:91](../src/renderer/src/components/OnboardingScreen.tsx#L91) | first-run onboarding |
| [LocationPendingScreen.tsx:16](../src/renderer/src/components/LocationPendingScreen.tsx#L16) | location pending |
| [LocationConfirmScreen.tsx:100](../src/renderer/src/components/LocationConfirmScreen.tsx#L100) | location confirm |

The logo image itself was already changed in phase-133. No test asserts on
this text.

## 2. Changes made

`alt="RUBIS Energie"` became `alt="Enjoy"` in the five files above, one line
each. Nothing else changed.

## 3. Affected files and functionality

| File | Change | Functionality affected |
| --- | --- | --- |
| the five renderer files above | Modified (1 line each) | the logo's accessible name and its fallback text if the image fails to load |

## 4. Possible impact

- **Direct:** screen readers, and the broken-image fallback, now say "Enjoy".
- **Data / schema / contract / receipts / KRA filing:** none.

## 5. Verification

```
npm run typecheck → clean
npm test          → 90 files, 1391 tests, all passing
```

## 6. Rollback

Run `git revert` on this commit.

## 7. Observed but not changed

These are other "RUBIS" names. None of them is "RUBIS Energie", so they are
outside this request:

- **The receipt header store name**
  ([index.ts:510](../src/main/index.ts#L510)): Admin → store identity sets
  it, then `VITE_STORE_NAME`, then the default `'RUBIS'`. It prints on every
  receipt next to the KRA PIN, so it should be changed on each till in Admin
  rather than hardcoded.
- **The window title** "RUBIS POS"
  ([index.html:9](../src/renderer/index.html#L9)), the electron-builder
  product name and installer name "RUBIS POS", and the test-print header
  `'RUBIS POS'` ([printer.ts:611](../src/main/services/printer.ts#L611)).
- **The logo import variable** is named `rubisLogo`, and the asset file is
  `logo-rubis.png`. Both are internal names and nobody sees them.
- **The window, taskbar, and installer icon** is still the old one (phase-133
  §7).
