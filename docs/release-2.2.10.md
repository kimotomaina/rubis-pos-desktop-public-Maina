# Release 2.2.10

- **Date:** 2026-10-06, 23:25 Nairobi
- **Outcome:** version bumped and the installer built from commit `c415ea4`. **Not published:** the owner chose "Hold, publish nothing" after Gate 2's first suite run had one failure (below). Not installed on any till.
- **Contains:** phases 246-1, 246-2, 247, 249, 249-1, 250, 252, 252-1 and 252-2, on top of 2.2.9 (`d034c3c`, published 2026-10-06 14:33 UTC). The commits in between that change only docs are 248 (audit), 250's added line and 251 (audit and parking).

## Gate 2

| Check on `c415ea4` | Result |
| --- | --- |
| `npm run typecheck` | clean |
| Full suite, first run | **1 failed**, 3,895 passed: `mockZfplabServer.test.ts`, "routes an unrecognized command to a safe-default ack, not a hang or 404". This is the development mock fiscal server; it is not shipped. |
| That file alone | 14 of 14 passed |
| Full suite, second run | 238 files passed, 2 skipped; 3,896 passed, 9 skipped, 0 failed |
| Golden and repair rehearsal on the 1606 copy (temp copy) | 9 of 9; figures identical, CSV byte-identical, copy unchanged |
| `npm run dist` | passed: `check-env` ("no credentials"), the no-mock guard, the `.env` bundling check |

The same test also failed in a session on 6 Sep, so it looks intermittent under load. Its error text from the first run was not kept. Not investigated further.

## The files (`release/`, not committed)

| File | Size (bytes) | SHA-256 |
| --- | --- | --- |
| `RUBIS POS Setup 2.2.10.exe` | 121,600,051 | `d2e9b5d5034c9cdb341d3490171a5838e2ecd62a00a891562b4d5857ee766324` |
| `RUBIS POS 2.2.10.exe` (portable) | 121,377,278 | `791b445cc8e3bb64b1bcff098579fe8ef62a34cd3baa8c0843a46dfd4f9d71aa` |
| `RUBIS POS Setup 2.2.10.exe.blockmap` | 128,127 | — |
| `latest.yml` | — | version `2.2.10`, path `RUBIS-POS-Setup-2.2.10.exe`, size 121,600,051 |

**Inside the build:**
- **The packaged `resources/.env`:** no credential line with a value (GitHub, Shopify, M-Pesa). `VITE_USE_MOCK_ETIMS=false`, `VITE_USE_MOCK_MPESA=false`, `VITE_DEMO_MODE=false`, `VITE_MOCK_PRINTER=false`. `VITE_PRINTER_INTERFACE` is set, as in every build since 2.2.2 (`KNOWN_GAPS.md`).
- **The app version:** `app.asar`'s `package.json` says 2.2.10.
- **The update feed:** `app-update.yml` points at `Volcha-Enterprises/rubis-pos-releases` (github).

## Publishing, when the owner says

- **The token:** `GH_TOKEN` is set in no environment scope on this PC. The only one here is in `.env.secrets.local`, which earlier notes say may be the token exposed in 2.1.5.
- **Keeping the recorded bytes:** upload these files to a new release `v2.2.10`, rather than running `dist:publish`, which builds again and would upload different bytes. Use the names in `latest.yml` (`RUBIS-POS-Setup-2.2.10.exe`, its blockmap, `RUBIS-POS-2.2.10.exe`).
- **Check, then publish:** confirm `latest.yml` says 2.2.10, then publish the release (`RELEASING.md` d).

**On the till after the update:** splits are on for every sale (phase 252-2). D8 (whether a split needs declaring to the device) is still **Being confirmed**.
