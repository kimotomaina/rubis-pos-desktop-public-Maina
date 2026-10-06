# Release 2.2.6

- **Date:** 2026-10-06, built 08:59
- **Requested:** "bump up and build" after phases 235 to 239.
- **Outcome:** version bumped (`6412791`) and the installer built from that commit. **Not published** (no `GH_TOKEN` or `gh` on this PC). **Not installed on any till.** The owner uploads the three assets to a draft, checks `latest.yml`, and presses Publish.
- **Supersedes 2.2.5**, which was built twice (release-2.2.5 §0 and §2) and whose GitHub draft the owner deleted; it was never published or installed, so its number is retired like 2.1.7's and 2.2.3's.
- **Contains, on top of 2.2.5's phases 227 to 232:**
  - [phase 235](phase-235.md): the M-Pesa panel opens on Manual verification, STK Push one tap away;
  - [phase 237](phase-237.md): the Day shift is 07:00 to 17:30 and the Night 17:31 to 06:59 (the 09:00 start was an error);
  - [phase 239](phase-239.md): merge two shifts of one window; Z report, Correct figures and Merge into… as Shift History row actions.
  - [Phase 238](phase-238.md) (the shift dry-run tool) ships no app code: `rubis-shift-dry-run` does not appear in the bundles. [Phases 233](phase-233.md) and [236](phase-236.md) are audits.
- **Commits since 2.2.5:** `8cc3f6d` (237), `dd368a2` (238), `af961c7` (239), `5e71f8b` (235), `915a9f3`, `d2e798d` (audits), `6412791` (the bump).

## 1. Checks on `6412791`

| Check | Result |
| --- | --- |
| Full suite (on `af961c7`, the last code commit) | 214 files, 3593 passed, 1 skipped (the build-freshness check), 0 failed |
| `npm run typecheck` | clean |
| `npm run dist` | `check-env` "no credentials"; build; "neither mock provider is in out/main"; `verify-dist` "win-unpacked/resources/.env is bundled" **passed as the `postdist` step this time** (the 2.2.5 rebuild's unexplained first "MISSING" did not recur) |

## 2. The build

- **Setup:** `release/RUBIS POS Setup 2.2.6.exe`, 121,578,649 bytes, SHA-256 `9E27A26F0825B7F0EF08CA9B3ED11B1FB8EF4927D5E284D70387F1F1E7663D18`.
- **Blockmap:** `RUBIS POS Setup 2.2.6.exe.blockmap`, 128,310 bytes.
- **`latest.yml`:** `version: 2.2.6`, `path: RUBIS-POS-Setup-2.2.6.exe`, size 121,578,649, `releaseDate 2026-10-06T05:59:56.634Z`. All three written 08:59.
- **Portable:** `release/RUBIS POS 2.2.6.exe`, 121,355,887 bytes, SHA-256 `C320B08E46B7C117A2AB92F4A9566DD6850DAE505CD59C2D393E5B1837041BF4`.
- **Packed `app.asar`:** `package.json` inside reports 2.2.6. Phase 235: `useState("unverified")` once, `useState("stk")` nowhere. Phase 237: `startMinutes: 7 * 60` in both the main and the renderer bundle, no `9 * 60`. Phase 239: `shift_merges` and the merged-into line present. Phase 238: not present.
- **Bundled `.env`:** byte-identical to the root `.env`; Shopify URL and token, M-Pesa consumer key, secret and passkey all empty; the printer address, mock flags, tax rate, shortcode and environment carry the same non-secret values as 2.2.2 onwards.
- Unsigned, as every build.
- **Way back:** the 2.2.5 and 2.2.4 installers are in `release/`. The new `shift_merges` table is additive: an older build still opens a database this one has touched, but would show a merged shift as an ordinary empty closed shift and would not show the merge.

## 3. Before it goes on a till

1. **The shift dry run on the Enjoy Haile Selassie copy is not done** (release-2.2.5 §3 gate 1). The tool for it is phase 238: copy that till's `rubis-pos.db` (with `-wal`/`-shm` if present) with the app closed, then `npm run shift:dry-run -- <copy>` here. This PC's own copy was run (phase 238 §4). The result now follows the 07:00 windows.
2. **Publishing needs `GH_TOKEN`** as a Windows user variable on the publishing machine. Upload the three assets from this one build to a new draft; `latest.yml` carries this installer's hash, so never mix files from two builds. Then Publish.
3. **After publishing:** both tills take the update through the phase 219 prompt at their next start. Then the owner checks on the till (no check:fit): the M-Pesa panel's tab, the Day/Night labels and close times, the Shift History Actions column and the merge form.

## 4. Not done

Not published; not installed; the app was not started; nothing sent to the device, Shopify or Safaricom; `check:fit` not run (owner's rule).
