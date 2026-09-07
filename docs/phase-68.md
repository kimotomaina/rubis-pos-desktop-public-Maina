# Phase 68 / Step 3 — Make `defVer` gate the VAT-class routing (finding #1)

Builds on [phase-65.md](phase-65.md)'s audit (finding #1: partial — the
`defVer` safeguard was real but passive, a bare `console.warn` that never
gated anything). Steps 0–2 (phase-65 / 66 / 67) are done. This is Step 3,
low-risk, no STOP (Step 4, error taxonomy, is the next STOP).

Source authority: the VIL manual is **older** (its own `settings()` shows
`defVer 2112311201`) and shows `SellPLUfromExtDB` itself taking VAT classes
A-E on one command. The device target for this project is `2509041522`,
whose defs restrict that command to A-only, with `SellPLUfromExtDB_HS` for
B/C/D/E. That restriction is the entire basis of `resolveSellCommand`'s
routing — the point of this step is that the routing is valid *only* for
`2509041522`, so a mismatch must be visible. The 2509041522 routing itself
is **unchanged** — not widened to the manual's A-E.

## Audit (read-only, immediately before applying)

- `getSettings` in `http-client.ts` (was ~L161-180): confirmed it reads
  `<defVer>` and, before this step, only did
  `if (defVer && defVer !== EXPECTED_DEF_VERSION) console.warn(...)` — no
  structured/observable state, and the result never gated anything
  downstream.
- `resolveSellCommand` in `real-etims-provider.ts` (~L793-811): confirmed
  the `A → SellPLUfromExtDB` / `else → SellPLUfromExtDB_HS` routing and its
  existing `// VERIFY-ON-DEVICE` comment (the routing rule itself is
  inferred from the argument lists, not stated outright in vendor prose —
  unrelated to and unaffected by this step).
- Searched for an existing device health/status channel to reuse (`grep`
  for `diagnos|health|deviceStatus` across `src/`) — found none: no
  dedicated status method or IPC channel exists. `readStatus()` (private,
  gates `submitInvoice` step 2) computes device reachability but never
  attaches its data to anything the caller can see. The one channel that
  *does* already carry session-level diagnostic state out to a caller is
  `FiscalInvoiceResult` itself — `cuSerialNumber` (phase-67) and
  `fiscalizedAtSource` are both exactly this shape: best-effort, read once
  per session, surfaced as an optional field on every `submitInvoice`
  result. That's the channel this step reuses — no new IPC, no new method.
- Confirmed `EXPECTED_DEF_VERSION` exists in `http-client.ts` and equals
  `'2509041522'`.
- Confirmed via the real captured fixture (`tests/fixtures/wire/settings-ok.xml`,
  used by `tests/http-client.test.ts`) that a real server build's `<defVer>`
  can be genuinely blank (`<defVer></defVer>`) — grounding the "`unknown`
  is not `mismatch`" rule in an actual capture, not a hypothetical.

## Applied

1. **`http-client.ts`**: added `DefVersionStatus` (`'match' | 'mismatch' |
   'unknown'`) and a pure `checkDefVersion(defVer)` function, split out
   from `getSettings` so the three-state logic is unit-testable without
   mocking HTTP. `getSettings` now:
   - computes `defVerStatus = checkDefVersion(result.data.defVer)` and
     writes it onto `result.data.defVerStatus` (the same
     `Record<string, string>` the caller already reads `defVer`/`clientID`
     etc. from — no new return shape, no ripple through `ensureSettings`'s
     cached-promise type);
   - on `'mismatch'` only, logs one structured `console.warn` (a message
     string plus a `{ defVer, expectedDefVer, defVerStatus }` object) that
     names the exact consequence (`SellPLUfromExtDB` vs `_HS` routing may
     be rejected/misrouted) instead of the old bare warning string;
   - `'unknown'` (blank/absent `<defVer>`) and `'match'` log nothing —
     unchanged from before for the common case.
2. **`real-etims-provider.ts`**:
   - `submitInvoice` reads `defVerStatus` off the already-cached
     `ensureSettings()` result (`settingsResult.data?.defVerStatus`,
     defaulting to `'unknown'` if absent) right after the settings step
     succeeds, and includes it on the returned `FiscalInvoiceResult` —
     same precedent as `cuSerialNumber`. No new promise/cache: it rides
     the existing `settingsPromise`, so it's naturally read once per
     session, not once per sale.
   - `resolveSellCommand`'s doc comment gained a paragraph stating the
     routing is valid **only** for `defVer=2509041522`, is not re-checked
     per call, and depends on `settings()`'s cached `<defVer>` comparison
     — pointing at `FiscalInvoiceResult.defVerStatus` as where that state
     surfaces.
   - **No behavior change** to the routing itself, and no hard block on
     `mismatch` — the sale proceeds either way, per the step's explicit
     constraint.
3. **`etims.ts`**: `FiscalInvoiceResult` gained an optional
   `defVerStatus?: DefVersionStatus`, documented with the same "absent on
   providers that don't surface it (e.g. the mock)" language as
   `cuSerialNumber`.
4. **Carry-over fix from the Step 2 review**: added
   `ReadCUnumbers: 'readcunumbers-ok.xml'` to `mock-zfplab-server/engine.ts`'s
   `DEFAULT_FIXTURE_MAP` (one line). Before this, `ReadCUnumbers` fell
   through the engine's lenient "unknown command → `success-ack.xml`"
   default, so anything driving the real provider against the mock server
   (rather than the inline per-test `postXml` mocks in
   `realEtimsProvider.test.ts`, which already stub `ReadCUnumbers`
   directly) would always get `cuSerialNumber: undefined`. Now it serves
   the real fixture, so the serial-number flow is end-to-end against the
   mock server too.

## Tests added

- `tests/http-client.test.ts`:
  - `checkDefVersion`: 3 tests (`'match'` on equal, `'mismatch'` on the
    VIL manual's older `2112311201`, `'unknown'` on blank/`undefined`).
  - `getSettings`: 3 tests — `defVerStatus` surfaces as `'match'` (no
    warning), `'unknown'` on a blank `<defVer>` (no warning — confirms
    "blank isn't a mismatch" end-to-end through the real XML parser), and
    `'mismatch'` (asserts the warning fires with the expected structured
    payload).
- `tests/mockZfplabServer.test.ts`: 1 new test confirming `ReadCUnumbers`
  now routes to `readcunumbers-ok.xml` (the `SerialNumber`/`PINnumber`
  fixture), not the generic default ack.
- `tests/realEtimsProvider.test.ts`, new `describe('defVer gating
  (phase-68, finding #1)', ...)` (4 tests): `defVerStatus` surfaces as
  `'unknown'` when `settings()` echoes no `<defVer>`; `'match'` on the
  expected value; `'mismatch'` on a different value *and the sale still
  completes* (never a hard block) *and* the structured warning fires; and
  the status is read once per session (from the same cached `settings()`
  handshake), not re-derived per sale.
- No existing assertions needed updating — `defVerStatus` is a new,
  additive field; every existing test's default `get()` mock returns no
  `<defVer>`, which resolves to `'unknown'` and logs nothing, so no prior
  behavior or exact-sequence assertion changed.

## Verification

- `npx vitest run` (full suite): **56 files / 822 tests** (811 prior + 11
  new, 0 regressions, 0 loosened fixtures).
- `npm run typecheck` (node + web): clean.

## VERIFY-ON-DEVICE

- The go-live policy for a **real** `defVer` mismatch (warn-and-proceed,
  current behavior, vs. hard-block) is deliberately left undecided in this
  POC — recorded in `docs/KNOWN_GAPS.md` as a new tracked gap, to be
  closed once a live device/server confirms what `defVer` production
  actually reports.
- The routing rule itself (`SellPLUfromExtDB` A-only vs `_HS` for
  B/C/D/E) already carried a `VERIFY-ON-DEVICE` from phase-65/66 and is
  untouched by this step — nothing new to verify there.

## Status

- **Applied**: `DefVersionStatus`/`checkDefVersion` in `http-client.ts`,
  `getSettings` computing + logging it, `FiscalInvoiceResult.defVerStatus`,
  `submitInvoice` wiring (reusing the cached `settings()` handshake, no new
  promise), the `resolveSellCommand` doc comment, and the
  `ReadCUnumbers` mock-engine carry-over fix.
- **Not done, by design**: no hard block on mismatch, no new config knob,
  no new IPC/status method — all explicitly out of scope for this step.
- No STOP required — proceeding to Step 4 (error taxonomy) unless you'd
  like to check in first.
