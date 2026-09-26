# Phase 155 — On-screen keyboard for every Admin field

- **Date:** 2026-09-26
- **Requested:** Per the phase-151 Part B audit, `AdminScreen.tsx` had ~20 plain typed `<input>` fields (Shopify, M-Pesa, fiscal device, store details, printer, staff) on a touch-only till. Convert each to the established pattern — a `readOnly` input opening the shared on-screen keyboard via `useKeyboardStore.getState().open({...})`, exactly as `PosCheckoutPanel`, `OnboardingScreen` and `EtimsSetupGate` already do — with no new keyboard component or store feature.
- **Outcome:** Implemented.
- **Branch / base commit:** staging @ 1bdae0a (Phase 154 — dead-code deletion).
- **Standing tripwires:** unmodified and passing — `VirtualKeyboard`/`VirtualNumpad`/`keyboardStore`/`keyboardEchoSubmit`/`setupScreens`/`virtualKeyboardLayouts`, `adminIntegrationsSections` (modified, see §3 — every *other* existing assertion in it still passes unchanged), the M-Pesa and fiscal suites, the Phase E layout tests (`screensFitDesignBox`, `belowLgUnreachable`, `headerLayout`, `posCheckoutPanelFit`).

## 1. The `.js` extension fix (prerequisite)

`AdminScreen.tsx` could not be mounted in `tests/**` before this phase — `tsconfig.node.json`'s NodeNext resolution requires a `.js` extension on every relative import it reaches, and several of `AdminScreen.tsx`'s own imports lacked one (fine for Vite's bundler resolution, which is why the app itself always worked). This is the same issue phase-146 fixed for `PosCheckoutPanel`, and phase-144 first documented for `AdminScreen.tsx` itself without fixing it.

Fixed in `AdminScreen.tsx` (12 imports) and in every transitive dependency it statically imports that had the same problem, since a single unresolved import anywhere in that fan-out would still break the mount:
- `src/renderer/src/pages/MpesaLogsPage.tsx` (`../lib/currency`)
- `src/renderer/src/components/ZReportModal.tsx` (`../lib/currency`, `./icons`)
- `src/renderer/src/components/EmptyState.tsx` (`./icons`)
- `src/renderer/src/components/RestartCountdownModal.tsx` (`../lib/restartCountdown`)

`LocationPicker.tsx`, `NeedsAttentionPage.tsx`, `StockTakePage.tsx` and `EndOfDayPage.tsx` were already fully `.js`-clean. No behavior changed by this alone — path-only edits, confirmed by the full suite before touching any field.

## 2. Field conversion

Every plain typed `<input>` in `AdminScreen.tsx` (22 fields — the phase-151 audit's "about 20" plus Starting/Ending Cash and the two staff-PIN fields, which the mode list below explicitly covers) became `readOnly`, with an `onClick` (and, for the three fields that had `autoFocus`, also an `onFocus`) opening the shared keyboard through a new small helper:

```ts
function openField(value, onChange, label, options?: { mode?, secret?, maxLength? }): void {
  useKeyboardStore.getState().open({ value, onChange, label, ...options })
}
```

Kept inline at each call site (matching `PosCheckoutPanel`'s own pattern), not a data-driven `FIELDS` table like `EtimsSetupGate`'s — that screen's four fields share one identical layout; `AdminScreen`'s 22 don't, and restructuring the surrounding JSX into a table was explicitly out of scope ("only the input method changes").

| Field | Mode | Secret |
| --- | --- | --- |
| Store URL | `text` | — |
| New Shopify Token | `text` | ✓ |
| Shortcode | `caps` | — |
| Consumer Key | `text` | — |
| Consumer Secret | `text` | ✓ |
| Passkey | `text` | ✓ |
| Callback URL | `text` | — |
| Where payment messages arrive (SMS) | `text` | — |
| Fiscal server address | `text` | — |
| Fiscal device IP address | `ip` | — |
| Fiscal device port | `numeric` | — |
| Fiscal device password | `text` | ✓ |
| Default tax class | `caps` | — |
| Store name | `text` | — |
| Store KRA PIN | `caps` | — |
| Printer id | `text` | — |
| Printer interface | `text` | — |
| Starting Cash | `numeric` | — |
| Ending Cash (counted) | `numeric` | — |
| Staff name | `text` | — |
| New staff PIN | `numeric` | ✓ |
| Reset PIN value | `numeric` | ✓ |

Notes on choices not explicit in the task's own mode list:
- **Consumer Key** → `text` (mixed-case API key; doesn't fit `caps`).
- **Fiscal device password** → `text`, not `numeric` (a general password, not digits-only).
- **Default tax class** → `caps` — a single-letter KRA code (A/B/C/D), the same "customer-facing code" spirit as Shortcode/Store KRA PIN.
- **Printer id / interface** → `text`, per the task's own "printer text (anything needing lower case or `:` `/` `.` `-`)".
- **Starting Cash / Ending Cash** → `numeric`, per the task's own "numeric: port, cash amounts, numeric settings" — not in the phase-151 audit's original list, but explicitly named in this task's own mode categories, so included.
- **New staff PIN / Reset PIN value** → neither had an existing numeric pad (unlike `ManagerPinModal`'s own PIN field, which uses `VirtualNumpad` and was correctly left alone in phase-151's audit as already-compliant), so both got `numeric` + `secret: true` per the task's explicit fallback instruction.

**Nothing else changed per field.** Every `onChange` transform was preserved exactly — most notably Store KRA PIN's `.toUpperCase()`, now applied inside the `openField` callback (`(next) => setStoreKraPin(next.toUpperCase())`) instead of inline in a native `onChange`. `type="number"` on the two cash fields became `type="text"` (a `readOnly` field has nothing to spin, and `min`/`step` are meaningless on a field nothing types into directly); every other field kept its original `type` (`text`/`password`), since the browser's own masking on `type="password"` and the keyboard overlay's `secret: true` masking are two independent things — the same layering `EtimsSetupGate` already relies on for its own device-password field.

**Left untouched, per the task:** the two search boxes (`PosSearchBar.tsx`, `ProductSearchBar.tsx` — barcode-scanner and live-filter reasons, unchanged from phase-151's own audit), the checkboxes and `<select>`s (Use Mock M-Pesa/eTIMS, Allow recording unverified payments, confirmation method, environment, printer type, staff role), and `ManagerPinModal.tsx`'s own PIN field (already compliant via `VirtualNumpad`).

## 3. Tests

### `tests/adminScreen.test.ts` (new) — real mount, 26 tests

- **Table-driven, per section:** every converted field is `readOnly` and opens the keyboard with the expected `mode`/`secret` (Shopify, M-Pesa Daraja, M-Pesa SMS, Fiscal Device + Store Details, Printer — each its own small `it.each` table, since each section needs its own navigation, not one table spanning heterogeneous setups).
- **Typing + Save, one field per section including a secret one:** Store URL → `setShopifyStoreUrl`; a new Shopify token (secret) → `setShopifyToken`; a new M-Pesa Consumer Secret (secret) → `setMpesaCredentials`; Store KRA PIN (confirming the `.toUpperCase()` transform survived) → `setStoreIdentity`; Ending Cash → `closeShift`; new staff name + PIN → `createStaff`.
- **The relay mutation check** (required by the task): every test above drives the keyboard with a single `onChange(fullString)` call, which — as verified — passes regardless of whether `keyboardStore.ts`'s relay keeps `request.value` in sync (that accumulation contract is `tests/keyboardStore.test.ts`'s own "BUG FIX" tripwire's job, not this file's). To make sure at least one of *this file's* tests is not vacuous with respect to real typing, one test types character-by-character on a live `AdminScreen` field (Store URL), reading `request.value` back between keystrokes exactly like the real `VirtualKeyboard` does. **Verified:** temporarily disabling the relay's `set(...)` line in `keyboardStore.ts` made this one test fail (`'http'` collapsed to `'p'` — each keystroke overwrote instead of accumulating) while every single-shot test in the file kept passing, then the line was restored and the full file went green again (`git diff` on `keyboardStore.ts` confirmed clean afterward).
- **`requestManagerPin` is stubbed to auto-approve** (`(title, onAuthorized) => onAuthorized(9, '9999')`) rather than driving a real `ManagerPinModal` — `AdminScreen` only ever forwards this prop to its parent (`App.tsx` owns the actual PIN gate), so this is a faithful stub, not a shortcut around anything `AdminScreen` itself is responsible for.

### `tests/adminIntegrationsSections.test.ts` — 4 tests replaced, 10 kept

The file's own doc comment (explaining *why* it read source text instead of mounting) was rewritten — the reason it gave is exactly what phase-155 fixed. Deliberate test change, recorded here per the task's instruction:

- **Old:** `'declares exactly the five named sections, in order, as a sub-nav'`, `'renders each section only when integrationSection matches it — none unconditionally'`, `'titles each section distinctly from the sub-nav label it lives under'`, and `'loads printers only once the Printer section is the one showing'` each read `AdminScreen.tsx` as a string and matched a regex or substring against its JSX/effect-dependency array.
- **New:** the same four behaviours, proved by mounting `AdminScreen` for real and clicking through its sub-nav — a mount confirms the section actually renders (and that `getPrinters` is actually called only once, not just that the source line exists), which a text match cannot.
- **Decision that required it:** this task's own instruction to replace phase-148's source-reading checks with real mount assertions "where they cover the same behaviour."

**The remaining 10 tests were left as source-reading, on purpose** — they check save-handler isolation (no shared handler between M-Pesa/Fiscal/Store Details, M-Pesa's validation not depending on fiscal fields, an honest restart prompt, the fiscal save never touching M-Pesa state, etc.), which are negative-space assertions ("this function body does not reference that variable"). Reading the function's own text proves that more directly than driving the UI and inferring absence from a spy's call arguments, and none of that code changed in this phase — converting them was not "the same behaviour" this phase's change touches, so they were left alone rather than rewritten for its own sake.

## 4. Affected files

| File | Change | Functionality affected |
| --- | --- | --- |
| `src/renderer/src/components/AdminScreen.tsx` | Modified | 22 fields converted to the keyboard pattern; `.js` extensions added; new `openField` helper |
| `src/renderer/src/pages/MpesaLogsPage.tsx` | Modified (import only) | No functional change |
| `src/renderer/src/components/ZReportModal.tsx` | Modified (import only) | No functional change |
| `src/renderer/src/components/EmptyState.tsx` | Modified (import only) | No functional change |
| `src/renderer/src/components/RestartCountdownModal.tsx` | Modified (import only) | No functional change |
| `tests/adminScreen.test.ts` | Added | Real-mount coverage of every converted field |
| `tests/adminIntegrationsSections.test.ts` | Modified | 4 tests converted to real mount; 10 left as source-reading; doc comment corrected |

## 5. Possible impact

- **Direct:** a manager configuring any Admin setting now uses the same on-screen keyboard already familiar from checkout and first-run setup, instead of the OS's own (often absent, on a kiosk till) software keyboard.
- **Indirect:** none — every field's own validation, save payload, and error handling are byte-for-byte the same code, just reached via `onClick`/`onFocus` instead of `onChange`. `handleSaveMpesaConfig`/`handleSaveFiscalConfig`/`handleSaveStoreIdentity`/etc. were not touched.
- **Data / schema / contract:** none.
- **Security posture:** unchanged — a secret field's on-screen echo is now masked by `secret: true` in addition to the field's own `type="password"` masking; nothing is logged or stored differently.
- **Idempotency / re-run safety:** n/a — no state-changing logic changed, only how a human enters a value into it.
- **Residual risk:** printer id/interface fields (and any field reached only via a placeholder, not a `<label>`) are exercised in tests via their `placeholder` attribute rather than `inputByLabel`, since they have no associated `<label>` element — a low-risk convenience already established by `PosCheckoutPanel`'s own aria-label-based fields elsewhere.

## 6. Verification

- `npm run typecheck` — clean throughout (checked after the `.js` fixes alone, then after each group of field conversions).
- `npx vitest run tests/adminScreen.test.ts` — **26/26 passed**.
- `npx vitest run tests/adminIntegrationsSections.test.ts` — **14/14 passed** (4 rewritten, 10 unchanged, 2 Peripherals tests unchanged).
- Full suite: `npx vitest run` — **111 test files, 1710 tests passed**, zero failures (up from phase-154's 110/1684: +1 file, +26 tests).
- `npm run build` — succeeds.
- The relay mutation check (§3) performed and reverted; `git diff` on `keyboardStore.ts` confirmed clean before committing.
- `git status --short` confirmed exactly the 7 files in §4 were touched.

## 7. Rollback

`git revert` of this commit restores every field's plain `onChange`, the dropped `type="number"`/`inputMode="numeric"` attributes on the two cash fields, and the pre-phase-155 `.js`-missing imports (reintroducing the mount-blocking issue phase-146/144 already knew about, but harmless — nothing outside this commit depends on `AdminScreen` being mountable).

## 8. What only a human can check

- Editing one field in each Admin section with the on-screen keyboard and saving, on the actual touchscreen till — the task's own suggested check.
- Secrets (Shopify token, M-Pesa Consumer Secret/Passkey, fiscal device password, staff PINs) showing as dots in both the field itself and the keyboard's own echo, on real hardware.

---

**STOP.**
