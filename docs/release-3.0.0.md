# Release 3.0.0

- **Date:** 2026-10-07, about 06:50 Nairobi
- **Asked by the owner:** "Build, but do not deploy the next version. We are moving to version 3.0.0."
- **Outcome:** the version was bumped (`97b6c1d`) and the installer built from that commit. **Not published:**
  - no publish command was run;
  - no GitHub token is set in this shell (`GH_TOKEN` and `GITHUB_TOKEN` absent, checked by presence only);
  - the update feed was not touched.

  It is not installed on any till. 2.2.10 stays built and unpublished, as it was.
- **Contains:** everything since 2.2.9 (`d034c3c`, the last published release):
  - **from 2.2.10:** phases 246-1, 246-2, 247, 249, 249-1, 250, 252, 252-1 and 252-2;
  - **new:**
    - 253-1: the Sync button, and the sync at start and at login;
    - 253-2: the pairs discount (Buy X get Y);
    - 254: the cashier role gate, opening and closing a shift, the Z lock, "My shifts and sales";
    - 255: an admin may close early;
    - 256: open and close from every screen that shows shifts, with a review.
  - **Changing only docs:** the 253 audit and 253-3.

## The gate

| Check on `97b6c1d` | Result |
| --- | --- |
| `npm run typecheck` | clean |
| Full suite | 250 files passed, 2 skipped (the copy rehearsals); 4,198 tests passed, 10 skipped, **0 failed** |
| Golden and repair rehearsal on the 1606 copy (temp copy) | 9 of 9: payment figures to the cent, the orders CSV byte for byte. The copy is unchanged by SHA-256 (`a3def016…`) |
| `npm run dist` | passed: `check-env` ("no credentials"), the no-mock guard, the `.env` bundling check |

## The files (`release/`, not committed)

| File | Size (bytes) | SHA-256 |
| --- | --- | --- |
| `RUBIS POS Setup 3.0.0.exe` | 121,610,250 | `44d41af4e9be05f86e82666e073625f5cae07ed2502179b51169ba6d26ceef4b` |
| `RUBIS POS 3.0.0.exe` (portable) | 121,387,475 | `5cf9e41090b8e68c179794405dd54f8e732b83eebc5332435e602da463d8f0ef` |
| `RUBIS POS Setup 3.0.0.exe.blockmap` | 128,196 | `a560d6729318e3d16b83eb68f1f9769ac769e417f9bff6cb1714ee5db72f8de2` |
| `latest.yml` | 347 | version `3.0.0`, path `RUBIS-POS-Setup-3.0.0.exe`, size 121,610,250 |

**Inside the build:**
- **The app version:** `app.asar`'s `package.json` says 3.0.0.
- **The packaged `resources/.env`:**
  - no credential has a value: the Shopify token, the M-Pesa consumer key and secret, and the passkey are empty;
  - `VITE_USE_MOCK_ETIMS`, `VITE_USE_MOCK_MPESA`, `VITE_DEMO_MODE` and `VITE_MOCK_PRINTER` are all `false`;
  - `VITE_PRINTER_INTERFACE`, `VITE_TAX_RATE`, `MPESA_SHORTCODE` and `MPESA_ENVIRONMENT` are set. None of them is a secret.
- **The update feed:** `app-update.yml` points at `Volcha-Enterprises/rubis-pos-releases` (github).
- `package-lock.json` still says 2.2.6, as it has since 2.2.6. Only `package.json` carries the version, as in every release since.

## Publishing, when the owner says

- **Keep the recorded bytes:** upload these files to a new release `v3.0.0`, rather than running `dist:publish`, which builds again and would upload different bytes. Use the names in `latest.yml`: `RUBIS-POS-Setup-3.0.0.exe`, its blockmap, and `RUBIS-POS-3.0.0.exe`.
- **The token:** none is set on this PC outside `.env.secrets.local`, which earlier notes say may be the token exposed in 2.1.5.
- **Order:** confirm `latest.yml` says 3.0.0, then publish. A till on 2.2.9 goes straight to 3.0.0; 2.2.10 need never be published.

## On the till after the update

**The owner's checks** (phases 254 to 256):
1. A cashier logs in to the catalogue. Admin is not reachable for a cashier.
2. A cashier opens a shift with no PIN. Close shift waits for the end time; then figures, Review, Close shift, and the Z prints.
3. "My shifts and sales" shows only that cashier's shifts and sales. Orders shows only their own.
4. With a shift open, Print Z asks for the close, for an admin too.
5. An admin closes from Admin > Overview, or from Admin > Reports > Shift History, early if need be.

**Also:**
- **The pairs discount** "Pro-bakery Bread 2 @99/=" is live in Shopify: 1 loaf 65, 2 for 99. The Sync button and the start-up sync read it.
- **Test order #1333** (Kisumu, tagged `TEST-253`) is still to be cancelled and restocked in Shopify.
- **The receipt's name and PIN** ("Rubis Energy Kenya PLC", P000593549A) are not set by this build. They are typed in Admin > Store details on each till; a code change can be ordered instead.
- **D8** (whether a split payment needs declaring to the device) is still **being confirmed**, from 2.2.10.

## Not verified

- **Installed on no till.** The new screens have not been seen there, and are not measured (no `check:fit`).
