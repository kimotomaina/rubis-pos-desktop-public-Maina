# Phase 17 — Touch UI Optimization for 15" 1080p Screen

**Date:** 2026-08-26 · **Branch:** `main` · **Previous:** [Phase 16](./phase-16.md)

## 1. Objective

A screenshot from the test environment showed the product grid and
cart still reading cramped even after Phase 16's font-size pass: flat
~180px product cards with small images, a cart column with tiny
`+`/`-` buttons and text-link actions, and single-line product-name
truncation. This phase is a layout-only pass — no IPC contracts,
business logic, or database schema changed, and no test needed
updating (nothing here changes behavior, only `className` and JSX
structure).

## 2. Product cards (`ProductCard.tsx`)

| Element | Before | After |
| --- | --- | --- |
| Card height | `h-64` (256px), `p-6` | `h-80` (320px), `p-5` |
| Image area | `aspect-square`, `object-cover` | fixed `h-45` (180px, ~60% of card height), `object-contain` with `p-3` so the whole product is visible instead of cropped |
| Missing-image initials | `text-3xl` | `text-5xl` |
| Title | `text-xl font-medium`, `line-clamp-1` (truncated to one line) | `text-lg font-semibold`, `line-clamp-2` (two lines before ellipsis — Q2 default) |
| Price | `text-xl font-bold text-slate-500` (muted) | `text-xl font-bold text-slate-900` (full contrast, reads as the prominent number it is) |
| Variant badge | `px-2.5 py-1` | `px-2 py-1` (spec's exact value) |
| Grid | `grid-cols-2 sm:grid-cols-3 lg:grid-cols-4`, `gap-4` | `grid-cols-2 lg:grid-cols-3`, `gap-6` — 3 columns max (Q1: fixed height for scan-ability), wider cards, more breathing room |

Card height is fixed rather than content-driven (Q1 default) — the
grid depends on every card lining up at the same height for fast
visual scanning at a glance, which a card that grows with a 2-line
title vs. a 1-line title would break.

## 3. Cart line items (`CartLineItem.tsx`)

Restructured into three columns instead of a five-column flat row so
touch targets don't have to compete for horizontal space:

- **Left** — `h-16 w-16` thumbnail, now `object-contain` (was
  `object-cover`, which cropped tall/narrow product photos).
- **Middle** — title (`text-base font-semibold`, `line-clamp-2` instead
  of the previous 1-line truncation — same two-line rule as the
  product grid), variant (`text-sm text-slate-600`), unit price
  (`text-sm text-slate-500`, newly surfaced here — previously only
  shown as a cramped "`price × qty`" hint on the right), and the
  "Edit Price"/"Discount" actions converted from bare text links to
  `rounded-full bg-slate-100 px-3 py-1.5 text-xs` pill buttons directly
  under the title.
- **Right** — a `h-10 w-10` circular remove button with a trash-can
  SVG (was a bare `✕` glyph with no dedicated hit area), the line
  total above a `h-10 w-10` `−`/`+` stepper with a `w-6` fixed-width
  quantity readout (`text-lg font-bold`) between them so the buttons
  don't shift when the digit count changes.

A `border-b border-slate-100` divider between rows (removed on the
last item) replaces the old bottom-padding-only separation, giving the
list clearer vertical rhythm at a glance — directly answering the
"cart column needs better vertical rhythm" issue from the screenshot
review. Row height (`min-h-24`, from Phase 16) was already correct and
unchanged.

## 4. Cart column (`App.tsx`)

- **Width**: `w-md` — not a real Tailwind width utility, so the cart
  column had no explicit width and was sized only by its children —
  replaced with `w-120` (480px, Tailwind's spacing-scale form of
  `480px`), landing in the middle of the requested 450–500px / 35–40%
  range on a 1920px-wide display. This was a latent bug from an
  earlier phase, not something introduced here.
- **Header**: "Cart (N items)" is `text-xl font-bold` (was
  `font-semibold`) with `p-5` (was `p-4`).
- **Scroll behavior**: already correct from Phase 16 —
  `flex flex-col` on the `<aside>`, `flex-1 overflow-y-auto` on the
  items list, and a plain (non-`flex-1`) total/checkout block below
  it. A non-growing flex sibling after a `flex-1` sibling is
  automatically pinned to the bottom without needing `mt-auto`; no
  structural change was needed here, only the padding/font bumps
  already covered above.
- Kept on the right (Q3 default) — matches the existing
  browse-then-review-then-checkout left-to-right flow, and repositioning
  it would touch far more than this pass's scope.

## 5. Global spacing

- Nav tabs (`Catalog`/`Orders`/`Admin`): `gap-1` → `gap-2`.
- Checkout modal's Cash/M-Pesa/Card method grid: `gap-2` → `gap-4`,
  giving the three primary payment buttons clearer separation.
- Cart line item's "Edit Price"/"Discount" pill row: `gap-2` → `gap-3`.
- Search bar (`h-12`, `text-lg`) and header height (`h-20`) were
  already done in Phase 16 and needed no further change here.

Not every `gap-2` in the app was blanket-replaced — icon+label pairs
and dense inline editors (the price/discount override rows) keep
tight spacing deliberately, since those aren't the primary touch
targets the screenshot flagged and loosening them would just waste
space without helping usability.

## 6. Testing

No Vitest file needed changes — every edit in this phase is a
`className`/JSX-structure change with no altered function signature,
return value, or control flow. The existing cart/discount/quantity
logic (`cartStore.test.ts`, `discounts.test.ts`, `priceOverride.test.ts`,
`checkout.test.ts`) exercises the underlying store and math functions
directly, none of which changed, and no test in the repo mounts
`ProductCard.tsx`, `CartLineItem.tsx`, or `App.tsx` (confirmed via a
repo-wide grep before starting), so there was nothing to break.

## 7. Manual verification notes

Recommended test resolution: **1920×1080**, matching the target 15"
touchscreen till. At that width:

- The product grid renders 3 columns of `h-80` cards with clear
  180px product photography, 2-line titles, and a bold price —
  no more single-line name truncation.
- The cart column occupies ~480px (25% of the window at 1920px wide,
  within the 450–500px target), with clearly separated rows, a visible
  divider between items, `40×40px` quantity buttons, a circular trash
  button, and pill-shaped "Edit Price"/"Discount" actions.
- Scrolling a cart with more items than fit on screen only scrolls the
  item list — the Total and the `h-16` Checkout button stay pinned to
  the bottom of the cart column at all times.

## 8. Verification

- `npm run typecheck` — clean (both `node` and `web` projects).
- `npm test` — 399/399 passing across 34 files (unchanged from
  Phase 16 — no test file was touched).
