# Phase 154 — Delete dead CheckoutModal.tsx

- **Date:** 2026-09-26
- **Requested:** `CheckoutModal.tsx` has been confirmed dead code across three prior audits (phases 138, 139, 151) — `PosCheckoutPanel.tsx` replaced it in Phase 44, and it still contains plain typed M-Pesa reference/KRA PIN/company-name fields, a trap for anyone who reconnects it. Re-confirm nothing references it, delete it, and update any doc comment that names it.
- **Outcome:** Confirmed dead, deleted, comments updated.
- **Branch / base commit:** staging @ 6b302ed (Phase 153 / Step 4 Part A2).

## 1. What was checked

A fresh, repo-wide search for `CheckoutModal` (not relying on the prior audits' conclusions alone), covering source, tests, and docs:

- **Imports / dynamic imports / JSX usage:** `grep -rn "CheckoutModal"` across the whole repo, plus a separate search for `import(...CheckoutModal` / `require(...CheckoutModal` (dynamic imports) — zero matches for either in `src/` or `tests/`. The only file that `import`s or renders it is `CheckoutModal.tsx` itself (its own type name, `CheckoutModalProps`).
- **String-based references:** none found — no route name, IPC channel, or config key references it (it's a plain React component with no registration mechanism to check).
- **Every other hit was prose, not code:** doc comments in six other source files naming it in passing (see §2), historical `docs/phase-*.md` reports (an append-only log, left untouched — phases 10, 16, 25, 40, 41, 43, 48, 49, 77, 78, 82, 85, 100, 102, 121, 138, 139, 140, 141, 151 all mention it, several explicitly already concluding it was dead), and `PosCheckoutPanel.tsx`'s own doc comment stating it replaced "the `CheckoutModal` popup entirely for Cash/M-Pesa sales."

Nothing found changes the prior audits' conclusion. Proceeded to delete.

## 2. What was changed

- **Deleted:** `src/renderer/src/components/CheckoutModal.tsx`.
- **Doc comments updated** in six files that named it only in passing explanation (never in code), each pointing to `PosCheckoutPanel` instead — the live component that actually does what the comment describes today:
  - `src/renderer/src/components/PosCheckoutPanel.tsx` — dropped "and the `CheckoutModal` popup" from its own history note (nothing else in the sentence needed it).
  - `src/renderer/src/lib/checkoutMath.ts` — "independent of `CheckoutModal`'s React state" → "independent of `PosCheckoutPanel`'s React state".
  - `src/renderer/src/lib/fiscalNotice.ts` — "matching how `checkoutMath.ts` is tested independently of `CheckoutModal`" → "...of `PosCheckoutPanel`".
  - `src/renderer/src/lib/kraPin.ts` — "unit-testable without mounting `CheckoutModal`" → "...`PosCheckoutPanel`".
  - `src/renderer/src/stores/cartStore.ts` — "Payment details collected by `CheckoutModal`" → "...by `PosCheckoutPanel`" (this one was already inaccurate before the deletion — `PosCheckoutPanel` has been the actual collector since Phase 44).
  - `tests/checkout.test.ts` — "tested directly without mounting `CheckoutModal`" → "...`PosCheckoutPanel`".
  - `tests/fiscalNotice.test.ts` — "which do the same for `CheckoutModal`" → "...for `PosCheckoutPanel`".
- **No other change.** Historical `docs/phase-*.md` reports were left exactly as written — they are an append-only record of what was true at the time, not live documentation to keep in sync.

## 3. Affected files

| File | Change | Functionality affected |
| --- | --- | --- |
| `src/renderer/src/components/CheckoutModal.tsx` | Deleted | None — unreferenced dead code |
| `src/renderer/src/components/PosCheckoutPanel.tsx` | Comment only | None |
| `src/renderer/src/lib/checkoutMath.ts` | Comment only | None |
| `src/renderer/src/lib/fiscalNotice.ts` | Comment only | None |
| `src/renderer/src/lib/kraPin.ts` | Comment only | None |
| `src/renderer/src/stores/cartStore.ts` | Comment only | None |
| `tests/checkout.test.ts` | Comment only | None |
| `tests/fiscalNotice.test.ts` | Comment only | None |

## 4. Verification

- `npm run typecheck` — clean.
- `npx vitest run` — **110 test files, 1684 tests passed**, identical count to before this change (no test ever mounted `CheckoutModal.tsx`, confirming it was truly unreachable).
- `npm run build` — succeeds; the renderer bundle transforms the same 96 modules as before the deletion, confirming `CheckoutModal.tsx` was never part of it.

## 5. Rollback

`git revert` of this commit restores the file and every comment verbatim.

---

**STOP.**
