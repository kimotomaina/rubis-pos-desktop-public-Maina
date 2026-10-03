# Phase 213 — a publishing credential must never be bundled into an installer

- **Date:** 2026-10-03
- **Found while:** preparing the 2.1.7 draft, when the owner said the `GH_TOKEN` "is in the `.env` file".
- **Outcome:** fixed. `check-env.cjs` now refuses a build whose `.env` carries `GH_TOKEN` or `GITHUB_TOKEN`; the line was moved out of `.env`; 2.1.7 was rebuilt clean.
- **Branch / base:** staging on `74bb07d`.

## 1. The finding

`electron-builder.yml` copies `.env` into every installer and portable build as a plaintext file at `resources/.env` (`extraResources`). Phase 180's guard, `scripts/check-env.cjs`, already refuses a build whose `.env` holds a store URL, a Shopify token or an M-Pesa credential, because installers are published publicly (phase 177). **`GH_TOKEN` was not on its list.**

Measured on 2026-10-03, by value length only (the value was never printed):

| Copy | `GH_TOKEN` |
| --- | --- |
| Source `.env` (modified 2026-10-02 16:47) | present, value length 93 |
| The first 2.1.7 build, `release/win-unpacked/resources/.env` (feeds both the setup and the portable exe) | present, length 93 |
| The installed copy on this PC, `%LOCALAPPDATA%\Programs\RUBIS POS\resources\.env` | present, length 93 |
| The old guard against the source `.env` | **passed** (`[]`), so the build had not been refused |

A token that can publish releases to `Volcha-Enterprises/rubis-pos-releases`, which the tills' updater trusts (and whose installers are unsigned, `electron-builder.yml`), would have been readable on every till that installed the build, and by anyone given the published installer.

## 2. What was exposed, and what was not

- **Not published.** No 2.1.7 or 2.1.6 draft was ever uploaded (no token, no `gh`: release-2.1.6 section 6, release-2.1.7 section 4). So the artifacts that carry the token are the local `release/` folder and the installed copy on this PC.
- **Not verified:** whether any installer published **before** 2 October 16:47 or **after** it carried the key. The `.env` file time says the key arrived on 2 October at 16:47; any build made after that holds it. I did not check the published releases.
- **Recommendation:** if this PC is shared, or the `release/` folder has been copied anywhere, **rotate the token**. It has been in plaintext in installer files on disk.

## 3. What changed

- **`scripts/check-env.cjs`:** `BUNDLE_FORBIDDEN_KEYS` gains `GH_TOKEN` and `GITHUB_TOKEN`. The existing rule applies: a non-blank value fails the build before any build work runs (`predist`), naming the key and never its value.
- **`tests/checkEnv.test.ts`:** the "guards exactly the six credential keys" test now lists eight (old/new note in the file); a test that each publishing key with a value is reported; a test that a blank or absent one passes. 15 of 15 pass.
- **The owner's `.env`:** the `GH_TOKEN` line was **moved** to `.env.secrets.local` (gitignored, never bundled), after verifying the copy was identical; nothing else in either file changed, no backup copy of the secret was made, and the value was not printed. The owner's wording was that the token is in `.env`; the move is reversible by moving the line back, which the guard will then refuse.
- **How publishing gets the token now:** `dist:publish` needs `GH_TOKEN` in the process environment, set at run time from `.env.secrets.local` for that one command and cleared after.
- **The 2.1.7 build was redone.** New setup SHA-256 `292DE7EB4D41493160B3D9539F398BF66CB111A5671BAAE3E15481742F01C82E`, 121,547,021 bytes; `latest.yml` sha512 `Tyg5Nm0sqXqZVU1PuNmlE17CFOH6EKmBL/X4Vh++5FxZc/w9I7Nm008mfVP2MXxDv9NIxW5vMS6XOlcr3N3t5w==`. The packaged `resources/.env` has no `GH_TOKEN` or `GITHUB_TOKEN` text at all. **This supersedes the hashes in `docs/release-2.1.7.md` section 2.**
- **The installed copy on this PC still carries the old `.env`** until the new build is installed over it (the installer replaces `resources/.env`).

## 4. Not changed, noted

The store token, store URL and M-Pesa keys stay guarded as before. This phase adds no secret scanning beyond key names; a token pasted under another key name would not be caught.

## 5. Rollback

`git revert` the commit to drop the two key names from the guard. The line in `.env.secrets.local` is the owner's to keep or move.
