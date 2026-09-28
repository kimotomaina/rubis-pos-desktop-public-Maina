# Phase 172 — Shorten or remove explanation text on the Admin screens

- **Date:** 2026-09-28
- **Requested:** A text-only pass over the Admin screens (and everything opened from them): remove every explanatory paragraph/helper line/note, or cut it to one short sentence, keeping a sentence only when it tells the person something they cannot see from the screen and that matters (money, tax, stock, or an irreversible action).
- **Outcome:** Implemented. Report committed alongside the code.
- **Branch / base commit:** staging @ 6e1ec82 (docs/phase-171)

**Hard rule kept:** no logic, layout, keyboard, IPC or data change. Every edit below is a JSX text/paragraph change only. Field labels, headings, card titles, button text, column headers, status values, badge counts, error/validation messages, the Shopify check finding lines, and fiscal/payment wording outside the Admin screens were left untouched — confirmed by the "changed existing assertions" search in §4 (none needed changing) and by `check-fit.mjs`'s own exact-text button clicks still matching (headings/card titles/"Back to..." labels are unchanged).

## 1. Every explanatory text node found in scope, and what happened to it

| File:line | Before | After | Reason kept |
| --- | --- | --- | --- |
| `AdminScreen.tsx:1076-1079` (System > Startup Configuration) | "Selects which providers this till talks to. Both are constructed once at startup, so a change here only takes effect after a restart." | "Changes apply only after a restart." | Restart requirement isn't visible from the two checkboxes, and one of them (mock eTIMS) decides whether real tax filings happen |
| `AdminScreen.tsx:1130-1135` (System > Reset Configuration) | "Clears this till's saved Shopify store URL, Admin API token, and confirmed location, then returns it to first-run setup. Use this to point the till at a different store — there is no undo. To just switch locations on the same store, use \"Change Location\" above instead." | "Clears this till's Shopify connection and location, with no undo." | Irreversible action — kept what gets committed and that there's no undo, dropped the redundant pointer to the other button |
| `AdminScreen.tsx:1156-1178` (Peripherals > Barcode Scanner Stations) | 3-step numbered list (find the "Add Prefix" barcode in the programming guide; scan it then SC1:/SC2:/KITCHEN: then Save; scans arrive prefixed automatically) plus a closing note about an unprogrammed scanner | One line: "Scan Add Prefix, then `SC1:` (till 1), `SC2:` (till 2) or `KITCHEN:`, then Save." | See §5 — flagged as a judgement call, not a strict money/tax/stock/undo case, but the only place this prefix scheme is documented at all |
| `AdminScreen.tsx:1208-1211` (Shopify Connection) | "Shopify store URL and Admin API token. These credentials are stored securely on this device and only need to be entered once per till." | removed | Heading + field labels already say what the two fields are |
| `AdminScreen.tsx:1237-1240` (Admin API Token) | "Stored securely on this device. For your protection, once saved the token cannot be viewed again here — only whether one is currently configured." | removed | The Status line right below already shows Configured/Not configured; matches this section's own established precedent (see the kept comment at what is now `AdminScreen.tsx:1582`) of removing static field descriptions |
| `AdminScreen.tsx:1284-1286` (Location) | "The Shopify location this till scopes inventory and sales to." | "The Shopify location this till's stock and sales use." | Changing this scopes which stock/sales figures the till sees — not obvious from the heading alone |
| `AdminScreen.tsx:1333` (M-Pesa) | "How this till takes M-Pesa payments." | removed | Heading "M-Pesa" plus the selector's own option text already say this |
| `AdminScreen.tsx:1366-1370` (M-Pesa mode selector) | "Manual is the default: the cashier checks the confirmation message on the customer's own phone and records the code. Choose sending a request only once Daraja credentials are ready below." | "Manual is default; only switch to Daraja once credentials are set below." | The two facts (default, and when it's safe to switch) aren't visible from the dropdown alone; the *what each mode does* half is now redundant with the dropdown's own option text, so it was dropped |
| `AdminScreen.tsx:1373-1378` (M-Pesa, manual mode box) | "No Daraja credentials are needed for this mode. The cashier reads the code off the customer's phone and enters it at the till for every M-Pesa sale." | removed | Restates the dropdown's own selected option ("Record the code myself, after checking the customer's phone") word for word |
| `AdminScreen.tsx:1499-1501` (M-Pesa, SMS inbox path) | "The folder on this till where the message reader saves each payment message." | removed | Restates the field's own label, "Where payment messages arrive" |
| `AdminScreen.tsx:1525-1531` (M-Pesa, unverified entries) | "Lets a cashier complete a sale by typing the customer's M-Pesa code when the confirmation has not reached this till. **Nothing checks that the payment really happened.** Each one needs a manager's PIN, is recorded as unverified, and stays on the Reconciliation tab until someone matches it to the M-Pesa statement. Takes effect after a restart." | "**Nothing checks that the payment really happened.** Needs a manager's PIN; stays unverified until matched to the statement." | Money — this toggle lets a sale complete without any payment verification; kept the warning and the two controls (PIN, reconciliation) |
| `AdminScreen.tsx:1552-1555` (M-Pesa footer note) | "M-Pesa settings are read once when the till starts, so saving here applies them after a restart." | "Applies after a restart." | Same restart gotcha as the System tab — not visible from the Save button |
| `AdminScreen.tsx:1877-1882` (Printers) | "Register additional printers — a secondary kitchen or label printer alongside the main receipt printer. A store with no printers registered here keeps using the single receipt printer configured via environment variables, unchanged." | removed | Heading "Printers" plus the add-printer form's own Type field (receipt/kitchen/label) already say this |
| `StockTakePage.tsx:371-375` (Start a stock take) | "Reads the current Shopify figures for this till's location, then lets you count items against them. Counting works without internet; pushing the correction does not. The till keeps selling normally throughout." | "Counting works offline; pushing the correction needs an internet connection." | Stock — whether counting needs a connection isn't visible from the button, and matters for a till in a weak-signal stockroom |
| `StockTakePage.tsx:613-618` (over the approval limit) | "This is over the approval limit {of X} — two different managers must approve it." | "Over the limit {of X}, needs two managers' approval." | Same fact, shortened; kept since it's the reason the commit button is about to be blocked |
| `StockTakePage.tsx:632-637` (commit confirmation) | "This changes live stock in Shopify and cannot be undone." / "Corrections after this are a new stock take." | "This changes live stock in Shopify and cannot be undone." (second sentence removed) | Irreversible-action confirmation — kept to one sentence stating what's committed, per the rule |
| `StockTakePage.tsx:672-675` (Approval policy) | "Counts moving more than the limit need a second manager. With the limit at zero every count does — set a real figure once the store has agreed one." | "Counts over the limit (zero by default) need two managers' approval." | Stock/control policy — the zero-by-default behaviour is surprising and not visible from the input field alone |
| `EndOfDayPage.tsx:308-312` (manual M-Pesa entries) | "Every manual M-Pesa entry is recorded on the cashier's own authority, with no PIN at the till. This review — approve what matches the statement, leave out what doesn't with a reason — is the only check they get." | "Approve entries that match the M-Pesa statement; leave out the rest with a reason." | Money — this is the task's own worked example, applied verbatim |
| `EndOfDayPage.tsx:454-457` (Carry-over) | "Manual entries from earlier days that no manager has approved yet. They stay here until someone does." | removed | Restates the heading directly above it, "Carry-over — not yet approved" |

**Reviewed and left unchanged** (candidates that turned out not to be explanatory prose, or already met the bar):
- `AdminScreen.tsx` Fiscal Device password hint ("Blank keeps it." / "Set on the control unit.") — dynamic, changes with saved-password state; already 3-4 words. A prior phase's own comment at this exact spot (now `AdminScreen.tsx:1582-1592`) already documents this same remove-static-keep-dynamic distinction.
- `AdminScreen.tsx` "Not the customer's PIN." (Store KRA PIN field) — already one short sentence; prevents filing the wrong PIN on a tax document.
- Every dynamic `{...Message}`/`{...Error}`/`{...Result}` paragraph (save results, test-connection results, update-check results) — these are results of an action, not explanation, per the rule's own exclusion.
- Every stat-tile caption ("Orders", "Revenue", "Cash", "M-Pesa / Card", live shift/session summaries) — these are data/status displays, not explanatory prose.
- `ManagerPinModal.tsx`'s `{title}` and the "No admin accounts available..." line — the title is a caller-supplied action name (functions as a label), and the no-accounts line is a status/error state.
- `NeedsAttentionPage.tsx`, `ShopifyCheckCard.tsx`, `MpesaLogsPage.tsx`, `ReportsPage.tsx`, `ZReportModal.tsx` — read in full; no static explanatory prose found beyond result/status/label text already excluded by the rule (see §5 for one borderline caption left alone in `ReportsPage.tsx`).

## 2. Files not in scope, confirmed

- `MpesaReconciliationPage.tsx` — not reachable from any Admin tab (superseded by `EndOfDayPage.tsx`, per that file's own doc comment); not touched.
- `ShopifyCheckNotice.tsx` — a cashier-facing toast mounted in `App.tsx`, not part of the Admin screen; not touched.
- `EtimsSetupGate.tsx` and other pre-login/onboarding screens — out of scope per the task; not touched.

## 3. Method

Used a research agent to inventory every `<p>`/text node in the ten in-scope files (file:line, exact text, static-vs-dynamic), then read each candidate's surrounding context directly to judge it against the rule myself before editing. Where a paragraph became the only content of its wrapper, the element itself was removed, not left empty (e.g. the Shopify Connection intro, the Printers intro, the Carry-over note).

## 4. Verify

```
$ npm run typecheck
(clean: typecheck:node and typecheck:web, no errors)
```

Grepped `tests/` for every removed or changed string (verbatim and by distinctive fragment — "stored securely", "approval limit", "Carry-over", "two different managers", "Register additional", "scopes inventory", "Datalogic", etc.). **No test asserted on any of them.** The one coincidental match, `tests/setupScreens.test.ts:115` (`not.toContain('stored securely')`), belongs to `EtimsSetupGate.tsx` — a pre-login screen out of this phase's scope — and is a negative assertion that remains true regardless.

**No existing assertion needed to change.**

Ran every test file touching an edited screen anyway, to be sure:
```
$ npx vitest run tests/adminScreen.test.ts tests/adminIntegrationsSections.test.ts \
    tests/endOfDayPage.test.ts tests/endOfDayReport.test.ts tests/stockTake.test.ts \
    tests/stockTakePageKeypad.test.ts tests/stockTakePagination.test.ts \
    tests/stockTakeGuard.test.ts tests/needsAttention.test.ts \
    tests/needsAttentionPagination.test.ts tests/useBarcodeScanner.test.ts
Test Files  11 passed (11)
     Tests  161 passed (161)

$ npm run build
built; "Confirmed: neither mock provider is in out/main."
```

(The full suite and `check:fit` were not run — not requested for this text-only phase, per its own VERIFY list.)

## 5. Observed but not changed

- **Barcode Scanner Stations** (§1) doesn't cleanly fit any of the four "matters" categories (money, tax, stock, irreversible) the rule names, but it's the *only* place in the running app that documents the `SC1:`/`SC2:`/`KITCHEN:` prefix scheme — there's no field, placeholder, or label anywhere else that carries it. Rather than delete it outright (which risked losing genuinely necessary setup information with no other source) or leave the full three-step tutorial (against the rule's default), I compressed it to one line that keeps the prefix-to-till mapping and dropped the "find the guide" step and the closing reassurance. Flagged here for your review — happy to remove it entirely if you'd rather.
- **`ReportsPage.tsx`'s VAT-from-device-groups caption** ("from X of Y sales; group D not included") was left as-is — it's a tax-relevant coverage caveat tightly bound to the figure above it, already three words shorter than the rule's ceiling, and reads more like a data caption than explanatory prose.
- **`AdminScreen.tsx`'s Fiscal Device section** already had a Store Details style pass in an earlier phase (see the comment now at `AdminScreen.tsx:1582-1592`, discovered while auditing) — nothing left to shorten there beyond the dynamic password hint, which the same comment already justifies keeping.

**STOP for review.**
