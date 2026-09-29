# Releasing RUBIS POS

How to publish a new version so tills can pick it up over the air. Follow the steps in order.

## a. Before you start

- You need a fine-grained GitHub token with write access to Releases on `Volcha-Enterprises/rubis-pos-releases` only, and nothing else.
- Set it in the shell for that session only. Never paste it into a file, `.env`, `electron-builder.yml`, or a commit.

```powershell
$env:GH_TOKEN = "<paste>"
```

- Close that shell when you are done publishing. Opening a new shell later means setting `GH_TOKEN` again.

## b. Bump the version

Bump `package.json`'s `version` and commit it before building, not after.

```
chore: bump to x.y.z
```

## c. Build and publish

```
npm run dist:publish
```

This runs the same typecheck, build and guard scripts as `npm run dist`, then uploads to GitHub as a **draft** release named after the version tag. The build stops if `.env` holds a store URL, Shopify token, location or M-Pesa credential: `.env` ships inside every installer as a plain file anyone can read. Keep those fields blank; each till sets them itself (see "First install on a new till" below). Expect three assets:

- `RUBIS POS Setup x.y.z.exe`
- `RUBIS POS Setup x.y.z.exe.blockmap`
- `latest.yml`

## d. Publish the draft

Open the draft release on GitHub. Check all three assets are there and the version in `latest.yml` matches. Then publish it.

Tills see nothing until you publish the draft — a draft release is invisible to the update feed.

## e. Update a till

On the till: **Admin > Check for Updates**, wait for the toast, then **Restart & Install**. Afterwards, read **Installed version** in Admin to confirm it landed.

Before installing, the till takes its own backup to `userData\backups` and records the current sales/fiscal counts, so Admin can show whether everything carried over once it restarts. That folder survives an update (the guard in `build/installer.nsh`) and is only ever removed by a real uninstall, along with everything else under `userData`.

## f. Rollback

Unpublish or delete the bad release on GitHub, then re-publish the previous one.

Tills that already updated to the bad version do not roll back on their own — there is no built-in downgrade (docs/phase-8.md §11). Install the previous `Setup x.y.z.exe` on those tills by hand, over the top.

## g. First-time note

Tills currently running 2.0.x have the old private repo baked into their update feed. The very first build made after this runbook exists must be installed on each till by hand, once. After that, `Check for Updates` on those tills reaches the new public releases repo like any later update.

## h. SmartScreen on manual install

The installer is not code-signed, so a manual install shows Windows SmartScreen. Choose **More info > Run anyway**.

Because it is unsigned, `electron-builder.yml` also sets `verifyUpdateCodeSignature: false`, otherwise tills would reject every update as unsigned. If a code-signing certificate is ever added, remove that line (and its test in `tests/updateReleaseConfig.test.ts`) so tills check the publisher again.

## First install on a new till

The installer carries no credentials, so a new till asks for them once. They are then stored on the till (encrypted vault and database) and kept through every update.

1. First-run wizard: enter the Shopify store URL and Admin API token, then confirm the location.
2. Admin > Integrations > Fiscal Device: device address, port and password.
3. Admin > Integrations > M-Pesa: only if the till uses Daraja (consumer key, secret, passkey, shortcode).
4. Admin > Integrations > Fiscal Device > Store Details: store name, KRA PIN and receipt lines.
