# Phase 169-1 - Three fixes from docs/phase-169 section 7

- **Date:** 2026-09-27
- **Requested:** Three separate commits. A (urgent): check:fit must never send anything real, whatever else is true of the copied data. B: Retry Sync refuses a voided sale and resets attempts on reuse. C: a thrown push is recorded as a failure, not left as an unhandled rejection. Hard rules: no fiscal-provider or payment-gate changes; no Shopify or device calls in tests; no SQL on real data.
- **Outcome:** Implemented. Three commits, stopped for review.
- **Branch / base commit:** staging @ fe47899 (docs/phase-169)

| Commit | Sha | Summary |
| --- | --- | --- |
| A | `de9e87f` | check:fit sending disabled by a flag, plus a second, independent layer in check-fit.mjs itself |
| B | `b5f9538` | Retry Sync refuses a voided sale; resets attempts on reuse |
| C | `9dfde7f` | A thrown push is caught, recorded as a failure, and the loop continues |

**Hard rules kept:** no file under `real-etims-provider.ts`, `checkout.ts`, `PaymentModal.tsx`, `PosCheckoutPanel.tsx`, or any M-Pesa provider was touched. No Shopify or device call in any test: every push is a `vi.fn()` stub or an injected fake; the one real-SQLite test in commit C never reaches a network call, only `RubisDatabase`. No SQL against real data: every test uses `:memory:`.

---

## Commit A (urgent) - check:fit must never send anything

### A1. Audit: how a real launch differs from a check:fit launch today

`scripts/check-fit.mjs` launches the actual built app (`out/main/index.js`) against a **copy** of the real till's database and credential vault (`copyAppState`, `check-fit.mjs:548-579` before this change). Before this commit, that copy ran with every background sender live: the Shopify sync engine, the fiscal engine, and (on a `manual`-mode till) the M-Pesa SMS poller all started normally (`index.ts:930-937` old numbering), and every IPC handler that can push, print, or file worked exactly as on a real till. Nothing stopped a queued sale in the copy from reaching the real Shopify store, or a queued fiscal retry from reaching the real device, if the copy's credentials happened to be real (which they are, since the copy is taken from the real till).

### A2. Every outbound sender in `src/main`, and how each is closed

| Sender | Where it fires | How it is closed in this commit |
| --- | --- | --- |
| Shopify `orderCreate` | `sync-engine.ts:105`, reached only through `tick()` (`sync-engine.ts:80-120`); the only caller of `pushOrderToShopify` is `index.ts`'s `pushOrder` wrapper (unchanged) | `tick()` is never entered automatically: `engine.start()` is skipped (`index.ts:935-938`) and the monitor's online-transition callback that would otherwise call `engine.notifyOnline()` is also gated (`index.ts:917-925`) - `notifyOnline()` is a method on the already-built `engine` object, reachable regardless of `.start()`, so it needed its own guard. The one remaining trigger, `checkout.ts`'s own `engineTick()` after a checkout, can never fire because `orders:checkout` refuses first (below). |
| Fiscal device `submitInvoice` | reached from `checkout.ts` (via `orders:checkout`), the fiscal engine's own tick, `fiscal:resend`, and `fiscal:correct-pin-and-resend` | Same engine-start and monitor-callback guards as Shopify (`fiscalEngine.start()`/`fiscalEngine.notifyOnline()`, `index.ts:924`, `:937`). The two IPC handlers refuse outright (below). |
| M-Pesa STK push (`integrations:mpesa-stk-push`) | `index.ts:1250-1254` (unchanged), calls `mpesaProvider.initiateStkPush` | **Deliberately not guarded** - this is the payment gate itself, out of scope per the hard rule. It also needs an explicit "Send STK Push" click check:fit's own script never makes (confirmed: no such click exists in `check-fit.mjs`), so it never fires today regardless. |
| M-Pesa STK status poll (`mpesa:query-status`) | only reachable after a real STK push has been sent | Moot: the STK push above never fires, so this never has anything to poll. |
| SMS/gammu inbox | `mpesa-sms-inbox.ts` - reads confirmation files, sends nothing | Read-only by design, but `mpesaSmsInbox.start()` is skipped anyway (`index.ts:970-975`), matching the task's own "or any other background sender" wording literally. |
| Printer (receipt and Z-report) | both routes share the single `receipt:print` handler (`index.ts:2522-...`) | Refused for a **real** printer only; the mock printer touches no hardware, so it is let through (`index.ts:2525-2532`, `guardCheckFitSending(..., { skipWhenMock: printerSettings.mock === true })`). check:fit never calls `receipt:print` at all today (confirmed by search), so this has no visible effect on the current run either way. |
| Updater `checkForUpdates` | only from the `updater:check` button (`index.ts:3106-3109` unchanged) | Not guarded: never called automatically, and check:fit never clicks "Check for Updates". Read-only (queries GitHub's release feed; downloads nothing unless a person then clicks install). |
| `config:test-mpesa` / `config:test-etims` | Admin screen "Test Connection" buttons only | Not guarded: diagnostic reads, never called automatically, and check:fit never clicks either button. |

### A3. The primary guard

Two new, pure, unit-tested functions in `src/main/lib/checkFit.ts` (which exists specifically because `main/index.ts` imports Electron at module load and cannot itself be unit tested - the same constraint every existing check:fit hook in this file already works around):

- `resolveCheckFitSendingDisabled(raw)` (`checkFit.ts:41-43`) - reads `RUBIS_CHECK_FIT`, unset on every real launch.
- `guardCheckFitSending(sendingDisabled, options?)` (`checkFit.ts:64-71`) - the one decision every sending IPC handler makes: refuse with a plain message, or (for the printer only) let a mock job through.
- `shouldStartBackgroundSenders(sendingDisabled)` (`checkFit.ts:83-85`) - gates the three `.start()` calls.

`index.ts:482-485` reads the flag once, right after `db.init()`, and logs the one required line: `[rubis-pos] check:fit mode: all sending disabled.`

Wired in:
- `index.ts:917-925` - the network monitor's online-transition callback.
- `index.ts:935-938` - `engine.start()` / `fiscalEngine.start()`.
- `index.ts:970-975` - `mpesaSmsInbox.start()`.
- `index.ts:1144-1145` - `orders:checkout`.
- `index.ts:2348-2349` - `orders:retrySync`.
- `index.ts:2380-2381` - `fiscal:correct-pin-and-resend` (see A4).
- `index.ts:2416-2417` - `fiscal:resend`.
- `index.ts:2529-2532` - `receipt:print` (with the mock exception).

### A4. One handler added beyond the task's named four

`fiscal:correct-pin-and-resend` (`index.ts:2373-2402`) resends to the real fiscal device through the exact same `submitInvoice` path as `fiscal:resend` - it corrects a PIN first, then calls the same guarded resend logic. It was not named in the task's list of four, but leaving it open would mean a real fiscal command could still be sent in check:fit mode by a different button than the one named. Guarded the same way, flagged here for your review; it is a two-line addition at the IPC boundary, not a change to `real-etims-provider.ts` or to `resendFiscalization`/`correctPinAndResend` themselves.

### A5. Belt and braces in `check-fit.mjs`

**First attempt (reverted): stripping credentials from the copy.** `secret-vault.json` holds every credential this app stores (the Shopify Admin API token and the fiscal device's TCP password). Not copying it at all makes `resolveShopifyToken` resolve `{ token: null }` (secretStore.ts:191-199) and makes `RealFiscalizationProvider.isConfigured()` false (real-etims-provider.ts:757-759, `deviceIp && devicePort && password`), which `submitInvoice` checks **before any HTTP call** (real-etims-provider.ts:868-871's own doc comment: "report it before any HTTP call rather than sending a guessed password").

This was tried, and it broke the main sweep. **Found empirically**, not guessed: with no vault, `isConfigured()` also being false made this app's own `EtimsSetupGate` onboarding screen replace the normal catalog view with "Set up the fiscal device" on every launch - `check:fit`'s main sweep logs in fine but then can never find `"COMPLETE SALE"`, so all 9 cases failed with "could not reach the POS/catalog screen". Confirmed with a standalone CDP diagnostic reproducing exactly this, and confirmed the fix below reaches `"COMPLETE SALE"` again. The forced-screen and synthetic cases (`runForcedScreenCase`/`runOnboardingCase`) never caught this, because they render their target screen directly and never depend on reaching the normal catalog.

**What is actually in this commit: redirect the address, keep the credentials.** `sanitizeCopiedFiscalAddress` (`check-fit.mjs:494-537`) rewrites the copied database's `etims` integration row so `deviceIp`/`devicePort`/`baseUrl` point at `127.0.0.1:1` (`check-fit.mjs:490-491`, `UNREACHABLE_HOST`/`UNREACHABLE_PORT`) - a closed loopback port nothing ever answers on. The device password is left exactly as copied (still real), so `isConfigured()` reads exactly as it does on the real till and the onboarding gate behaves exactly as it already does there - but any command that did reach `submitInvoice` would fail to connect, never reach a real device. Called from `copyAppState` itself (`check-fit.mjs:576`), so both of its call sites (`runCase`, `runForcedScreenCase`) get it automatically.

The Shopify side needs no database rewrite: `childEnv.VITE_SHOPIFY_STORE_URL` is set to the same unreachable address (`check-fit.mjs:645`, `:827`) before every spawn. `resolveShopifyStoreUrl` (shopify.ts) always prefers this env var over the copied database's own stored URL, and dotenv (`loadEnvFile`, `index.ts:26-28`) never overwrites a variable already present in the child's environment, so this wins over anything in the real `.env` too. Confirmed in the diagnostic: `products:fetch` attempted the real fetch, got `Store unreachable (127.0.0.1:1)`, and fell back to the cached catalog exactly as this app's own existing offline-fallback behaviour already does.

`RUBIS_CHECK_FIT='1'` is set on every spawn (`check-fit.mjs:638`, `:825`), covering `runCase` and, through the shared `launchAndConnect` helper, `runForcedScreenCase` and `runOnboardingCase` too.

### A6. Tests

`tests/checkFit.test.ts` (new describes, all pure-function unit tests):
- `resolveCheckFitSendingDisabled`: unset → off; empty string → off; `'1'` → on; any other non-empty value → on.
- `guardCheckFitSending`: lets a request through when not disabled; refuses with the plain message when disabled; the mock exception lets a request through even when disabled; the mock exception is irrelevant when not disabled.
- `shouldStartBackgroundSenders`: true when not disabled; false when disabled.

**Mutation (as instructed):** changed `shouldStartBackgroundSenders` to `return true` unconditionally (ignoring the flag). Ran `tests/checkFit.test.ts`: exactly one test failed - `shouldStartBackgroundSenders > is false when sending is disabled`. Restored; all 14 tests in the file passed again, and `npm run typecheck` was clean both before and after restoring.

Because `main/index.ts` cannot be unit tested (imports Electron at module load, the same constraint every existing check:fit hook already works around - see `checkFit.ts`'s own file doc comment), "each engine's start is skipped when on" and "each listed handler refuses when on" are proven at the level this codebase's own convention already tests such wiring: the extracted pure predicate/guard functions above, with the actual `index.ts` wiring proven by the check:fit run itself (§A7) - the same relationship `resolveCheckFitForcedScreen` already has to its own `index.ts` call site.

### A7. Verify: full `check:fit` summary

```
[rubis-pos] check:fit mode: all sending disabled.
...
Measured and fit: 274
Skipped (0):
Allow-listed scrollers (0):

All 274 case(s) fit with no overflow.
```

(Full run, all 9 main-sweep cases plus the 4 forced-screen cases and the 27 synthetic-screen cases, 40 launches in total. Every launch logged the "all sending disabled" line, confirming the flag reached every one of them.) 274 measured-and-fit, 0 skipped, 0 allow-listed - identical to docs/phase-167's own baseline, with every sender now disabled and the copy's Shopify/fiscal addresses redirected. This also confirms the fix for the regression found in §A5: the main sweep's `"COMPLETE SALE"` catalog check passed at every one of the 9 sizes.

---

## Commit B - Retry Sync refuses voided, resets attempts

`retryOrderSync` (`database.ts:2019-2059`) now:
- throws `` `Order ${localId} is voided and cannot be resynced` `` for a `voided` sale (`database.ts:2030-2032`), alongside the existing `synced` refusal.
- when it reuses an existing `'order'` queue row, also sets `attempts = 0` (`database.ts:2044-2046`, was `next_attempt_at` only). A manual retry is a deliberate, informed decision to try again now, not another step of the same automatic backoff `recordQueueFailure` drives - see the updated doc comment (`database.ts:2006-2013`).
- the push marker (`shopify_push_count`/`shopify_last_push_at`, `recordPushStarted`) is untouched by either path - it was already untouched before this commit; nothing needed to change there, only confirmed by test.

**Tests** (`tests/orderHistory.test.ts`, appended to the existing real-SQLite `retryOrderSync` describe block):
- `voided: refused, and no row is created` - `voidOrder` then `retryOrderSync` throws `/voided/i`, no queue row exists, status stays `voided`.
- `a reused row has attempts reset to 0 and is due now` - two recorded failures bring `attempts` to 2, then a retry resets it to 0 and the row is due at `Date.now()`.
- `the push marker is unchanged by a retry` - two recorded pushes give count 2; a retry leaves it at 2.

## Commit C - a thrown push is recorded, not left unhandled

`tick()` (`sync-engine.ts:80-120`) now wraps the `pushOrder` call:

```ts
db.recordPushStarted(item.entity_id)

let result: Awaited<ReturnType<PushOrderFn>>
try {
  result = await pushOrder(item.payload)
} catch (err) {
  db.recordQueueFailure(item.id, err instanceof Error ? err.message : 'Unknown sync error')
  continue
}

if (result.success && result.data) {
  db.markQueueItemSynced(item.id, result.data.shopifyOrderId)
} else {
  db.recordQueueFailure(item.id, result.error ?? 'Unknown sync error')
}
```

The push marker is written before the `try`, exactly as commit 1 of docs/phase-169 already established - a throw does not change when the marker is written, only what happens after. `continue` moves to the next queued item in the same pass, matching the existing behaviour for an ordinary (non-throwing) failure.

**Tests** (`tests/syncEngine.test.ts`):
- new describe "SyncEngine tick - a throwing pushOrder": a throw on item 1 records a failure with the thrown message, and item 2 is still pushed and marked synced; a non-`Error` thrown value (a plain string) is recorded as `'Unknown sync error'`; a real-SQLite test asserts no `unhandledRejection` process event fires across the `tick()` call, and the order is left `pending_sync` (not silently synced or corrupted).

## 6. Changed existing assertions

One existing assertion needed to change, because commit C changes the exact behaviour it was asserting:

- **File:** `tests/syncEngine.test.ts`, `SyncEngine push marker > a push that throws still leaves count 1`.
- **Old:** `await expect(engine.tick()).rejects.toThrow('socket hang up')` - asserted that a throwing `pushOrder` made `tick()` itself reject.
- **New:** `await expect(engine.tick()).resolves.toBeUndefined()` - asserts `tick()` resolves cleanly.
- **Why:** this is exactly commit C's own change: a throw is now caught inside `tick()` and recorded as a queue failure, so `tick()` no longer rejects. The marker assertions directly below it (`count` is 1, `lastPushAt` is set) are unchanged - the marker's own behaviour did not change, only what happens after the throw.

No other existing `expect(...)` was edited or removed in any of the three commits.

## 7. Verify

```
$ npm run typecheck
(clean: typecheck:node and typecheck:web, no errors)

$ npx vitest run
Test Files  141 passed (141)
     Tests  2087 passed (2087)
(base before this phase: 141 files, 2070 tests; +17: 11 new in checkFit.test.ts §A6,
 3 new in orderHistory.test.ts §B, 3 new in syncEngine.test.ts §C - one existing
 test in that file was changed in place, not added, see §6)

$ npm run build
built; "Confirmed: neither mock provider is in out/main."

$ npm run check:fit
Measured and fit: 274
Skipped (0):
Allow-listed scrollers (0):

All 274 case(s) fit with no overflow.
```

(see §A7 for the full run's detail, including every launch logging "check:fit mode: all sending disabled.")

## 8. Rollback

Each commit reverts independently with `git revert <sha>`, newest first if more than one:
- **Commit C:** a throwing `pushOrder` (which the type signature says should never happen) would again leave `tick()` rejecting and the rest of that pass abandoned.
- **Commit B:** Retry Sync would again accept a voided sale and leave `attempts` at whatever it already was.
- **Commit A:** removes the flag, the guards, and the `check-fit.mjs` redirects. No schema change; the additive columns from docs/phase-169 are untouched by this phase.

## 9. Observed but not changed

- **`integrations:mpesa-stk-push` and `mpesa:query-status`** are real senders left unguarded, on purpose (§A2) - the hard rule excludes the payment gate, and check:fit never triggers either today. Worth a dedicated, explicitly payment-gate-scoped review if that changes.
- **`config:test-mpesa`/`config:test-etims`** are real (if harmless) diagnostic network calls, also left unguarded since check:fit never clicks their buttons.
- **The updater's automatic version check** is not gated either, for the same reason - never called except by a button click check:fit never makes.
- **A `pushOrder` implementation that throws** is now handled (commit C), but the type `PushOrderFn` still documents it as "never throwing" (`sync-engine.ts:31-34`) - worth updating that comment's wording in a future pass to say "even if it does" rather than leaving the two facts side by side.

**STOP for review.**
