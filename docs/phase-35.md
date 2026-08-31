# Phase 35 — UI Enhancements: eTIMS Logo, Navbar Fix, Sticky Search

**Date:** 2026-08-31 · **Branch:** `main` · **Previous:** [Phase 34](./phase-34.md)

## 1. Objective

Three small, independent UI fixes: display the eTIMS brand logo in the
order-history fiscal details, remove a perceived duplicate user-name
display in the header, and make the catalog's product search bar
sticky while scrolling. Two of the three original task descriptions
didn't match the actual codebase — both were investigated against the
real code before any change was made, rather than assumed.

## 2. Sticky search bar (`src/renderer/src/App.tsx`)

The catalog view's scrolling `<section>` previously had the search
bar inline in a plain flex row with `p-6` padding on the section
itself. Restructured so the heading/cached-badge/search-bar row is its
own `sticky top-0 z-10` div (matching the page's `bg-slate-50`, with a
bottom border and shadow to separate it from the scrolling grid), and
the rest of the section's content moved into a separate padded `<div>`
below it — per the accepted default (Q4), it stays full-size rather
than collapsing on scroll.

## 3. eTIMS logo (`src/renderer/src/components/OrderHistory.tsx`)

**Investigated before changing anything**: there was no eTIMS logo
file, and no `resources/logos/` directory, anywhere in the repo — what
renders per fiscalized order is a base64 QR code image, not a logo.
Confirmed with the user, who supplied `resources/logos/logo-etims.png`.

That file can't be imported directly into the renderer bundle —
`resources/` at the project root is reserved for electron-builder's
main-process-only `extraResources` (e.g. the `.env` copy and the app
icon, read via `process.resourcesPath`), which Vite's renderer build
has no visibility into. Copied it into
`src/renderer/src/assets/logo-etims.png` (alongside the existing
`logo-rubis.png`, which is imported the same way) and added a new
`EtimsLogo` component rendering it next to the fiscal QR code in the
per-order details row, with an `onError` handler falling back to plain
"eTIMS" text if the image ever fails to load.

## 4. Navbar "duplicate" text (`src/renderer/src/App.tsx`)

**Investigated before changing anything**: no `NavBar.tsx` file
exists — the header is inline in `App.tsx`, and it rendered the staff
name and role exactly once each; there was no code-level duplication.
The user's screenshot showed "Admin" appearing twice because the
seeded default account has both `name: 'Admin'` and `role: 'admin'`
(`src/main/index.ts:278`) — the name and the capitalized role badge
happened to read as the same word for that one account.

Fixed generally rather than special-cased to the seed data: the role
badge now only renders when `currentStaff.role.toLowerCase() !==
currentStaff.name.toLowerCase()`, so it disappears for this one
coincidental account but still shows normally for any real staff
member whose name and role differ (e.g. "Alex" / "cashier").

## 5. Testing

No new test files — all three changes are presentational (JSX
structure, an image swap with a UI-only error fallback, and a
conditional render). Existing `orderHistory.test.ts` and
`checkout.test.ts` suites were re-run to confirm no regression.

## 6. Verification

- `npm test` — 535/535 passing (42 files), no regressions.
- `npx tsc --noEmit` on both `tsconfig.node.json` and
  `tsconfig.web.json` — no new errors (only the pre-existing,
  unrelated cross-project `TS6307` noise confirmed harmless since
  Phase 28).

## 7. Follow-ups

- None specific to this phase — see [Phase 36](./phase-36.md) for what
  followed.
