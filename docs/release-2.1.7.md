# Release 2.1.7

- **Date:** 2026-10-03
- **Requested:** after phases 208, 210, 211 and 212: bump to 2.1.7; build and verify; install over the top on this PC; confirm the repair ran; publish a GitHub draft; stop for the owner to press Publish.
- **Outcome:** **Partly done.** Done: the version bump and the build, with `verify-dist` and the no-mock check. **Not done: the install on this PC** (both app copies are still running; the owner's "closed" line has not been given) **and the GitHub draft** (no `GH_TOKEN`, no `gh` CLI).
- **Branch / commits:** staging, not pushed by me.

```
c88a36d chore: bump version to 2.1.7
0a131e0 Phase 212-1: one-time start-up repair of sales falsely recorded as filed from the device's zero counter
eecfb75 Phase 211-1: correct the mutation 1 failure count in the report
99afe82 Phase 211-1: trader system invoice number from the location id
c18634f Phases 211 and 212: audits only
de5c838 Phase 210-1: every Shopify order carries its location (build; real-order verification pending)
1f9e80c Phase 209-1 (Shopify reads, cancel proposal; correction blocked) and phase 210 (location audit)
aa56d68 Phase 208: remove the ReadCUinvoiceNumber recovery; guard the CU number (B) and its uniqueness (E)
```

2.1.7 carries phases 208, 210-1, 211-1 and 212-1 on top of 2.1.6.

## 1. Before the build

Full suite **190 files, 3051 tests, all passing**; typecheck clean; `npm run build` passed with `Confirmed: neither mock provider is in out/main.`

## 2. The build

- `npm run dist` (typecheck, build with the no-mock check, electron-builder): exit 0. `verify-dist` printed `Confirmed: win-unpacked/resources/.env is bundled.` No signing (no signing info, as in 2.1.6).
- Files in `release/`: `RUBIS POS Setup 2.1.7.exe` (121,547,106 bytes), its `.blockmap` (128,094), `RUBIS POS 2.1.7.exe` (portable, 121,324,384), `latest.yml` (version 2.1.7, path `RUBIS-POS-Setup-2.1.7.exe`, size 121,547,106).
- **Setup SHA-256:** `717B243E810254BB166A82E133976E46DEC0845157BACE7249FDFCE8DFCFAAD1`. `latest.yml` sha512 `eukqVruxU+9PiD07r0at3YOYPSUH4UmwJcB+1AI2uDUl7ZvcqT4q8yDomSQOtwrVmZZlgQQsgCRNQt0pZR7SZQ==`. `dist:publish` rebuilds, so the published bytes will differ from these hashes (as in 2.1.6); the source commit is the same.
- **Contents of `win-unpacked/resources/app.asar` (a read of the packed file for strings):** present: `repair_212_ran_at`, `last_trader_seq`, `Recorded as filed in error`, `fulfillmentStatus`, `no shop location`, `sent to the tax device again`. Absent: `KRA-MOCK-`, `MockFiscalizationProvider`.
- After the build the test suite still runs (the native module rebuild for Electron did not break the node test run: the repair tests passed, 12 of 12).

## 3. Install over the top on this PC: not done

Eight processes are running: the installed `RUBIS POS.exe` (started 22:36 on 2 October) and the dev `electron-vite` with its electron (22:40). The instruction ties this step, and the phase 209 database correction, to your line "Both app copies are closed." I have not closed them. Procedure when you say so (as in Release 2.1.6 section 3): take the data fingerprint; close both gracefully; run `RUBIS POS Setup 2.1.7.exe /S` (never an uninstall, which wipes the data folder); relaunch with `ELECTRON_RUN_AS_NODE` cleared; confirm `settings.repair_212_ran_at` is set, the fingerprint matches, and that order 1 was repaired (or already corrected by the phase 209 statement, which runs first).

**Order on this PC:** the phase 209 hand correction and its backups first (apps closed), then the install, so the repair finds nothing to do and the hand-written reason text is the one on the row.

## 4. The GitHub draft: not done

`GH_TOKEN` is not set at process or user level, and `gh` is not installed. To finish: set `GH_TOKEN` as a user environment variable in a new terminal (a token with write access to `Volcha-Enterprises/rubis-pos-releases`), then run `npm run dist:publish` from this commit. `electron-builder.yml` has no `releaseType` override, so the default for GitHub applies: a **draft**. Confirm on the releases page that it reads Draft. **Then stop: the owner presses Publish.** Do not press Check for Updates on a shop till.

## 5. Recorded, as the owner instructed

- **The printer test from Release 2.1.6 section 7 has still not been run on any till.** No POS printer is available on this PC, and no result is claimed.
- **The owner has chosen to let the Haile Selassie till update regardless.** It picks the fix up by updating; nobody touches its database. On its first start 2.1.7 runs the one-time repair, which moves any sale recorded as filed from the device's zero counter into Needs Attention (nothing is sent to the device). **Not verified:** that such rows exist on that till.
- **What the update changes on a till, so nobody is surprised:** a sale is refused at checkout with no shop location; every Shopify order is created fulfilled from the till's location with a `location:<slug>` tag; the trader number on receipts, reports and exports for new sales has the new form (14 or 15 characters starting with `L`), and older sales keep `INV-<id>`; a refused retry is no longer recorded as filed.
- **Still unverified against the real systems:** that Shopify decrements stock at the fulfillment location (phase 210-1 section 3, the verification sale has not been made); that the control unit accepts the new trader number form; the device has refused `OpenInvoice` on this till since 2 October.

## 6. Rollback

- Install `RUBIS POS Setup 2.1.6.exe` over the top; never uninstall. 2.1.7's database changes are two `settings` keys (`last_trader_seq`, `repair_212_ran_at`) and a trader number in an existing column; older builds ignore them. A sale created under 2.1.7 would then show and file under `INV-<id>` after a downgrade; do not downgrade after a new-form number has reached the device.
- Nothing has been published, so there is nothing to withdraw on GitHub. `git revert` the phase commits and the bump to take the code back.
