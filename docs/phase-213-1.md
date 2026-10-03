# Phase 213-1 — the GitHub token was already public in the published 2.1.5 installer

- **Date:** 2026-10-03
- **Follows:** [phase-213.md](phase-213.md), which found the token in the local build and fixed the guard. This record is what the check of the **published** releases then showed.
- **Outcome:** **the `GH_TOKEN` in the owner's `.env` is publicly exposed and must be treated as compromised. It should be revoked and replaced now.** Nothing in this repo can do that; it is done on GitHub by the token's owner.

## 1. The measurement

- The release repository `Volcha-Enterprises/rubis-pos-releases` is **public** (`private=false`, GitHub API), and its installers download with no authentication (HTTP 200 on a HEAD of the v2.1.5 and v2.1.4 setup files).
- v2.1.5 was **published on 2026-10-02T13:49:36Z** (v2.1.4 at 12:58:49Z). The `.env` file was last modified at 16:47 local time on 2 October (13:47Z), two minutes before. (The 2.1.6 release record said 2.1.5 was never published; GitHub says it was.)
- I downloaded the public `RUBIS-POS-Setup-2.1.5.exe` (121,539,089 bytes). It is a 7z archive; its `resources\.env` is 1,086 bytes. Inside: **a `GH_TOKEN` of length 93 whose SHA-256 (first 12 hex) is `F44157EB25FC`, identical to the token now in `.env.secrets.local`.** The value was compared by hash and never printed or saved; the extracted files were deleted straight after.
- In the same published file every other credential key is blank (Shopify token and URL, M-Pesa key, secret and passkey), so the phase 180 guard was working for those; only `GH_TOKEN` was missing from it.
- **Not checked:** v2.1.4, v2.1.2 and v2.1.1 (published before 16:47 local, so unlikely to carry the key, but I did not download them); the portable `.exe` of 2.1.5; whether anyone has downloaded 2.1.5 since.

## 2. Why it matters

The token can write to the releases repository. The tills' updater trusts that repository, and the installers are unsigned with `verifyUpdateCodeSignature: false` (`electron-builder.yml`, phase 181). So anyone who downloaded 2.1.5 could publish a replacement installer that a till would install on its next update. I found no sign that this happened: the repository holds exactly the releases expected (v2.1.7 draft, 2.1.5, 2.1.4, 2.1.2, 2.1.1), but I did not inspect the contents of the older assets, and a replaced asset would not show in that list.

## 3. What was done and not done

- **Done (phase 213, committed):** the guard refuses `GH_TOKEN` and `GITHUB_TOKEN` in a bundled `.env`; the line was moved to `.env.secrets.local`; 2.1.7 was rebuilt, and its packaged and installed `.env` hold no such key.
- **Not done, needs the owner:** revoke this token on GitHub and issue a new one; keep the new one out of `.env` (an environment variable or `.env.secrets.local`); decide whether to delete or replace the v2.1.5 release assets (they still carry the token and remain downloadable) and whether the tills that updated to 2.1.5 hold it in `resources\.env` (they do, if they installed it; their copy is replaced when they update to a clean build).
- **The v2.1.7 draft** on GitHub was created with the old token before this was known, from the clean build. The draft does not contain the token (the packaged `.env` has no such key). It has not been published.

## 4. Rollback

Not applicable: nothing here is reversible by a code change. The exposure exists until the token is revoked.
