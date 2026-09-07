# Phase 90 — Go-live prep, Part 2: mock provider out of production

Closes blocker 1 from `docs/phase-89.md`: a fresh install ran the mock
fiscalization provider, printed `KRA-MOCK-` invoice numbers on receipts
for sales that were never filed, and skipped the eTIMS setup gate while
doing it. The mock server and every test are retained — the suite grew,
it did not shrink.

## The approach

Four independent layers, so no single regression re-opens the hole:

1. The mock provider lives in its own module and is reachable only
   through a dev-only dynamic import.
2. A packaged build refuses to select it at runtime, whatever the config
   says.
3. Neither default (env-absent, nor DB-seed-on-first-run) is mock.
4. The build fails if the mock's code reaches `out/main` anyway.

## 1. Split: `mock-etims-provider.ts`

`MockFiscalizationProvider` and `MOCK_ETIMS_DELAY_MS` moved out of
`etims.ts` into a new `src/main/services/integrations/mock-etims-provider.ts`.
`etims.ts` now holds only the contract — `FiscalizationProvider`,
`FiscalInvoiceRequest`/`Result`, `FiscalSubmitOutcome`,
`FiscalFailureKind`, `CreditNoteDetails` — which is what the real
provider and every caller actually depend on. Behavior is byte-identical;
`cancelInvoice` gained its `details` parameter explicitly (previously
satisfied structurally) so the class states the interface it implements.

`tests/etims.test.ts` re-points its import. Nothing else changed there.

## 2. `fiscal-provider-factory.ts`

The selection was an inline ternary in the bootstrap
(`main/index.ts:560-580`). It is now
`resolveFiscalizationProvider(options)` in a new
`src/main/services/fiscal-provider-factory.ts` — one testable function
for the one decision that can breach Rule 2.

```ts
if (options.mockRequested && !options.isPackaged && import.meta.env.DEV) {
  const { MockFiscalizationProvider } = await import('./integrations/mock-etims-provider.js')
  ...
}
return new RealFiscalizationProvider(options.realOptions)
```

`isPackaged` is passed in as a plain boolean rather than importing
`app` from Electron, so the module has no Electron dependency and unit
tests can drive both branches. A packaged build that asked for the mock
gets the real provider **and one warning** — the override is never
silent.

`import.meta.env.DEV` is what lets Rollup drop the import; typechecking
it needed no new types (`tsconfig.node.json` already pulls in
`electron-vite/node`).

## 3. Both defaults flipped to real

Two places defaulted to mock, and the second one defeated the first.

- `main/index.ts:506` — `(process.env.VITE_USE_MOCK_ETIMS || 'true')`
  became `|| 'false'`, and the comparison `!== 'false'` became
  `=== 'true'`. Only the literal `'true'` now selects the mock.
- **`configMigration.ts` — the one that actually mattered.**
  `migrateEnvConfigToDatabase` runs at `main/index.ts:317`, *before* the
  provider is resolved, and its `seed` helper wrote
  `mock_etims_enabled = 'true'` whenever the env var was absent
  (`envValue !== 'false'`). On a fresh install with no `.env` key that
  put mock into the DB row, and the DB row wins over the env default —
  so flipping `:506` alone would have changed nothing. Worse, that
  seeded `true` also bypasses `checkEtimsCompletion`
  (`etimsSetup.ts:43-45`), so an unconfigured till would have reached
  checkout with no setup gate even in a packaged build, where the
  provider is real.

  `seed` now takes an explicit `mockWhenUnset` per key: `true` for
  M-Pesa (a fresh till must never charge a real customer by accident),
  `false` for eTIMS. An explicit `VITE_USE_MOCK_ETIMS=true` in a
  development `.env` still works.

The renderer mirrored the same wrong default and is fixed to match:
`AdminScreen.tsx:138` `useState(true)` → `false`, and `:308`
`!== 'false'` → `=== 'true'`.

## 4. The shipped escape hatches, removed

- **`EtimsSetupGate.tsx`** — the "Use Mock eTIMS for Testing" button,
  its `handleUseMockEtims` handler and `switchingToMock` state. This was
  the sharpest edge in the audit: a no-PIN control, on the shipped setup
  gate, that switched a production till to the mock and restarted it.
- **`main/index.ts`** — the `setup:use-mock-etims` IPC handler it called.
- **`preload/index.ts` + `window.d.ts`** — the `useMockEtimsForTesting`
  bridge entry.
- **Admin System tab** — the "Use Mock eTIMS" checkbox is wrapped in
  `import.meta.env.DEV`, so Vite drops it from the renderer bundle. In a
  packaged build the factory refuses mock anyway, and a visible control
  that silently does nothing would be worse than no control.

Verified against the built bundles: `Use Mock eTIMS` appears 0 times in
`out/renderer/assets/*.js` and `use-mock-etims` 0 times in
`out/preload/index.js`.

## 5. `scripts/verify-no-mock-provider.cjs`

Wired as a `postbuild` npm script, so it runs on `npm run build` and
therefore on `npm run dist` too. It fails the build if any file under
`out/main/` contains `KRA-MOCK-` or `MockFiscalizationProvider`.

This is the guarantee that does not rest on trusting tree-shaking — and
it earned its place immediately: **the first run failed.** The mock's
code was correctly dropped (`KRA-MOCK-` count 0), but the string
`MockFiscalizationProvider` survived inside a startup debug log line
this part had just written. That was a false positive rather than a real
leak, so the fix was to reword the log ("using the mock fiscalization
provider (development only)") rather than weaken the check. The class
name remains in `fiscal-provider-factory.ts`'s DEV branch deliberately —
it is the canary: if that branch ever stops being dropped, the build
fails.

## 6. New test: real provider against the mock server

The brief asked for "real provider → mock server → fiscalized" to keep
passing. That test did not exist. `tests/mockZfplabServer.test.ts` tests
the *server* with raw `fetch`, and `tests/fiscalIntegration.test.ts`
uses a hand-stubbed `httpClient` — neither drives real wire end to end.
(The stale doc comments in `mock-zfplab-server/run.ts` and `engine.ts`
claiming otherwise are corrected.)

`tests/mockServerHappyPath.test.ts` (3 tests) boots the engine on an
ephemeral port and drives a real `RealFiscalizationProvider` at it over
a real socket: a sale fiscalizes and returns the fixture's
`InvoiceNum` `0000000000000000042`; two sales open the device session
exactly once (`settings()` called once, not per sale) and send
`OpenInvoiceWithFreeCustomerData` + `CloseReceipt`; and the invoice
number never matches `/MOCK/i`, proving the real provider reports only
what the device returned rather than minting anything itself.

It carries `// @vitest-environment node`. Under the suite's default
`jsdom`, axios selects its XHR adapter, which cannot reach a real
socket — the requests arrived at the server but every response came back
as "unreachable". Everything else in the file is the production code
path.

## 7. Tests

- **`tests/fiscalProviderFactory.test.ts`** (new, 6 tests): packaged +
  mock requested returns the real provider; that override warns; not
  requested returns real in both packaged and unpackaged builds;
  unpackaged + requested is the only route to the mock; constructor
  options are forwarded (asserted through the resolved axios
  `baseURL`).
- **`tests/mockServerHappyPath.test.ts`** (new, 3 tests) — above.
- **`tests/configMigration.test.ts`**: the "seeds both mock flags as
  true" test now asserts the two seed differently and says why; one new
  test proves an explicit `VITE_USE_MOCK_ETIMS=true` still selects the
  mock in development.
- **`tests/etims.test.ts`**: import path only.

`.env.example` and the `mock:zfplab` banner are corrected — they told
operators to set `VITE_USE_MOCK_ETIMS=false`, which is now the default,
and referenced an `ETIMS_ZFP_SERVER_URL` seam that never landed.

## Verification

- `npx vitest run`: **69 files / 1014 tests** (67/1004 going in, +2
  files, +10 tests), 0 failures.
- `npm run typecheck` (node + web): clean.
- `npm run build`: `✓ Confirmed: the mock fiscalization provider is not
  in out/main.`
- Grep of the built bundles: no mock UI in the renderer, no
  `use-mock-etims` channel in the preload.

## What this part deliberately did not do

The real provider still falls back to `DEFAULT_DEVICE_PASSWORD =
'Password'` when unconfigured — blocker 2 from the audit. That is Part
4's job, together with the wire `Accept` header fix. Nothing here
changed the wire or the device-config resolution.
