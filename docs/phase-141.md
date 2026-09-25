# Phase 141 — POS usability overhaul, Phase D: every location, 9 per page

- **Date:** 2026-09-25
- **Requested:** Build the approved [phase-140](./phase-140.md) plan: fetch every Shopify location instead of the first ten, and show them as cards, 9 per page, with Previous/Next. Both recommendations were approved — cards show an address (E1), and deactivated locations stay hidden (E2).
- **Outcome:** Implemented
- **Branch / base commit:** staging @ 7a01a49
- **Previous:** [phase-140](./phase-140.md)

## 1. Audit

The audit is [phase-140](./phase-140.md), including the Shopify facts verified against the pinned 2026-07 docs on 2026-09-25: 250 is the per-page maximum, `includeInactive`/`includeLegacy` both default to `false`, and `LocationAddress.formatted` is `[String!]!`.

Nothing changed on building it. One audit prediction was worth confirming and held: the six existing `validateAndFetchLocations` tests pass **unmodified**, because their mocks omit `pageInfo` and the loop reads `pageInfo?.hasNextPage ?? false` (§5).

## 2. Changes made

### Main process — fetch every location

**`services/shopify.ts`:**

- **`VALIDATE_STORE_QUERY`** now takes `($first: Int!, $after: String)`, requests `pageInfo { hasNextPage endCursor }`, and adds `address { formatted }`. `locations(first: 10)` is gone.
  - `includeInactive` and `includeLegacy` are **not** passed, so Shopify's defaults of `false` keep deactivated and fulfillment-service locations out of the picker (E2). `sortKey` is also left at its default of `NAME`, so pages read alphabetically.
  - `shop { name }` is re-requested on each page rather than split into a second query: ~1 point, keeps one query string, and never happens at all below 250 locations.
- **Two new constants:** `LOCATION_PAGE_SIZE = 250` (Shopify's documented maximum) and `MAX_LOCATION_PAGES = 40`, a hard stop so a malformed or repeating cursor fails loudly instead of spinning. Forty pages allows 10,000 locations, far beyond any real store and inside Shopify's own 25,000-object deep-pagination limit.
- **`formatLocationAddress`** (new, exported for its own tests) flattens `formatted` — a list of lines — to the single line a card shows. It keeps the first two lines, so a card reads "12 Mombasa Road, Nairobi 00100" and not the country that repeats on every card. Blank, empty, missing and `null` all yield `undefined`, so a location with no address simply shows no second line.
- **`validateAndFetchLocations`** now loops on `pageInfo`, in the same shape as `fetchAllProducts`, with three deliberate properties:
  - **A failed page fails the whole call.** Any page returning GraphQL `errors`, or throwing, returns `success: false` with no `data`. Returning the pages that did arrive would hand the caller a truncated list indistinguishable from a complete one, which is the exact bug being fixed.
  - **Exceeding the guard is an error, not a silent stop.**
  - **The shop name is read and checked on page 1 only.** It is the proof the token authenticated, so it still fails fast before anything is collected. Reading it only on the first page also lets it be a plain `string` rather than `string | undefined`, so the success return needed no cast and no unreachable branch.

**Return type unchanged**, so all four callers compile untouched. `ShopifyLocation` gains an optional `address`; a new `ShopifyLocationNode` describes the wire shape (nested and nullable at both levels) so the flattening happens once, in the service, and no consumer learns Shopify's `LocationAddress` shape.

The optional `address` was also added to the four return-type annotations that restate this shape in `main/index.ts` and `preload/index.ts`, and to both in `preload/window.d.ts`.

### Renderer — 9 per page

**`lib/paginate.ts`** (new, pure): `paginate(items, page, pageSize = 9)` → `{ items, page, pageCount, hasPrev, hasNext }`, and `pageOfIndex(index, pageSize)`.

- The requested page is **clamped**, not rejected: below 1, past the end, and non-finite all resolve to a real page, so a caller holding a stale page number after the list shrinks still renders something.
- An empty list gives `pageCount: 1`, so the control reads "Page 1 of 1" and never "of 0".
- A page size of 0 or less is floored to 1, so it can never divide by zero.

**`components/LocationPicker.tsx`:**

- **Cards** in a `grid-cols-3`, up to 9 per page, each a button showing the name and, when present, the address line. The selected card is marked with `aria-pressed` and the brand-red border/tint.
- **Page controls** always render once there is more than one location: Previous, "Page x of y", Next, each `h-11` (the phase-16 44px touch floor) and disabled at the ends. They stay visible rather than disappearing, so their disabled state is what tells the operator they have reached an end.
- **Opens on the page holding the current selection**, derived from the existing `selectedLocationId` prop via `pageOfIndex`, so a till whose location is the 93rd does not open on page 1 looking unset. A selection absent from the list falls back to page 1.
- **Paging is presentation only.** `onSelect` still receives the location id, so the PIN-gated `location:set` and the onboarding `config:save` paths behind it are untouched, and a location chosen on one page stays chosen while the operator looks at another.
- **Prev/Next act on the clamped page** (`pageResult.page ± 1`), so a stale page number self-corrects on the first tap.
- **The single-location message is kept** rather than showing one lone card: it explains the auto-selection the callers perform, which would otherwise look arbitrary.

**Containers widened** so three columns fit: OnboardingScreen and LocationConfirmScreen to `max-w-3xl`, and AdminScreen's Change Location panel from `max-w-md` to `max-w-3xl`.

**`LocationConfirmScreen` root gains `overflow-y-auto` and `py-8`.** This is a safety net, not a layout choice: nine cards plus the screen's chrome measure about 684px against 768px at the smallest supported viewport, but that is computed from class values, and without it a miss would centre the card and clip the Confirm button **out of reach** rather than let the operator scroll to it. The reasoning is in the component's doc comment. Phase E sizes this properly.

## 3. Affected files and functionality

| File | Change | Functionality affected |
| --- | --- | --- |
| src/main/services/shopify.ts | Modified | the locations query, its pagination, address flattening |
| src/main/services/shopify-types.ts | Modified (additive) | location wire and display shapes |
| src/main/index.ts, src/preload/index.ts, src/preload/window.d.ts | Modified (type annotations only) | the declared IPC location shape |
| src/renderer/src/lib/paginate.ts | Added | pure paging |
| src/renderer/src/components/LocationPicker.tsx | Modified | cards, paging, address line |
| src/renderer/src/components/LocationConfirmScreen.tsx | Modified | width; scroll safety net |
| src/renderer/src/components/OnboardingScreen.tsx, AdminScreen.tsx | Modified (width only) | room for 3 columns |
| tests/locationsPagination.test.ts, paginate.test.ts, locationPicker.test.ts | Added | tests |

## 4. Possible impact

**This fixes a silent data loss.** The query returned the first 10 of ~106 locations with no error and no sign the list was partial. The consequence was not cosmetic: **96 of 106 branches could not select their own location at all**, so those tills could not be set up. Two further symptoms are also fixed:

- A till deployed with `VITE_SHOPIFY_LOCATION_ID` pointing past the tenth location never resolved a display name, so Admin showed "Current location: **Not set**" while the till still scoped inventory to that id.
- Opening Admin → Change Location on such a till showed a list that did not contain its own location, so nothing was preselected.

**Locations that were never visible will now appear.** This is the intended effect and the thing to look at first on the real account: the picker goes from 10 entries to ~106 across 12 pages. Nobody's saved location changes — `location_id`, `location_confirmed` and `location_name` are untouched, and an already-confirmed till keeps selling against exactly the location it had.

**Other impact:**

- **Network:** still **one request** for Rubis, because 106 < 250. Latency is unchanged. A store above 250 would make additional sequential requests, each under the existing 10s per-request timeout; no caller imposes an overall deadline.
- **Deactivated locations stay hidden**, so a till cannot select a location that can no longer stock inventory or fulfil orders.
- **Order is unchanged** (Shopify's default `NAME`), so paging is alphabetical and predictable.
- **Data / schema / contract / receipts / KRA filing:** none. No IPC request shape changed, so no `ipcValidator` schema changed; only the *response* gained an optional field. `location:set` and `config:save` still take `locationId` and `locationName`.
- **Security posture:** unchanged. The locations query was already read-only and unauthenticated by PIN (`location:list` mirrors `config:validate`'s risk class); saving a location is still PIN-gated through `requireAdminPin`.
- **Idempotency / re-run safety:** the fetch is a read and can be repeated freely. It holds no state between calls.
- **Residual risk:** the 9-cards-fit-at-768px figure is computed from class values, not measured on the till, which is why the scroll fallback is there. At 150% Windows scaling (911×512 CSS px) nine cards will not fit; that is Phase E's matrix.

## 5. Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` (node and web) | clean |
| `npx vitest run` (full suite) | **99 files, 1,498 tests passed** |
| `git diff --stat -- tests/` | empty; the only changes under `tests/` are the three new untracked files |
| Tripwires (fiscalEngine, fiscalRouting, mpesaPaymentGate, VirtualNumpad, VirtualKeyboard, keyboardStore, setupScreens, virtualKeyboardLayouts, keyboardEchoSubmit, preLoginThemeGuard, themeTokens, preLoginTheme) | pass, files unmodified |
| Existing `shopifyService.test.ts` | 30 tests pass **unmodified**, as the audit predicted |
| `npx electron-vite build` | built, all three bundles |

**What the 47 new tests prove:**

- **`locationsPagination` (14) — the load-bearing file:**
  - **106 locations over 3 pages (50 + 50 + 6) all arrive**, in order, with no duplicates, in 3 requests, with the cursor threaded `null → cursor-0 → cursor-1`.
  - `first: 250` is sent, and the query string contains no `first: 10`.
  - The query names neither `includeInactive` nor `includeLegacy`, so the defaults keep deactivated locations out.
  - 0 locations; 1 location; a full 250-node page in exactly one request.
  - **Page 2 returning a GraphQL error fails the whole call** — `success: false`, no `data`, and the message surfaces — rather than returning page 1's 50.
  - Page 2 throwing fails the whole call.
  - **A cursor that never ends errors** after exactly 40 requests instead of looping forever.
  - A first page with no shop name is still rejected before anything is collected.
  - `formatLocationAddress`: two lines kept, single line passed through, and empty/blank/missing/null all give `undefined`; the flattened line reaches the returned location.
- **`paginate` (19):** 0, 1, 9, 10, 27 and 106 items; 106 → 12 pages with 7 on the last; clamping below 1, past the end and non-finite; every item appears exactly once across the pages in list order; custom page size; a page size of 0 or less; and the input list is not mutated.
- **`locationPicker` (14), real mount and real clicks:** 106 → 9 cards in a 3-column grid, "Page 1 of 12", Previous disabled; Next → page 2 starting at station 10; Previous returns; page 12 shows 7 with Next disabled; **all 106 reachable exactly once in order** across the pages; a card tapped on page 5 calls `onSelect` with that location's id; the selection stays marked after paging away and back; mounting with station 64 selected **opens on page 8**; a saved location absent from the list opens on page 1; 5 locations give one page with both buttons disabled; the single-location message is kept; Confirm stays disabled until something is selected; the page buttons keep `h-11`.

**Mutation checks — three, each restored afterwards.** These prove the tests actually guard the fix rather than merely passing alongside it:

| Mutation | Result |
| --- | --- |
| The locations loop stops after page 1 (**the original bug**) | **4 tests failed**, including "returns all 106 locations across 3 pages" |
| The loop guard `break`s silently instead of erroring | 1 test failed: "errors instead of looping forever when the cursor never ends" |
| A failed page returns the pages collected so far as if complete | 1 test failed: "fails the whole call when page 2 returns a GraphQL error, rather than returning page 1" |

The product paginator was left untouched by each mutation (it shares the same line of code, so the edits were scoped to the locations loop), and `src/main/services/shopify.ts` was verified byte-correct afterwards.

## 6. What only a human can check

On the till, against the real Rubis account:

- **Page through every location to the end.** The count should be ~106 across 12 pages, not 10 on one page.
- **The last page shows the remainder** and Next is disabled there; Previous is disabled on page 1.
- **Locations that were never visible now appear.** Expected — the cap was hiding them.
- **Select a location on a later page and confirm it saves**, through the Manager PIN gate, and that the till then scopes its catalog to it.
- **Addresses read sensibly** under the names, and cards with no address in Shopify look right with just a name.
- **Nine cards fit** on the confirm screen without the Confirm button being cut off, on onboarding, the confirm gate and Admin → Change Location.
- **A till already confirmed keeps its location** and does not re-prompt.

## 7. Rollback

`git revert <this commit>`. It restores the 10-location cap along with the card grid, so reverting re-introduces the data loss — worth saying out loud, since this is the one phase whose revert is not purely cosmetic.

## 8. Observed but not changed

- **No search box.** With 106 locations, typing two letters would beat paging through 12 pages, and Shopify's `locations(query:)` argument could even filter server-side. Not in this brief; the clearest next improvement here.
- **`fetchAllProducts` still has no loop guard,** and `fetchInventoryLevelDetails` still `break`s silently on a missing connection and returns a partial map — the same class of hazard this phase fixed for locations. Out of scope; worth its own change.
- **`ShopifyLocationsResponse`** in `shopify-types.ts` is declared and never used anywhere. Left alone; it is not wrong, just dead.
- **`CheckoutModal.tsx`** is still dead code (phase-139 §8).
- **Phase E** is next: no page scroll after login, and viewport scaling across 1366×768 to 2560×1440 at 100–150% Windows scaling. It also owns the 150%-scaling fit of these nine cards, and the setup sheet's height.
