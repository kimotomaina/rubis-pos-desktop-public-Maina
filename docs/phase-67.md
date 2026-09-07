# Phase 67 / Step 2 — Read & cache the CU serial number (finding #3)

Builds on [phase-65.md](phase-65.md)'s audit (finding #3: confirmed real —
`ReadCUnumbers` defined in the contract and the authoritative PDF, never
called anywhere in the provider).

## Audit (read-only, immediately before applying)

- `tremol-contract.json`'s `ReadCUnumbers`: `cmdByte: "0x60"`, no args,
  response `SerialNumber` (Text, maxLen 20) + `PINnumber` (Text, maxLen 11).
- `protocol_description_KE_CU_2509041522.pdf` §2.4.1 confirms the same
  shape verbatim (already cited in phase-65.md).
- Confirmed `settings()`/`ensureSettings()` is **never called explicitly at
  startup** — `grep -n "ensureSettings\|fiscalizationProvider\." src/main/index.ts`
  shows only `submitInvoice`/`cancelInvoice`/etc. wired to IPC; the "once
  per session" behavior for `settings()` is achieved entirely by
  `ensureSettings()`'s own lazy caching (`settingsPromise`), triggered by
  the *first* `submitInvoice` call, not a separate app-boot step. `ReadCUnumbers`
  follows the same pattern for consistency (KISS — no new startup hook).
- Confirmed `FiscalInvoiceResult` (`etims.ts`) had no serial-number field,
  and `FiscalEndpointPaths` had no `readCUnumbers` entry.

## Applied

1. **`fiscal-validate.ts`/`fiscal-sanitize.ts` untouched** — this step is
   independent of Step 1.
2. **`FiscalEndpointPaths`/`DEFAULT_FISCAL_ENDPOINTS`** gained a
   `readCUnumbers` entry (`''`, same single-endpoint convention as every
   other command).
3. **New cached field + method**, mirroring `settingsPromise`/`ensureSettings`
   exactly: `cuNumbersPromise` + `private async ensureCUNumbers()`. Sends
   the arg-free `ReadCUnumbers` command via the existing `sendCommand`
   (so it still benefits from the Code-53 re-settings-and-retry logic),
   extracts `SerialNumber`, and **does not cache a failure** — the next
   sale retries, same philosophy as `settingsPromise`.
4. **Wired into `submitInvoice`**: called right after `ensureSettings()`
   succeeds, before `ReadStatus`. Deliberately **not** one of the "Step
   N/7" workflow steps (doesn't renumber `TOTAL_WORKFLOW_STEPS` or any
   existing step's log line) — it's session-level info like `settings()`
   itself, not part of the PDF's per-sale command sequence. **Best-effort**:
   a failure only logs a `console.warn` and leaves `cuSerialNumber`
   `undefined` on the result; it never fails the sale, same philosophy
   already applied to `ReadDateTime` (step 7).
5. **`closeServerConnection()`** now also clears `cuNumbersPromise` (in
   addition to the existing `settingsPromise` clear), for the same shutdown
   hygiene reason.
6. **`FiscalInvoiceResult`** (`etims.ts`) gained an optional `cuSerialNumber?: string`,
   documented as sourced from `ReadCUnumbers`, absent when the read failed
   or on providers that don't surface it (e.g. the mock).
7. **New ground-truth fixture** `tests/fixtures/wire/readcunumbers-ok.xml`
   — built from the contract + PDF (not captured live; the device never
   returned a Code-0 response during this project's live sessions), ENVELOPE_A
   skin, `SerialNumber`/`PINnumber` in contract order, visibly-synthetic
   value (`MOCK-CU-SERIAL-0001`). Round-tripped through the real parser in
   `tests/wireFixtures.test.ts` (new `describe` block), asserting both
   fields respect their contract `maxLen`.

## Tests added

- `tests/wireFixtures.test.ts`: 1 new test (fixture round-trip + length
  bounds).
- `tests/realEtimsProvider.test.ts`, new `describe('ReadCUnumbers session
  read ...')` block (4 tests): sends the arg-free command and surfaces
  `cuSerialNumber`; reads it once per session across two sales (not once
  per sale — mirrors the existing `settings()` session test exactly); never
  blocks a sale on failure; retries on the *next* sale after a failed one
  (doesn't cache the failure).
- Two **pre-existing** exact-sequence assertions needed updating, since
  `ReadCUnumbers` is now a real, ordered part of every session's first call:
  the "drives the workflow in order" test and the Code-52-retry test both
  now expect `ReadCUnumbers` as the first command. This is the correct fix
  (the assertions describe *the actual wire sequence*, which genuinely
  changed) — not a loosened assertion.

## Verification

- `npx vitest run` (full suite): **56 files / 811 tests** (806 prior + 5
  new, 0 unexplained regressions — only the two sequence assertions above
  needed updating, both legitimately).
- `npm run typecheck` (node + web): clean (one real type issue caught and
  fixed along the way — the `.then()` callback feeding `cuNumbersPromise`
  needed an explicit `ServiceResult<{ serialNumber: string }>` return
  annotation so both branches agree on type; without it TS inferred a
  union including the raw `DeviceResult`, which then cascaded into a
  false "possibly null" error on the cached-read path).

## Status

- **Applied:** endpoint entry, cached session-read method, `submitInvoice`
  wiring (best-effort, unnumbered), `FiscalInvoiceResult.cuSerialNumber`,
  one new wire fixture, `closeServerConnection` shutdown-hygiene addition.
- **No new `VERIFY-ON-DEVICE`** beyond what's already tracked — `ReadCUnumbers`'s
  arg-free shape and response fields are wire-confirmed from the PDF/contract
  directly, not inferred. Whether the real device's serial number prints
  correctly on a receipt is a print-layer concern outside this step's scope.
- No STOP required for this step — proceeding to Step 3 (`defVer`-gated VAT
  routing) unless you'd like to check in first.
