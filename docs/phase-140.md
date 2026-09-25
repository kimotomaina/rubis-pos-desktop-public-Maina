# Phase 140 — POS usability overhaul, Phase D: audit (all locations, 9 per page)

- **Date:** 2026-09-25
- **Requested:** Audit only, before fetching every Shopify location (Rubis may have up to 106) and showing them 9 per page with Previous/Next.
- **Outcome:** No change needed (audit only). The data loss is confirmed and is worse than a display problem (§2). Two decisions need your call (§0); the plan is in §8.
- **Branch / base commit:** staging @ a4551e8
- **Previous:** [phase-139](./phase-139.md)

## 0. Decisions needed

| # | Question | What I found | Recommendation |
| --- | --- | --- | --- |
| E1 | Should the cards show an address under the location name? | `Location.address` is a non-null `LocationAddress`, whose `formatted` field is `[String!]!` (§4). Adding it is additive but touches the query, `ShopifyLocation`, `window.d.ts` (two return types) and `ShopifyLocationOption`. | **Yes.** With 106 stations, names alone may not disambiguate. Show `formatted` lines 1–2 joined (street, city), truncated to one line. Selection and validation are untouched. |
| E2 | Should the query start returning **deactivated** locations? | `includeInactive` and `includeLegacy` both default to `false`, so today's query already returns only active, non-fulfillment-service locations (§3). | **No.** Leave both at their default. This changes *which* locations appear, not just how many, so it is not mine to change silently. A deactivated location cannot stock inventory or fulfil orders, so a till must not be able to select one. |

## 1. `VALIDATE_STORE_QUERY`, `validateAndFetchLocations`, and every caller

The query is a **static string with no variables and no `pageInfo`** ([shopify.ts:113-125](../src/main/services/shopify.ts#L113-L125)):

```graphql
query ValidateStore {
  shop { name }
  locations(first: 10) { nodes { id name } }
}
```

`validateAndFetchLocations` ([shopify.ts:327](../src/main/services/shopify.ts#L327)) does **one** `client.post('', { query: VALIDATE_STORE_QUERY })`, checks `errors`, requires a non-empty `shop.name` as proof the token authenticated, then returns `{ shopName, locations: response.data.data.locations.nodes ?? [] }`.

`locations(first: 10)` is the **only** hardcoded page size of its kind in `src/`; the two product/inventory queries already use 250.

**Callers — four, not three.** The startup one was not in my phase-135 list:

| # | Caller | Path | What it does with the list |
| --- | --- | --- | --- |
| 1 | `config:validate` IPC ([index.ts:1981](../src/main/index.ts#L1981)) | Onboarding "Connect & Verify" | passes the whole list to step 2's picker; auto-selects when `length === 1` |
| 2 | `location:list` IPC ([index.ts:1920](../src/main/index.ts#L1920)) | LocationConfirmScreen, and AdminScreen "Change Location" | renders the picker; preselects the saved id when it is in the list |
| 3 | **Startup name resolution** ([index.ts:479](../src/main/index.ts#L479)) | only when `VITE_SHOPIFY_LOCATION_ID` is set | `locations.find(l => l.id === envId)` purely to resolve a display name; never affects `locationConfirmed` |
| 4 | `tests/shopifyService.test.ts` | — | six tests (§7) |

**No consumer assumes ten or fewer.** There are no fixed-size arrays and no slicing. The two count-sensitive branches are `length === 1` (auto-select the only location) and `length > 0` (Admin shows the picker or an error). Both stay correct at 106.

## 2. The data loss is worse than a display problem

With 106 locations, `first: 10` returns 10 and **drops 96 silently** — no error, no `pageInfo`, nothing in the UI to suggest the list is partial.

The sharp consequence is not cosmetic:

- **96 of 106 branches cannot be configured at all.** A till at location #37 has no way to select its own location. The confirm gate and Onboarding can only offer what the query returned, so setup is impossible for those branches.
- **Caller 3 fails quietly.** If `VITE_SHOPIFY_LOCATION_ID` points past the first ten, `find` returns `undefined`, `locationName` is never resolved, and Admin shows "Current location: **Not set**" while the till still scopes inventory to that id.
- **An already-confirmed till keeps working.** `locationConfirmed` is read from the `location_confirmed` setting, not from the list, so a till confirmed before is unaffected until someone opens Change Location — where its own location may be absent from the list and nothing is preselected.

Fixing the fetch is therefore required regardless of the card layout.

## 3. Shopify pagination for `locations` (verified, not recalled)

Checked **2026-09-25** against our pinned version's own page, not just `/latest/`:

- [locations query, 2026-07](https://shopify.dev/docs/api/admin-graphql/2026-07/queries/locations) — accepts `first`/`after` and returns `pageInfo`; `includeInactive` **default `false`** ("deactivated locations that can no longer stock inventory or fulfill orders"); `includeLegacy` **default `false`** ("locations that FulfillmentService apps manage"). Also accepts `before`, `last`, `query`, `reverse`, and `sortKey` (default `NAME`).
- [locations query, latest](https://shopify.dev/docs/api/admin-graphql/latest/queries/locations) — same arguments and defaults.
- [GraphQL pagination](https://shopify.dev/docs/api/usage/pagination-graphql) — **"You can retrieve up to a maximum of 250 resources"** per page via `first`/`last`. `PageInfo` exposes `hasNextPage`, `hasPreviousPage`, `startCursor`, `endCursor`. A separate 25,000-object limit applies to deep pagination.

**Two consequences:**

1. **106 locations fit in a single page** at `first: 250`. So in practice this fix is one round trip, exactly as today — the loop is there for correctness, not because Rubis needs it.
2. **`sortKey` defaults to `NAME`,** so the order is Shopify's alphabetical-by-name, not insertion order. Following the cursor preserves it across pages. Keeping Shopify's order, as the brief asks, means keeping this default.

## 4. `Location.address`, for E1

Checked 2026-09-25:

- [Location object](https://shopify.dev/docs/api/admin-graphql/latest/objects/Location) — `address: LocationAddress!` (non-null), plus `name: String!`, `isActive: Boolean!`, `fulfillmentService: FulfillmentService`.
- [LocationAddress object](https://shopify.dev/docs/api/admin-graphql/latest/objects/LocationAddress) — `formatted: [String!]!` ("A formatted version of the address for the location"), plus `address1`, `address2`, `city`, `country`, `countryCode`, `province`, `provinceCode`, `zip`, `phone`, `latitude`, `longitude`.

`address` is non-null but its inner fields are nullable, so `formatted` can legitimately be an empty list. The card must treat the address as optional.

## 5. The existing paginator, and whether it can be reused

`fetchAllProducts` ([shopify.ts:509](../src/main/services/shopify.ts#L509)) is the pattern to copy:

```ts
let cursor: string | null = null
let hasNextPage = true
while (hasNextPage) {
  const response = await client.post('', { query, variables: { first: pageSize, after: cursor } })
  if (response.data?.errors?.length) return { success: false, error: … }   // whole call fails
  hasNextPage = connection?.pageInfo?.hasNextPage ?? false
  cursor = connection?.pageInfo?.endCursor ?? null
}
```

**Reusable, with two deliberate differences:**

- **It already fails the whole call on a page error,** which is exactly the behaviour the brief wants. Good.
- **It has no loop guard.** A malformed or repeating cursor spins forever. `fetchInventoryLevelDetails` is worse: `if (!data) break` stops silently and returns a partial map. I will add a max-page guard to the new locations fetch that errors when exceeded. I will **not** retrofit the product paginator in this phase — out of scope, and recorded in §10.
- The loop itself is short enough that sharing a generic paginator across products and locations would mean a generic over response shape, cursor path and mapper, for two call sites. Not worth it; the same shape written once more is plainer.

## 6. Timing and failure behaviour (audit item 4)

- **Per-request timeout is 10s** (`createShopifyClient`, [shopify.ts:258](../src/main/services/shopify.ts#L258)). It is **per request, not per fetch**, so a multi-page fetch has no overall deadline.
- **Worst case for Rubis: one request,** because 106 < 250. Same latency as today. A store with 1,000 locations would be 4 sequential requests, so ≤40s worst case.
- **No caller imposes a timeout.** `ipcRenderer.invoke` has none; LocationConfirmScreen and AdminScreen just await the promise with a "Loading locations…" state. So a multi-page fetch cannot trip a caller's deadline.
- **Rate limits are not a concern here:** one query returning 250 nodes of two scalars is far cheaper than the existing `products(first: 250)` with nested `variants(first: 250)`, which already runs on every catalog refresh.
- **Failure behaviour, to be built:** any page returning GraphQL `errors`, or throwing, fails the **entire** call with `success: false`. A partial list is never returned as if complete — returning 50 of 106 as a full list would be the same class of bug being fixed. The renderer already renders `result.error` on all three screens.

## 7. Existing tests, and whether they survive

`tests/shopifyService.test.ts` (not a tripwire, so it may be edited) has six `validateAndFetchLocations` tests. Their mocks return `{ data: { data: { shop, locations: { nodes } } } }` with **no `pageInfo`**.

Because the loop reads `pageInfo?.hasNextPage ?? false`, those mocks terminate after one page, so **all six should pass unmodified**. One asserts `body.query === VALIDATE_STORE_QUERY`, which holds as long as the exported constant keeps its name and is still passed as `query`. The mock client exposes only `post`, so the paginator must use nothing else. I will confirm this rather than assume it.

## 8. `LocationPicker` and its containers (audit item 5)

Props today: `{ shopName, locations, selectedLocationId, onSelect, onConfirm, confirming, confirmError, confirmLabel, onBack? }`.

**Selection is already passed in as `selectedLocationId`,** so "open on the page holding the current selection" needs no new prop: the initial page is derived from that id's index.

**Containers, and why they must widen:**

| Consumer | Today | Needed |
| --- | --- | --- |
| OnboardingScreen | `max-w-2xl` (672px, widened in phase-137) | `max-w-3xl` |
| LocationConfirmScreen | `max-w-md` (448px) | `max-w-3xl` |
| AdminScreen Change Location | `max-w-md` (448px) | `max-w-3xl` |

448px cannot hold three columns; at `max-w-3xl` (768px) minus padding, each card gets ~230px.

**Today's list would already break at 106:** it renders every location as an `h-14` row in a `space-y-2` list. 106 rows is ~5,900px tall inside a screen that does not scroll (below). Paging is what makes 106 viable at all.

**A real fit risk on the smallest viewport.** LocationConfirmScreen's root is `app-theme flex h-screen flex-col items-center justify-center px-4` — **no `overflow-y-auto`**, unlike Onboarding, which got one in phase-137. Content taller than the viewport is therefore centred and **clipped**, not scrollable, so the Confirm button could become unreachable rather than merely below the fold.

My estimate for nine compact cards at 1366×768: logo 96 + card padding 48 + heading 36 + subtitle 48 + Connected chip 52 + grid 288 + page controls 60 + confirm 56 ≈ **684px against 768px**, so it fits with ~84px of slack. That estimate is from class values, not a real screen, and Quicksand's metrics differ from the old font. I will therefore add `overflow-y-auto` to that root as a safety net so a miss degrades to a scroll instead of an unreachable button. At 150% Windows scaling (911×512 CSS px) it will not fit; that belongs to Phase E's matrix.

## 9. Plan (one commit, after your review)

**Main process:**

1. `VALIDATE_STORE_QUERY` gains `($first: Int!, $after: String)`, `pageInfo { hasNextPage endCursor }`, and (per E1) `address { formatted }`. `includeInactive`/`includeLegacy` are left at their defaults.
2. `validateAndFetchLocations` loops at `first: 250`, following `endCursor`, taking `shopName` from the first page. Re-requesting `shop { name }` on later pages costs ~1 point and keeps one query string — simpler than a second locations-only query, and for Rubis there is never a second page.
3. Any page's `errors` or throw fails the whole call. A `MAX_LOCATION_PAGES` guard (40 pages = 10,000 locations) errors rather than stopping silently.
4. The return type stays `{ shopName, locations }`, so all four callers compile unchanged; `ShopifyLocation` gains an optional `address`.
5. `window.d.ts`'s two location return types gain the same optional field.

**Renderer:**

6. New pure `lib/paginate.ts`: `paginate(items, page, pageSize = 9)` → `{ items, page, pageCount, hasPrev, hasNext }`, clamping out-of-range pages; zero items gives `pageCount: 1` and an empty page.
7. `LocationPicker`: a 3-column grid of up to 9 cards showing name and address, Previous/Next (disabled at the ends, ≥44px), and "Page x of y". `onSelect` is untouched, so the PIN-gated `location:set` and `config:save` paths are untouched. Initial page derives from `selectedLocationId`; selection survives paging.
8. The three containers widen to `max-w-3xl`; LocationConfirmScreen's root gains `overflow-y-auto`.

**Tests** (the paginator test is the load-bearing one):

9. Main process, with a fake client: 106 over 3 pages (50+50+6) all arrive in order with no duplicates; 0; 1; exactly one full page; page 2 failing returns an error, not 50 locations; a never-ending cursor hits the guard and errors.
10. `paginate`: 0, 1, 9, 10, 27, 106 items; first/last bounds; clamping below 1 and above `pageCount`; stable order.
11. `LocationPicker` real mount and clicks: 106 → 9 cards, "Page 1 of 12", Previous disabled; Next → page 2 with 9; Previous returns; page 12 shows 7 with Next disabled; a card click on page 5 calls `onSelect` with that location; selection still marked after paging away and back; mounting with a selection on page 8 opens on page 8; 5 locations → one page, both buttons disabled.
12. Tripwires unmodified, confirmed with `git diff --stat -- tests/`.

## 10. Changes made

None. This report is the only file added.

## 11. Rollback

`git revert <this commit>`.

## 12. Observed but not changed

- **No search box.** With 106 locations, typing a few letters would beat paging through 12 pages. Not in the brief; worth considering later. Shopify's `locations(query:)` argument could even filter server-side.
- **`fetchAllProducts` has no loop guard,** and `fetchInventoryLevelDetails` breaks silently on a missing connection and returns a partial map. Both are the same class of hazard this phase fixes for locations. Out of scope here.
- **`sortKey` stays `NAME`.** Alphabetical order is what the list already shows, so paging it is predictable. Changing it would reorder what operators see.
- **Deactivated locations stay hidden** (E2), so a till cannot select a location that can no longer hold inventory.
- **`CheckoutModal.tsx` is still dead code** (phase-139 §8).
