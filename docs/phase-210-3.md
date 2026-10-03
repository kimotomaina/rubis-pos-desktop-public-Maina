# Phase 210-3 — the verification sale: the location works, the device accepted the new trader number, and four findings

- **Date:** 2026-10-03
- **Follows:** [phase-210-1.md](phase-210-1.md) section 3 (verification pending), [phase-211-1.md](phase-211-1.md), [phase-212-1.md](phase-212-1.md).
- **Outcome:** **the verification passes.** No code changed in this phase; four findings are recorded for decision. One real cash sale was made by the owner on this till on build 2.1.7: order 2.
- **Note:** the owner sold **AQUAMIST PINEAPPLE 500ML** (variant `gid://shopify/ProductVariant/50363388100711`), not the AQUAMIST STILL 500 ML proposed. Total 90.00 KES, tendered 500, change 410.

## 1. The verification, by curl and from the till's database

**Shopify** (order found by `source_identifier` `ef91a714-a779-4b3b-93ef-132522f1a314`, exactly one):
- Order **#1088**, `gid://shopify/Order/7802331922535`, created 2026-10-03T00:50:14Z, PAID, **FULFILLED**, total 90.0 KES, not cancelled.
- **Fulfillment** `gid://shopify/Fulfillment/7264654426215`: status SUCCESS, **location Rubis Kisumu** (`gid://shopify/Location/77557989479`).
- **Tags:** `[location:rubis-kisumu]`.
- **Stock of the variant** (policy CONTINUE): **Rubis Kisumu `available 6, committed 0, on_hand 6`, all three quantities updated 2026-10-03T00:50:14Z** (the earlier read of 3 October showed 7 available there); **Enjoy Haile Selassie `available 7`, last updated 2026-10-02T07:54:45Z (untouched)**; HQ 0, untouched. I had no pre-sale snapshot of this variant at Haile Selassie; the untouched timestamp is what shows it did not change.

**Pass condition met:** fulfilled from Rubis Kisumu, tag `location:rubis-kisumu`, the decrement at Rubis Kisumu only. This is one order, one item, one location pair: it shows `fulfillment.locationId` placed the decrement at Rubis Kisumu in this case; it does not test zero stock under "deny" (the item had stock and policy CONTINUE).

**The till's `orders` row 2:** `synced`, `shopify_push_count` 2, payload `locationId gid://shopify/Location/77557989479`, `locationName Rubis Kisumu`; `fiscal_status fiscalized`; **`fiscal_invoice_number 0110605040001000810`** (the next number after the device's previous last, `…1000809`); QR a KRA verification URL; `fiscal_fiscalized_at 03-10-2026 03:41:00`, source **`device`**; `fiscal_cu_serial KRAMW011202207060504`; **`fiscal_trader_inv_num LZMO0VON0E5BK3`**; `settings.last_trader_seq 23762883` (seconds from 2026-01-01 to 00:48:03Z, as designed). `receipt_printed_at` NULL (see finding 4).

## 2. Finding 1: the device accepts the new trader number, and every legacy number was refused

From the local fiscal server's log (`http://localhost:4444/log`, a read of the log page only), the `OpenInvoiceWithFreeCustomerData` commands for the last eight attempts are identical except for the last field:
- order 1's attempts: `01; 0;0;1;…;INV-000000001` → the device answers `FP: OK; Command: Illegal.` (STE2 `0x32`), e.g. frames `06 64 30 32 36 36 0A` and `06 8A 30 32 38 38 0A`;
- order 2: `01; 0;0;1;…;LZMO0VON0E5BK3` → **no error; the invoice was opened and filed.**

**Inference (strong, not proven):** the `Illegal command` that has blocked this till and the Haile Selassie till since 29 September (phases 183, 206) was caused by the legacy `INV-<id>` trader number, not by the device's state: a hyphen, or the same string already being known to the shared control unit (both tills number from 1 and send `INV-000000001`). The evidence is the single difference between an accepted and a refused command. **Not verified:** which of the two reasons. Either is consistent with the fix in 2.1.7. **Consequence:** sales created before 2.1.7 hold no stored new-form number, so a retry or resend of them still sends the legacy `INV-<id>` and is expected to be refused again.

## 3. Finding 2: order 1 is back in the automatic retry queue, against "Do not resend"

At 00:35:38Z, 1 minute 47 seconds after 2.1.7 first started, a fiscal retry row was created for order 1 (`sync_queue` id 3, `etims_invoice`, **5 attempts**, next attempt due 00:53:22Z), and `orders.fiscal_status` for order 1 reads **`waiting`** with a fresh `Illegal command`, no longer `needs_fixing`. A hand correction row does not create that: a resend of the sale does (the Resend button in Needs Attention; phase 209 accepted that the button stays on this PC). Under finding 1 these retries are expected to keep failing, so I expect no filing, but **if the device ever accepted `INV-000000001` the 1 KSh test sale would be filed as a real KRA invoice.** **Not run by me:** I changed nothing, because the app was running and a row removed during a retry could leave a filed sale unrecorded. Proposed: close both copies, then restore order 1 to `needs_fixing` and delete its fiscal row, with a backup first (the rule the correction already used).

## 4. Finding 3: two app copies are running against one profile and one device

The installed `RUBIS POS.exe` (started 03:33) and a dev `electron` from `npm run dev` (started 03:47) were both running, on the same `%APPDATA%\rubis-pos-desktop`. The dev log shows `Unable to move the cache: Access is denied` and `Gpu Cache Creation failed`, the signature of a second instance on a locked profile. Both run a fiscal engine and a sync engine against one database and one control-unit session (phase 206 section 1d; the single-instance lock is a separate, unbuilt item). The Shopify order and the fiscal filing for order 2 were each made once (one order for the UUID; one CU number), so no duplicate occurred in this run.

## 5. Finding 4: the VAT table printed on the fiscal slip is wrong, though the filed invoice is right

The slip for order 2 (`RUBIS_Receipt_Order_2.pdf`, Desktop) prints, under "Device figures. Till VAT: 12.41": `A 16% 90.00 14.40 104.40`, i.e. taxable 90.00, VAT 14.40, **gross 104.40**, for a sale of 90.00. The till's log says the same: "the device's VAT groups add up to VAT 14.4 but the till's VAT is 12.41 (difference 1.99). Printed the device figures with a note."
- The device's group A subtotal, stored raw, is `{"A":"90.00",…}`, equal to the gross price sent (`SellPLUfromExtDB … ;A;90;pcs;…;16.00*1`).
- **KRA's public verification page for invoice `0110605040001000810`** (the URL on the slip; read 2026-10-03) shows **total 90, taxable 77.59, tax 12 (12.41 rounded), supplier RUBIS ENERGY KENYA PLC.** So the invoice KRA holds is correct.
- **Conclusion:** the device reports its group subtotal **gross**, and the till treats it as **net** (taxable) when it prints the device-figures table and when it runs the reconciliation, so it adds 16% on top and reports a false mismatch. The golden fixture of phase 198-1 (`discounted`: `A 16% 1,280.17 204.83 1,485.00`) encodes the same net reading. **Not changed here:** it touches the receipt layout tripwires (phases 164, 165, 171) and the reconciliation report (phase 163), and needs its own phase and a ruling. Until then, a customer slip for any sale that reaches this branch shows a wrong VAT table.

## 6. The printing question: why the till did not print the ETR

- The fiscal slip (what the owner calls the ETR) is printed **by the till** on its own thermal printer (`receipt:print` → `printOrderSlips`, phase 206 section 2a), not by the control unit. This PC has **no printer configured**: `printers` is empty, so the app uses the default from `.env`, `VITE_PRINTER_INTERFACE=tcp://192.168.1.50:9100`, an address nothing answers on here, hence the "printer offline" message.
- When the printer is offline the app writes the same slip as a PDF to the Desktop (`printer.ts` offline fallback, `pdf-receipt.ts:123`). `RUBIS_Receipt_Order_2.pdf` (written 03:54:32) holds the full fiscal block: `CU Date/Time 03-10-2026 03:41:00`, `CU Serial No KRAMW011202207060504`, `CU Invoice No 0110605040001000810`, and the KRA verification link. `RUBIS_Receipt_Order_1.pdf` was written at 03:54:28. "Printed once" (`receipt_printed_at`) is only recorded when a real print reached paper, so it stays NULL.
- The control unit is at head office (`154.79.253.245:8000`); nothing the app sends automatically asks it to print, and whether the unit prints at all is not documented (phase 206 section 2b). The "Print ETR copy" button (manager PIN) is the only command that might, and its guard allows only the device's most recent receipt, which is now order 2.

## 7. Rollback

Nothing to roll back: records only.
