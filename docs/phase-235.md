# Phase 235 — M-Pesa: Manual verification is the tab that opens first

- **Date:** 2026-10-06
- **Asked by the owner:** on the cart page, when the cashier chooses M-Pesa, Manual verification should be the default selection.
- **Status:** built and tested. Not released. The app was not started; nothing sent to Safaricom, the device or Shopify.
- **Layout: not checked by check:fit (owner's rule). For the owner to check on the till.** The screen is the same two tabs and the same two panels; only which one shows first changes.
- **Numbering:** [phase 232](phase-232.md)'s note says its Z layout "is now phase 233 and the device block phase 234", but `docs/phase-233.md` was already committed (`915a9f3`, the KRA-class audit) when that note was written. 234 is left for the other session; this is 235. The owner may want to rule on 233 vs 234 for the Z layout.
- **Not changed:** the manual-mode screen (one panel, no tabs), Daraja mode without the manual fallback (STK only, no tabs), the SMS notice, the loading and unavailable notices, the STK Push flow and its polling, the manual-code rules (10-character code, no PIN, no tick box, Complete Sale active only on a full code), the payment-in-progress signal for Hold, the main-process gate that decides whether a manual code is accepted.

## 1. Audit (read-only, first)

The M-Pesa panel is [PaymentModal.tsx](../src/renderer/src/components/PaymentModal.tsx), shown by `PosCheckoutPanel` once M-Pesa is chosen. What it shows depends on the till's M-Pesa capabilities (`getMpesaCapabilities`, main process `mpesa-provider-factory.ts`):

| Mode | Fallback (`manualEntryEnabled`) | Screen before this phase |
| --- | --- | --- |
| `manual` | always true | one panel, "Record M-Pesa payment", no tabs |
| `daraja` | false | the STK form only, no tabs |
| `daraja` | true | two tabs, **STK Push selected first**, Manual verification beside it |
| `sms` | — | "not available" notice |

The only state involved was `const [tab, setTab] = useState<PaymentTab>('stk')`. The two panels rendered on `tab === 'stk'` and `tab === 'unverified' && manualEntryEnabled`. So the owner's request touches exactly the `daraja` + fallback row: the pilot tills are in that configuration, which is why the owner sees two tabs.

**Edge to respect:** in `daraja` mode *without* the fallback there is no tab bar, and the STK form rendered only because the state started at `'stk'`. Changing the initial state alone would leave that screen blank. Two existing tests pin it (`keyboardCloseControl.test.ts` "leaves an M-Pesa payment waiting", `heldSalesUi.test.ts` "is set while a Daraja push is waiting").

**Tests that mount or scan this component:** `paymentModal`, `keyboardCloseControl`, `heldSalesUi`, `manualVerificationWording` (scans the file's wording), `noUnexpectedScroll`, `checkout`, `mpesaPaymentGate`. Baseline before the change: all passing.

## 2. Change

[PaymentModal.tsx](../src/renderer/src/components/PaymentModal.tsx), 18 lines:

- `useState<PaymentTab>('unverified')`: Manual verification is the tab selected when the panel opens.
- `const activeTab: PaymentTab = manualEntryEnabled ? tab : 'stk'`, derived right after the capabilities are known. **Every render decision reads `activeTab`**, never `tab`: the two tab buttons' styling, the STK form, the manual panel. Without the fallback there is no tab bar and the STK form shows exactly as before. The manual panel's own `&& manualEntryEnabled` guard became redundant and was removed (the derivation is the guard).
- The component's doc comment says the Manual verification tab is the one selected on opening and that STK Push is a tap away.

Nothing else: no new component, no new store, no new setting. The default lives in one line and the "no tab bar" rule in one line.

## 3. Tests

`tests/paymentModal.test.ts`, one new case in "renders by mode": in `daraja` mode with the fallback, on mount the M-Pesa code field is present and "Phone Number" is not; the Manual verification tab carries the selected style (`bg-amber-100`) and STK Push does not (`bg-white`); tapping STK Push shows "Phone Number" and hides the code field; tapping Manual verification brings the code field back.

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npx vitest run` on the 7 files above | **7 files, 163 passed, 1 skipped** (the skip is pre-existing in `manualVerificationWording`) |
| Mutation: initial state back to `'stk'`, file restored after | exactly the new test fails (`×` "Manual verification is the tab selected on opening"); the other 15 in the file pass |
| Full suite | not run; the change is one component and the seven files are every consumer |

## 4. Possible impact

- **Cashier:** choosing M-Pesa lands on the amber "Checked by the cashier, not by Safaricom" panel with the code field. STK Push is one tap away, unchanged.
- **Tills in `manual` mode:** no change (there were never tabs).
- **Tills in `daraja` mode without the fallback:** no change (STK only), covered by the two tests named in §1.
- **Hold:** the payment-in-progress signal is unchanged; a typed code still blocks Hold as before.
- **Risk the owner accepted by asking for this:** the manual route completes a sale nobody at Safaricom has confirmed (phase 150), and it is now the first thing shown. The amber styling, the wording and the End-of-Day manager approval are unchanged.

## 5. Rollback

`git revert` the commit. One file of code, one of tests; no data, no setting, no schema.

## 6. Observed but not changed

- `tsconfig.node.tsbuildinfo` and `tsconfig.web.tsbuildinfo` are modified in the working tree by the typecheck itself (they were already modified before this phase). Not committed here.
- The tab's internal value is still `'unverified'` (a data value, not shown; `manualVerificationWording.test.ts` allows exactly that one).
