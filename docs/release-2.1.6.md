# Release 2.1.6

- **Date:** 2026-10-02
- **Requested:** phase 198-1 golden fix and commit; bump to 2.1.6; build the Windows installer; publish a GitHub draft; install over the top on the dev PC; one cash sale and a reprint on the real POS printer; confirm the update kept `%APPDATA%\rubis-pos-desktop`.
- **Outcome:** **Partly done.** Done: phase 198-1 committed, version bumped, installer built, installed over the top on the dev PC, data confirmed intact. **Not done: the GitHub draft** (no `GH_TOKEN`, no `gh` CLI) and **the real-printer test** (the dev PC has no POS printer, and the app has none configured). Both are described below with what is needed to finish them.
- **Branch / commits:** staging, not pushed by me.

```
b913076 Phase 198-2: fiscal slip start and end markers; staff names in title case
19cefba chore: bump version to 2.1.6
7ae9207 Phase 198-1: net fallback VAT table, device VAT reconcile, resend print, customer slip stamp
4d47669 feat(pos): print the Enjoy customer slip after the KRA fiscal slip; store the trader invoice number (phase 198)
28dfe67 feat(pos): flush the cart draft on a clean quit; delete the unrendered CartLineItem; restore toast wording (phase 197-1)
```

2.1.6 therefore carries phases 197-1, 198, 198-1 and 198-2 on top of 2.1.5 (198-2 was added after the first build; see section 9). (2.1.5 was built but never published, so this is the first release with phases 197 to 198-1.)

## 1. Phase 198-1 close-out

- Option B applied: the `discounted` scenario in `tests/vatClassReceiptReports.test.ts` now has `vatGroups: { A: '1280.17' }`. The golden's `discounted@48` and `@32` VAT rows became `A 16% 1,280.17 204.83 1,485.00`. No "Device figures" line; nothing else in the golden changed (the test compares every entry of all twelve layouts).
- `docs/phase-198-1.md` section 2 now records the change, and flags the fixture's own subtotal arithmetic (1,650 minus 20 is not 1,485) as a pre-existing inconsistency left as is.
- Full suite before the commit: **175 files, 2738 tests, all passing**. Typecheck clean.

## 2. Build

- `npm run dist` (typecheck, build with the no-mock check, electron-builder): exit 0, and `verify-dist` confirmed the bundled `.env`.
- Files in `release/`: `RUBIS POS Setup 2.1.6.exe` (121,544,219 bytes), its `.blockmap`, `RUBIS POS 2.1.6.exe` (portable, 121,321,461 bytes), `latest.yml` (version 2.1.6, path `RUBIS-POS-Setup-2.1.6.exe`).
- Setup SHA-256 of the first build: `74AEFE9626445DBC465415C8DF8B7760FA3284E3E468E74DEC0FCD0617375C22`. **Superseded by the rebuild in section 9**, which is the build to publish.
- Contents check on the installed `app.asar`: the Enjoy slip heading, `fiscal:vat-mismatches`, the "Device figures. Till VAT" line, `customer_slip_printed_at` and the customer-slip toast are present; `KRA-MOCK-`, `MockFiscalizationProvider` and the test banner text are absent.

## 3. Install over the top on the dev PC

- The dev PC had **2.1.4** installed and running (4 processes). I closed it gracefully (a normal window close, so its close hook ran) before installing; it had exited within six seconds.
- Ran `RUBIS POS Setup 2.1.6.exe /S`: exit code 0 after 12 seconds, same install folder (`%LOCALAPPDATA%\Programs\RUBIS POS`), no uninstall step of mine. The Windows uninstall entry now reads "RUBIS POS 2.1.6" and the exe's file version is 2.1.6. `build/installer.nsh` only wipes the data folder when the uninstaller runs without the update flag, which is why an uninstall must never be used here.
- Before touching anything I took a fingerprint of the data and kept a temporary copy of the database and vault; I deleted that copy once the check passed, so no copy of the vault is left behind.

## 4. Did the update wipe `%APPDATA%\rubis-pos-desktop`? No.

Fingerprint before the install and after 2.1.6 had started and opened the database:

| | Before | After |
| --- | --- | --- |
| `rubis-pos.db`, `secret-vault.json` | present | present |
| Vault (SHA-256, first 16 hex) | `e0bf2f59b4932163` | `e0bf2f59b4932163` |
| Staff | 1 (Admin, admin, active; PIN hash fingerprint `39d48d82`) | same |
| Settings | location "Rubis Kisumu" (confirmed), Shopify store URL, migration flag | same |
| Products cached | 714 | 714 |
| eTIMS integration row | present | present |
| Orders | **0** | **0** |
| New in 2.1.6 | none of the phase 198 columns | `fiscal_trader_inv_num`, `fiscal_slip_unprinted_at`, `customer_slip_printed_at`, and table `receipt_reprints` |

**The Order History part of the check is vacuous:** this PC's database held no orders before the install, so there were none to find afterwards. What it does show is that the database, staff, settings, product cache and the encrypted vault all survived, and that the upgrade migration ran cleanly on a database created by an older build.

## 5. Things that would otherwise look like bugs

- **An Electron app launched from this shell exits at once with code 0.** The shell sets `ELECTRON_RUN_AS_NODE=1`, which makes Electron run as plain Node. My first relaunches failed for that reason, not because of 2.1.6; the same exe runs normally with the variable cleared, which is how it was restarted. It is running now (4 processes, main window "RUBIS POS"). Launching it from Explorer or the Start menu is unaffected.
- While diagnosing that, I ran the installed app once from a script that stops it after 15 seconds; that instance was one I had just started, and it was force-stopped. No cart, no sale.
- That run shows what the installed app does on its own at startup: it reads the fiscal device status through the local ZFPLabServer (`ReadStatus` timed out: the device at `192.168.2.235:8000` is not reachable from here) and tries to refresh products from Shopify (timed out). Both are the app's normal start-up calls.

## 6. The GitHub draft: not done, and how to finish it

- `GH_TOKEN` is not set at user or machine level, and the `gh` CLI is not installed, so I have nothing to publish with, and I did not look for another credential.
- To finish: set `GH_TOKEN` as a Windows user environment variable (a token with write access to `Volcha-Enterprises/rubis-pos-releases`), start a new terminal, then run `npm run dist:publish` from `rubis-pos-desktop`. It rebuilds from the same commit and uploads the installer, blockmap and `latest.yml`. `electron-builder.yml` has no `releaseType` override, and electron-builder's default for GitHub is a **draft**, so the release stays invisible to the updater until someone presses Publish on GitHub. Check on the releases page that it shows as Draft.
- The rebuild produces different bytes from the installer installed on the dev PC (the hash above is for that one), as every electron-builder run does. The behaviour is identical: same source commit.
- Do not publish the draft before the printer test below passes. Do not press Check for Updates on the shop till.

## 7. The real-printer test: not done

**Why I could not do it:** `Get-Printer` on the dev PC lists only Fax, Microsoft Print to PDF, Microsoft XPS Document Writer and OneNote, and the app's `printers` table is empty. There is no POS printer here to print to, and I will not claim a result for hardware I cannot see. Three more reasons not to run a sale on this PC's real profile:
- The dev PC's app is connected to **Shopify** (store `rubisenergykenyaplc`, location "Rubis Kisumu"): a cash sale would create a real order and take real stock off that location.
- Its eTIMS settings point at a real fiscal device (`192.168.2.235:8000`, password in the vault). It is unreachable now, so the sale would be a pending sale record, as you expected, but if the device ever answers, the sale files a **real KRA invoice**.
- I do not know the staff PIN (the database holds a single Admin account).

**What to do on the till with the printer** (2.1.6 installed there by a normal install, not through Check for Updates):
1. Optional, to time the jobs: in an administrator PowerShell run `wevtutil sl Microsoft-Windows-PrintService/Operational /e:true` (the log is **disabled** by default here). Each print job then writes an event 307 with its time; the gap between the two events for the same sale is the gap between the two RAW jobs. Without it, the photos' timestamps and a stopwatch are all there is, because the app does not log the RAW sends.
2. One cash sale with the device not answering: expect the sale record (heading "SALE RECORD", "NOT A TAX INVOICE") and then the Enjoy slip ("E N J O Y", the shop location and address under it, "Your KRA tax invoice will follow." and "Please keep this receipt."). Order: sale record, cut, Enjoy slip, cut. Photograph both.
3. From Order History, reprint the sale. Expect the same two slips again, the Enjoy slip between two `*** DUPLICATE ***` lines (the sale record is not stamped, since it was never a fiscal receipt). Photograph both.
4. Note: that the two came out in order; that each ended with its own cut and not one cut for both; the gap between them; and anything that looks wrong (the double-size heading, 48-column lines wrapping).
5. In the database afterwards (`orders`, `receipt_reprints`): one `fiscal` and one `enjoy` reprint row, and `customer_slip_printed_at` set.

The same flow was run against the built app with the mock printer (phases 198 and 198-1), where each slip was its own recorded job; that shows the order and the separate jobs in software, not what the printer does with them.

## 8. Rollback

- To go back on the dev PC, install `RUBIS POS Setup 2.1.4.exe` (or 2.1.5) over the top; never uninstall. The 2.1.6 database changes are additive columns and one table, which older builds ignore.
- Nothing has been published, so there is nothing to withdraw on GitHub. `git revert` the three phase commits and the bump to take the code back.

## 9. Rebuild after phase 198-2 (the build to publish)

Phase 198-2 (the fiscal slip start and end markers, title-case staff names; `docs/phase-198-2.md`) was committed after the first 2.1.6 build and install, so I rebuilt 2.1.6 from `b913076` (same version number, still unpublished) and reinstalled it.

- **Build:** `npm run dist` exit 0, `verify-dist` confirmed the bundled `.env`. `RUBIS POS Setup 2.1.6.exe` is 121,544,395 bytes, SHA-256 `5DABA922A467F9DD8EA08789525DCFC39A08FCA955C5C712203D98FEC37311D5`; `latest.yml` sha512 `2xvpW0FclM4oURyAcFQKNOewB/ZAk/lbSDt/5maKVHjaT+DtFNW3oEnzz//StLI4f9UKdSOJmbF7B7Lrx9IEOg==`. The first build's files in `release/` were overwritten.
- **Install over the top, again:** closed the running app gracefully (0 processes within six seconds), ran the installer with `/S` (exit 0, 14 seconds), relaunched with the shell's `ELECTRON_RUN_AS_NODE` cleared. The app is running (4 processes). No uninstall.
- **Installed contents:** `- START OF FISCAL RECEIPT -` and `- END OF FISCAL RECEIPT -` are in the installed `app.asar`; `KRA-MOCK-` and the test banner text are not.
- **Data:** the same fingerprint as in section 4, taken before and after this second install: orders (0), staff, shifts, products (714), settings, integrations, printers, the vault hash and the phase 198 columns and table all identical.
- **Still open, unchanged from sections 6 and 7:** the GitHub draft (no `GH_TOKEN`, no `gh`; checked again, still unset) and the real-printer test (still no POS printer on this PC). Publish the draft from this rebuilt installer, i.e. run `npm run dist:publish` from commit `b913076` or later, and on the till check the new START and END lines: on a filed sale they sit under the header and above "Thank you...", and on the sale record and the Enjoy slip there are none.
