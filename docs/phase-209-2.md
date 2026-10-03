# Phase 209-2 — order 1: the database correction and the cancel of #1087, done

- **Date:** 2026-10-03
- **Follows:** [phase-209-1.md](phase-209-1.md). The owner then said both tills were closed and gave the go for the cancel.
- **Outcome:** done, both. Nothing else was changed.

## 1. The database correction (ruling 1)

- **Closed:** `Get-Process` showed the dev copy gone and the installed copy still alive with **no window** (main window handle 0 on all four processes) and a database file last written at 00:39. I stopped those four processes (6076, 43700, 50348, 59468) and confirmed **0** remained.
- **Backup** beside the originals, hash-identical to them: `rubis-pos.db.2026-10-03-pre-209-correction.bak`, `rubis-pos.db-wal.2026-10-03-pre-209-correction.bak`, `rubis-pos.db-shm.2026-10-03-pre-209-correction.bak`, all in `C:\Users\paulc\AppData\Roaming\rubis-pos-desktop\`.
- **Statement** (the phase 209 SQL, reason text as ruled), guarded by `AND fiscal_invoice_number = '0110605040000000000'`: `changes() = 1`.
- **Row before:** `local_id 1`, `fiscalized`, number `0110605040000000000`, QR empty, time source `local-fallback`, slip-unprinted flag `2026-10-02T21:37:12.041Z`, serial `KRAMW011202207060504`, trader number `INV-000000001`.
- **Row after (re-read):** `needs_fixing`, kind `system`, reason `Test sale. The fiscal device refused it and it was never filed. Recorded as filed in error; corrected by hand on 2026-10-03. Do not resend.`, invoice number, QR, fiscal time, time source and slip flag all NULL; serial and trader number unchanged. Orders in the table: 1.
- **After 2.1.7 started** (section below), the one-time repair found nothing to change and left this row as written.

## 2. The cancel of #1087 (GO 1)

By curl, one mutation: `orderCancel(orderId: "gid://shopify/Order/7801903054951", reason: OTHER, restock: true, notifyCustomer: false, staffNote: "Test sale, 1.00 KSh cash, never filed on the fiscal device. Cancelled 2026-10-03.")`, **no `refundMethod`**, as ruled.
- **Before:** `cancelledAt` null, PAID, UNFULFILLED; variant "test" at Enjoy Haile Selassie `available=0 committed=3 on_hand=3`.
- **Response:** job `gid://shopify/Job/8d4d0239-8549-4ede-a491-d953ff3815cb`, `done: false`; **`orderCancelUserErrors`: none.**
- **Read back after 8 s:** `cancelledAt 2026-10-03T00:28:12Z`, `cancelReason OTHER`, financial status still PAID (no refund was requested), no tags; Enjoy Haile Selassie **`available=1 committed=2 on_hand=3`**, as expected. No other location changed.
- Note on the clock: Shopify's time here reads about 00:28Z; my earlier reads of order times were converted to Nairobi time (UTC+3).

## 3. Install of 2.1.7 over the top

- Data fingerprint before: vault hash `d64bf937939bf270`, orders 1, staff 1 (Admin), products 714, integrations 1, printers 0, `sync_queue` 0, settings 5 (location `Rubis Kisumu` confirmed). After the install, **identical**.
- `RUBIS POS Setup 2.1.7.exe /S`: exit 0 in 12 s, same folder, no uninstall; file version 2.1.7; the Windows entry reads "RUBIS POS 2.1.7". The installed `resources\.env` holds no `GH_TOKEN` or `GITHUB_TOKEN` text.
- First start of 2.1.7: `settings.repair_212_ran_at` is now set; orders still 1; order 1 unchanged from section 1; `last_trader_seq` unset (no sale yet); vault hash unchanged.
- The installed build is the second 2.1.7 build, from commit `3d1f897` (setup SHA-256 `292DE7EB4D41493160B3D9539F398BF66CB111A5671BAAE3E15481742F01C82E`). A third build was made by `dist:publish`, so the uploaded bytes differ from the installed ones, as in 2.1.6; the source is the same.

## 4. The GitHub draft

`npm run dist:publish` uploaded `RUBIS-POS-Setup-2.1.7.exe`, its blockmap, `RUBIS-POS-2.1.7.exe` and `latest.yml` and created release `v2.1.7`. **GitHub shows `draft=True`, `published_at` empty.** It has not been published. See [phase-213-1.md](phase-213-1.md) for why the token used is now compromised.

## 5. Still open

- **The verification sale (GO 3) has not been made.** The app is installed and running; I cannot log in (the PIN is the owner's). Baseline for the item to sell, **AQUAMIST STILL 500 ML** (variant `gid://shopify/ProductVariant/50363388657767`, policy CONTINUE): Rubis Kisumu `available 97, committed 0, on_hand 97`; Enjoy Haile Selassie `available 97, committed 0, on_hand 97`; HQ 0. One cash sale of 1 unit from this till, then the reads: the order's fulfillments and tags, both locations' levels, the till's `orders` row. **Pass:** fulfilled from Rubis Kisumu, tag `location:rubis-kisumu`, Rubis Kisumu 96 and Haile Selassie still 97.
- **Tagging existing orders:** read-only listing done (26 POS orders since 1 September; #1087 cancelled; #1084 to #1086 about 16:00 on 2 October are the other till's by the owner's rule). **Not run:** the tags, until the owner confirms the split for the rest (#1062 to #1083) and names the other till's location.
- **Stock:** no stock was written. Rubis Kisumu has 681 items in stock, so the "set test to 5" step was not needed.
