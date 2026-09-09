# Phase 95 — the unfiled-count badge + the honest fiscal badge (Finding 4)

Finishes Part 3 of the go-live readiness follow-up: a prominent,
always-visible count of completed-but-unfiled sales (the instrument the
go-live plan's own success test watches drain to zero), and the honesty
fix for the header "✓ Fiscal" badge (Finding 4). UI wiring to
already-tested backend, plus one small, targeted fix to a real staleness
bug found while auditing the badge's data source — no change to
fiscalization, resend, or routing logic.

## Part 1 audit findings (confirmed before building anything)

- `db.getUnfiledOrderCount()` (`database.ts:1165-1170`) — confirmed
  again: `COUNT(*) WHERE fiscal_status IN ('waiting', 'needs_fixing')`,
  no threshold. Exposed unchanged as `window.api.getUnfiledSalesCount()`.
- The header badge row (`Online / ✓ M-Pesa / ✓ Fiscal / Scanner /
  Printer`) lives in `App.tsx`'s persistent `<header>`, rendered via
  `ConnectivityBadges.tsx`, fed by `useConnectivityStore` which reads
  `getConnectivityStatus()` once and then a `connectivity:status`
  broadcast pushed from `main/index.ts`'s `connectivityMonitor` every
  30 seconds.
- `checkFiscal` (`main/index.ts:732-735`, before this phase) was
  `checkHttpReachable(etimsConfig.baseUrl || DEFAULT_ETIMS_BASE_URL)` —
  confirmed to be an HTTP reachability probe of the **server**, nothing
  about the device, password, or TIMS pairing.
- **Confirmed the staleness sub-note.** `etimsConfig`
  (`main/index.ts:592`) is read once at startup into a `const`.
  `applyEtimsConfigToProvider()` (`main/index.ts:632-650`), called after
  every Admin/gate save, reconfigures the live
  `RealFiscalizationProvider` — but never touches that outer `const`.
  `checkFiscal` closed over it directly, so after an Admin server-address
  change the badge kept probing the **old** URL until the next relaunch.
  Confirmed by reading the actual closures, not assumed.
- Decision: the count belongs in the always-visible header row (visible
  without opening Admin, exactly as asked), refreshed on a light poll
  plus an explicit call right after any resend from the Needs Attention
  page. Made it tappable to jump straight to that page — the smallest
  version of that convenience is a mount-time `initialTab` prop on
  `AdminScreen`, since it fully remounts on every navigation into Admin.

## What was built

**`src/renderer/src/lib/unfiledCount.ts`** — pure display logic, tested
directly: `describeUnfiledCount(count)` returns `{ label, tone }` —
`{ 'All sales filed', 'quiet' }` at zero, `{ 'N sale(s) not filed',
'alert' }` otherwise. No codes, no jargon.

**`src/renderer/src/stores/unfiledCountStore.ts`** — a Zustand store
polling `getUnfiledSalesCount()` every 30 seconds (matching
`connectivityMonitor`'s own cadence), with an idempotent `init()` and a
`refresh()` any caller can invoke directly. A failed read keeps the last
known count rather than flashing a false "All sales filed" — Rule 3 is
about visibility, so an unreadable count should never silently look
clean.

**`src/renderer/src/components/UnfiledSalesBadge.tsx`** — a small,
presentational, fully-controlled badge (same pattern as
`ConnectivityBadges`: reads nothing itself, takes `count` and `onClick`
as props). Renders nothing before the first read completes (no flash of
a false zero); quiet slate pill at zero; a noticeable amber pill with a
plain count otherwise. Mounted in `App.tsx`'s header, next to the
existing connectivity badges, so it's visible on every screen without
opening Admin.

**Tap-to-open wiring** — `AdminScreen` gained an optional
`initialTab?: 'needsAttention'` prop, read once into its existing
`activeTab` `useState` initializer. `App.tsx` tracks a local
`adminInitialTab` value: tapping the badge sets `activeView('admin')`
and `adminInitialTab('needsAttention')` (gated on
`currentStaff.role === 'admin'`, since forcing `activeView` to `'admin'`
would otherwise bypass the nav button's own role gate — the same
defense-in-depth `AdminScreen`'s own doc comment already calls out); the
plain "Admin" nav button resets it back to `undefined` so an explicit
nav always lands on Overview as before. Since `AdminScreen` fully
unmounts whenever `activeView` isn't `'admin'`, this mount-time prop is
enough — no live re-trigger machinery needed for the one real case
(tapping the badge from Catalog/Orders).

**`NeedsAttentionPage.tsx`** — after any resend or PIN-correct-and-resend
that gets an IPC response (success or continued failure), also calls
`useUnfiledCountStore.getState().refresh()`, so the header count doesn't
wait out a full 30-second poll tick after an action taken from the page
that caused it.

## Finding 4 — the fix

- **Relabeled, not rebuilt.** `ConnectivityBadges.tsx`: "✓ Fiscal" →
  "✓ Fiscal Server", with its tooltip now reading "Fiscal server:
  Reachable. This does not confirm sales are filing. See the unfiled
  sales count for that." `ConnectivityModal.tsx`: "Fiscal Device" →
  "Fiscal Server" and a new one-line note shown only for this
  integration: "This only checks whether the fiscal server on this till
  responds. It does not confirm sales are being filed. See the unfiled
  sales count for that, or press Test Connection in Admin for the full
  device check." No new probe was added — "Test Connection" in Admin
  remains the one real device check, exactly as instructed.
- **Fixed the staleness bug**, since it was genuinely trivial: `main/
  index.ts`'s `checkFiscal` now reads
  `db.getIntegrationConfig('etims').baseUrl` fresh on every 30-second
  check instead of closing over the startup snapshot. One `SELECT`,
  already indexed, on a 30-second cadence — negligible cost, and it
  means an Admin server-address change takes effect on the very next
  reachability check rather than after a relaunch.

## Tests

- `tests/unfiledCount.test.ts` (4) — `describeUnfiledCount`'s zero/
  singular/plural/no-jargon cases.
- `tests/unfiledCountStore.test.ts` (6) — mirrors `productStore.test.ts`'s
  `window.api` stubbing and `connectivityMonitor.test.ts`'s fake-timer
  convention: initial state; `refresh()` sets the count; the count
  **decreases after a simulated resend** (two sequential `refresh()`
  calls returning 2 then 1); a failed refresh keeps the last known count
  instead of flashing zero; `init()` reads once and is idempotent across
  repeated calls; `init()` keeps polling on the interval without a
  manual refresh (`vi.advanceTimersByTimeAsync(30_000)` triggers a
  second real fetch).
- `tests/UnfiledSalesBadge.test.ts` (4) — mounted with `react-dom/client`
  and driven with real `.click()`, matching `VirtualKeyboard.test.ts`'s
  stated exception for a self-contained, stateless interactive widget:
  renders nothing at `count: null`; quiet text at zero; a plain count
  otherwise; `onClick` fires on tap.

No new test file for the static label changes in `ConnectivityBadges`/
`ConnectivityModal` — there's no pure logic behind a wording change, and
the project's convention (stated in `VirtualKeyboard.test.ts`'s own file
doc) is to test pure logic directly rather than add component-render
tests for static content.

```
$ npx vitest run tests/unfiledCount.test.ts tests/unfiledCountStore.test.ts tests/UnfiledSalesBadge.test.ts
 Test Files  3 passed (3)
      Tests  14 passed (14)

$ npm run typecheck
typecheck exit code: 0

$ npm test
 Test Files  75 passed (75)
      Tests  1106 passed (1106)
```

## Real-screen verification (not simulated)

Driven against the actual dev Electron app over Chrome DevTools
Protocol, against the real on-disk database, exactly as phase-94's
check was — this is the combined visual pass for both phases.

- One dev order was temporarily flipped to `waiting`, and the Admin PIN
  was temporarily set to a known test value, to populate the badge and
  reach the app (same discipline as phase-94: values captured before
  any change).
- **Header, before opening Admin**: an amber **"1 sale not filed"**
  badge appeared next to the relabeled **"✓ Fiscal Server"** badge —
  visible on the Catalog screen, no navigation required.
- **Tapping "1 sale not filed"** jumped in one tap straight to
  Admin → Needs Attention, landing on that tab directly (confirmed the
  tab itself was pre-selected, not just the Admin screen).
- **Clicking Resend** on the seeded row made a real HTTP call through
  the real provider against the (unreachable, dummy) device, failed
  honestly ("Fiscal device timed out on ReadStatus"), and the header
  count correctly **stayed at "1 sale not filed"** — proving the count
  doesn't move on a still-failing resend, only on a real fiscalization.
- The order was then set to `fiscalized` directly (simulating the device
  finally succeeding) and **Resend** clicked again: `resendFiscalization`
  correctly short-circuited (already-fiscalized check, no HTTP call —
  Rule 1 held), the row left the list, the empty state read "No sales
  need attention.", and the header badge flipped live to the quiet
  **"All sales filed"** pill — all from one real IPC round trip.

**A mistake made and disclosed during cleanup:** restoring the seeded
order afterward, the snapshot taken before this check only recorded
`fiscal_status`/`fiscal_error_reason`/`fiscal_error_kind`/
`fiscal_data_issue` (mirroring phase-94's snapshot shape) — it did not
capture `fiscal_invoice_number`/`fiscal_qr_code`, both of which the
"simulate the device succeeding" step above had also written to. The
restore script then blanked those two columns on **all three** dev
orders, not just the one touched this session. Orders #1 and #3 now show
a `fiscal_fiscalized_at` timestamp with a `null` invoice number and QR
code — a shape the real fiscalization code never produces on its own
(`setOrderFiscalInfo` always sets all three together), which means real
values that existed before this session very likely were overwritten and
cannot be recovered from anything captured in this session's logs.

Impact, stated plainly: these are Ksh 1.00 dev-machine test sales from
earlier phase screen-verification passes, never filed with a real
device (real device credentials have not been available at any point in
this engagement), so no real KRA filing or branch data is affected, and
nothing in the shipped code changed. It is dev-database data loss caused
by not snapshotting every field a script went on to modify, and it is
reported here rather than smoothed over, per this project's standing
rule to show real evidence rather than assert good outcomes.

## The four rules

- **Never file twice** — confirmed live: resending an already-fiscalized
  row made zero HTTP calls.
- **Never print a valid-looking receipt for an unfiled sale** —
  untouched; no printer code in this phase.
- **Never silently lose an unfiled sale** — this phase is the last piece
  of that fix: the count is now visible without opening anything, not
  just on a page someone has to know to open.
- **Never block the till** — the badge and count live in the header/
  Admin only; checkout is untouched.

## Visual-check list (real touch screen) — covers phase-94 and phase-95 together

- [x] The unfiled-count badge is prominent and legible at both `0`
  ("All sales filed", quiet) and `>0` (noticeable, plain count) —
  confirmed on the dev screen above; still worth a look at the branch's
  actual screen size/DPI.
- [x] Tapping the badge opens Needs Attention directly — confirmed.
- [x] The "✓ Fiscal Server" relabel doesn't crowd out the other header
  badges — confirmed, same layout as before, one word added.
- [ ] **Needs a human on the real till**: touch target size/spacing for
  the new badge and the Needs Attention page's Resend/Correct PIN
  buttons at the branch's actual screen size and DPI (carried over from
  phase-94 — not newly introduced, but not yet re-checked at real size).
- [ ] **Needs a human on the real till**: the on-screen keyboard opened
  from Correct PIN & Resend doesn't cover the Save & Resend button at
  the branch's actual screen size (phase-94's keyboard screenshot showed
  clear space at this dev window size; unconfirmed at the real one).
- [x] Empty state ("No sales need attention.") reads cleanly — confirmed.

## Cleanup

The app was fully quit and every DB/vault/PIN value this check touched
was restored from a snapshot taken beforehand, except for the
`fiscal_invoice_number`/`fiscal_qr_code` loss on orders #1 and #3
described above, which is not recoverable.
