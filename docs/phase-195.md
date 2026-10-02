# Phase 195 — M-Pesa: no confirmation checkbox, Complete Sale active on a full code, payment-button logos

- **Date:** 2026-10-02
- **Requested:** Remove the checkbox "I have seen the M-Pesa confirmation message on the customer's phone." from the M-Pesa payment. Make Complete Sale active once the M-Pesa code is fully entered. Put the M-Pesa logo on the M-Pesa button and the Visa/Mastercard logo on the Card button. **Do not run check:fit.**
- **Outcome:** Implemented. Typecheck clean; full suite 158 files, 2489 tests passing (2485 before this phase, 4 net new). `check:fit` was **not run**, as instructed.
- **Branch / base commit:** staging @ 40c3e3a (version 2.1.3), tree clean at the start. Committed locally, not pushed, not built or deployed.

## 1. Audit

- The checkbox lives in one place: `renderManualEntryPanel` in [PaymentModal.tsx](../src/renderer/src/components/PaymentModal.tsx). That panel is the sole screen in `'manual'` mode and the "Unverified" tab in `'daraja'` mode, so removing it there removes it from both.
- It was backed by state (`acknowledged`, `unverifiedError`) and a guard in `handleUnverifiedContinue` that refused to complete without it.
- The main process still requires `confirmUnverified: true` on the checkout payload ([ipcValidator.ts:82](../src/main/lib/ipcValidator.ts#L82), [checkout.ts:459](../src/main/services/checkout.ts#L459)). The renderer already sent the literal `true`.
- The three payment toggles are in [PosCheckoutPanel.tsx](../src/renderer/src/components/PosCheckoutPanel.tsx): a `grid-cols-3` row of `h-12` buttons. Renderer images are imported from `src/renderer/src/assets/` (`logo-rubis.png`, `logo-etims.png`); `resources/logos/` is outside the renderer.
- Tests that touched the checkbox: `tests/paymentModal.test.ts` (the M-Pesa one). The checkbox in `posCheckoutPanelCard.test.ts` is the card panel's own attestation and is unchanged.
- `scripts/check-fit.mjs` finds the toggles by their text (`clickWhereText(..., 'button', 'M-PESA')`).

## 2. Changes

| File | Change |
| --- | --- |
| `PaymentModal.tsx` | Removed the checkbox, its label, the `acknowledged` and `unverifiedError` state and the error paragraph. Added `isManualCodeComplete` (`MANUAL_CODE_PATTERN`, 10 uppercase letters or digits). Complete Sale is `disabled` until it is true, with the same disabled styling the other sale buttons use. `handleUnverifiedContinue` returns early on an incomplete code and otherwise calls `onPaid(code, { code, confirmUnverified: true })`. Doc comments updated. |
| `PosCheckoutPanel.tsx` | M-PESA and CARD buttons now show their logo on a white chip, so it reads the same on the selected (rose) and unselected button. The name stays in the DOM as `sr-only` text, so screen readers, `check-fit.mjs` and the tests still find the button by text. CASH is unchanged. |
| `src/renderer/src/assets/logo-mpesa.png`, `logo-visa-mastercard.png` | New. Trimmed copies of the two supplied logos. See section 4. |
| `resources/logos/mpesa.jpg`, `visa-mastercard.png` | Your originals, committed untouched. |
| `tests/paymentModal.test.ts` | The "completes with no PIN" test no longer ticks a box. The "refuses without the attestation" test is replaced by: no checkbox or attestation text in manual mode and on the Unverified tab; Complete Sale is inactive on 0 to 9 characters, active at 10, inactive again at 9; no error text for a partial code. |
| `tests/posCheckoutPanelCard.test.ts` | New: the M-PESA and CARD buttons carry their logos and CASH has none. |

## 3. Impact

- **Direct:** the cashier types the 10-character code and taps Complete Sale; there is no tick box. Until the tenth character the button is greyed out and does nothing.
- **What the checkbox used to be:** the cashier's recorded attestation (phase 150 step 3) that they had seen the confirmation on the customer's phone. It is now implicit: pressing Complete Sale on a full code is the confirmation. The payment is still recorded as `manual_unverified` and still listed for the manager's end-of-day approval, so the audit trail is unchanged. What is gone is the explicit extra tap. The main process still demands `confirmUnverified: true`, which the renderer always sends; I did not loosen that server-side requirement, as it was not asked for.
- **Not changed:** the 10-character code pattern, the duplicate-code check, the manual-entry switch in Admin, the card panel and its checkbox, anything in checkout or the fiscal path.
- **Security posture:** unchanged server-side. The control that matters (a valid, unused 10-character code, manual entry enabled) is still enforced in `runCheckout`.
- **Idempotency / re-run safety:** UI-only.

## 4. The logos

- `mpesa.jpg` is 768 × 543 with the wordmark in the middle third. At the button's 28 px chip height it would have rendered about 7 px tall, so I trimmed the white margin (leaving a 6 px border) and saved a 360 × 100 PNG. `visa-mastercard.png` was trimmed of its transparent border and scaled to 245 × 220. Both were made with Pillow in the session scratchpad; nothing was added to the project's dependencies. The artwork is otherwise untouched.
- **I did not run check:fit, so the new buttons are not measured at the tightest window size (1366 × 768 at 150%).** At that size each toggle is roughly 95 px wide. The M-Pesa chip is capped at the button width (`max-w-full`) and shrinks with `object-contain` rather than overflowing, and the button height is still `h-12`. It is worth a glance on a real till.

## 5. Verification

- `npm run typecheck`: clean.
- `npx vitest run`: 158 files, 2489 tests passing.
- Mutation checks, each applied by hand, run red, reverted: the button never disabled (1 failed); the button never disabled and the handler guard removed (1 failed); a checkbox put back (2 failed); a 9-character code accepted (1 failed); M-Pesa logo removed (1 failed); card logo removed (1 failed).
- Not run: `check:fit` (instructed), a build, a deploy, anything against a device.

## 6. Rollback

`git revert` the phase 195 commit. No data, schema or config change.

## 7. Observed but not changed

1. The card panel ([CardEntryPanel.tsx](../src/renderer/src/components/CardEntryPanel.tsx)) still has its own "slip shows Approved" checkbox. You asked only about M-Pesa, so I left it.
2. `MPESA_MANUAL_NOT_ACKNOWLEDGED_MESSAGE` in `checkout.ts` and the `confirmUnverified` field remain, though nothing in the UI can now produce that refusal. Removing them is a main-process contract change, so it should be its own decision.
3. The Unverified tab's panel still says "This records a payment nobody has confirmed." That wording is unaffected, but you may want it revisited now that the tick box is gone.
