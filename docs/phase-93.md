# Phase 93 — Go-live prep, Part 5 addition: setup-gate polish

Two small changes to `EtimsSetupGate.tsx`, folded into go-live prep ahead
of the Part 5 README/close-out.

## 1. Pre-fill the server address, and only that field

`EMPTY_FORM`'s `baseUrl` now starts as {@link DEFAULT_ETIMS_BASE_URL}
instead of blank. `deviceIp`/`devicePort`/`password` stay blank.

The distinction is not cosmetic, so it is written on the constant, not
just in this doc: `localhost` is genuinely correct for the overwhelming
majority of installs — the fiscal server runs on the till itself — so
showing it ready-to-go is a real default. A device IP, port or password
varies per physical Control Unit; pre-filling one would be exactly the
silent-wrong-default trap Part 4 removed (`docs/phase-92.md` §2). Its
help line changed to match: *"Already set for this till. Only change it
if the fiscal server is on another machine."*

## 2. Cut the paragraph

The gate's intro paragraph — two sentences under the title, including
"Your supplier or IT contact has these" — is removed. It was installer
guidance sitting on the screen a cashier or manager meets, not a
per-field help line. The gate now reads exactly as: a title, four fields
each with one short help line, an error line when something's wrong, and
the action button. No prose block remains anywhere on it.

Nothing about where to get the real values was lost — that belongs in
`docs/GO_LIVE.md` (Part 5), which is written for whoever installs the
till, not for the screen itself.

## Verified on the real app

Driven the same way as Part 3 — Electron's own remote-debugging port,
Node 24's built-in `WebSocket`, no new dependency:

- Fresh gate: `baseUrl` input value is `http://localhost:4444/` (not a
  placeholder — the actual field value, shown in white); `deviceIp`,
  `devicePort`, `password` are empty, showing only their grey placeholder
  text.
- Filled in only the three device fields, left the pre-filled address
  untouched, pressed **Save & Continue**: the gate lifted, the
  connectivity badge flipped to **✓ Fiscal**, and the cashier screen
  loaded.
- `getIntegrationConfig('etims')` afterward returned exactly
  `{baseUrl: 'http://localhost:4444/', deviceIp: '192.168.1.77',
  devicePort: '8000'}` — the untouched pre-fill saved correctly, and (per
  Part 3) no password key on the row.
- Screenshot confirms no paragraph text remains: title, four
  label-input-help groups, button.

No logic changed outside this component, so no test in the suite could
regress from it — `npm run typecheck` and `npx vitest run` were re-run
anyway (71 files / 1089 tests, clean) rather than assumed.

## Verification

- `npm run typecheck` (node + web): clean.
- `npx vitest run`: 71 files / 1089 tests, 0 failures.
- On-screen: above.
