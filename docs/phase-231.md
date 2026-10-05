# Phase 231 — The pilot product list against Shopify at Enjoy Haile Selassie (read-only)

- **Date:** 2026-10-05
- **Asked by the owner:** check the Haile Selassie location and confirm the KRA zero-rated items in `Rubis_POS_Product_List_Pilot (1).xlsx` were added to Shopify; report what is on the Excel but not on Shopify.
- **Owner's choices:** check all 725 rows and show the non-16% rows apart; Shopify Admin API, reads only; "added" means **the product exists, is active, and has an inventory record at Enjoy Haile Selassie**.
- **Status:** done. **Nothing was written** to Shopify, the till or its database. The app was not started.
- Follows [phase 230](phase-230.md).

## 0. Answer

- **The Excel has no zero-rated (class C) item.** Its 30 non-A rows are 21 class **B** (8% in the sheet's own legend and in the till's `vatClass.ts`) and 9 with no class. The B rows are milk, sanitary pads and tampons, bread and over-the-counter medicines with KRA HS codes: the items that look zero-rated or exempt.
- **All 21 class B items are in Shopify, but as Draft.** Each has stock recorded at Enjoy Haile Selassie, and price matches the Excel. The till loads `status:active` products only ([shopify.ts:29](../src/main/services/shopify.ts#L29)), **so none of the 21 can be scanned or sold at either till today.** That matches the Excel's own pilot rule ("classes B to E … must not be sold on the pilot till until per-item VAT is switched on").
- **No product carries `rubis.vat_class` or `rubis.hs_code`** (0 of 735 variants), as phase 194 required for the pilot.
- **The 9 no-class rows are active and stocked**, so the till files them as class A at 16%.
- **4 class A rows are not in Shopify.** All four have no barcode and are near-duplicates of other Excel rows that are in Shopify (§3).
- The other **691 class A rows are added**: active and stocked at Haile Selassie.

| | Rows |
| --- | --- |
| Excel item rows | 725 |
| Added (active, stocked at Haile Selassie) | 700 (691 A + 9 no class) |
| In Shopify as Draft, not on the till | 21 (all class B) |
| Not in Shopify | 4 (class A) |
| Shopify variants read | 735 (714 active, 21 draft); 735 have a Haile Selassie inventory record |
| Shopify variants with no Excel row | 14 (§5) |

## 1. Class B items (the presumed zero-rated or exempt items): in Shopify as Draft

Stock is Haile Selassie `available`. All matched by barcode except row 725 (by title; the Excel has no barcode).

| Excel row | Title | Barcode | Price | HS code | Shopify | HS stock |
| --- | --- | --- | --- | --- | --- | --- |
| 36 | TUZO ESL 450ML | 6161101680424 | 70 | 0039.11.08 | Draft | 0 |
| 37 | MOLO ESL 500ML | 6161102794694 | 70 | 0039.11.91 | Draft | 0 |
| 38 | BROOKSIDE UHT 250ML | 6009610610191 | 65 | 0039.11.08 | Draft | 15 |
| 39 | TUZO TCA 200ML | 6161101680288 | 45 | 0039.11.08 | Draft | 0 |
| 41 | BROOKSIDE LONGLIFE FINO 500ML | 6161101000543 | 85 | 0039.11.08 | Draft | 4 |
| 72 | ROSY GIRL PADS NORMAL 10S | 6161100761230 | 85 | 0039.11.90 | Draft | 36 |
| 162 | MARAMOJA | 6161101512336 | 20 | 0039.11.91 | Draft | 97 |
| 164 | KOTEX ULTRATHIN 7'S EXTRA LONG | 5029053569819 | 160 | 0039.11.90 | Draft | 3 |
| 166 | KOTEX TAMPOONS SUPER 16'S | 5029053534817 | 400 | 0039.11.90 | Draft | 3 |
| 167 | KOTEX TAMPON NORMAL | 5029053534800 | 500 | 0039.11.90 | Draft | 3 |
| 211 | BUBBLE GUM BOOSTER X STRONG 80MG | 5906670984716 | 850 | 0039.11.16 | Draft | 3 |
| 273 | ALWAYS ULT EXTRA LONG DUO 8*14 | 700216622967 | 300 | 0039.11.90 | Draft | 17 |
| 372 | SOFTCARE HEAVY PADS | 6164004723144 | 100 | 0039.11.90 | Draft | 11 |
| 424 | KOTEX ULTRATHIN DUOS 8'S LONG LONG | 5029053569802 | 290 | 0039.11.90 | Draft | 1 |
| 536 | STREPSILS HONEY AND LEMON 50*2 | 8850360310118 | 40 | 0039.11.91 | Draft | 0 |
| 546 | STREPSILS REGULAR 50*2 | 6161100954229 | 40 | 0039.11.91 | Draft | 12 |
| 555 | PB WHITE BREAD 400G | 6161300140187 | 65 | 0013.12.02 | Draft | 66 |
| 717 | PANADOL ADVANCE | 6168686102525 | 20 | 0039.11.91 | Draft | 138 |
| 718 | ENO LEMON | 6164004605426 | 20 | 0039.11.91 | Draft | 64 |
| 723 | ENO TABLETS 2S | 6168686100149 | 20 | 0039.11.91 | Draft | 46 |
| 725 | PANADOL EXTRA | (none) | 20 | 0039.11.91 | Draft | 51 |

The Excel gives no HS name for any of them.

## 2. Rows with no VAT class: active, sold as class A

| Excel row | Title | Barcode | Price | HS stock | Note |
| --- | --- | --- | --- | --- | --- |
| 19 | AQUAMIST EMPTY BOTTLE 18.9 L | (none) | 1200 | 3 | matched by title |
| 30 | JUICY FRUIT BIG GS | (none) | 5 | 0 | matched by title |
| 57 | DELAMERE PEAR YOGHURT 450ML | 6164000033209 | 195 | 2 | |
| 70 | NIVES NOURISHING COCOA 400ML | `4800888220851>` | 600 | 1 | stray `>` in the Excel barcode |
| 240 | TIC TAC INTENSE MINT 16G | 80052883 | 70 | 0 | |
| 281 | BALLS | 035051119227 | 2250 | 1 | |
| 351 | PICK N PEEL PINEAPPLE 250ML | 6161110810461 | 95 | 6 | |
| 412 | BLUEBAND PEANUT BUTTER 100G | 61614000 | **90** | 4 | **Shopify price 150** |
| 422 | COMFY TISSUE 4 PACK | `0792382644643>` | 330 | 1 | stray `>` in the Excel barcode |

## 3. Class A rows not in Shopify

None has a barcode, so each was searched by title, exact and then fuzzy. Each one's nearest Shopify product is already matched to a different Excel row, so these look like duplicate rows in the Excel, not lost products.

| Excel row | Title | Price | Nearest Shopify product, and the Excel row it belongs to |
| --- | --- | --- | --- |
| 97 | COKE PET 350ML - SE | 60 | COKE PET 350ML, row 92, price **70**. "SE" at 60 may be a separate item. |
| 142 | NON WOOVEN (BIG) | 50 | NON WOOVEN BIG, row 143, price 50 |
| 517 | KENYA CANE LEMON GINGER 750ML | 1100 | KENYA CANE LEMON & GINGER 750ML, row 518, price 1100 |
| 604 | BALOZI CAN | 300 | BALOZI LARGER CAN 500ML, row 464, price 300 |

## 4. Data issues found on the way

1. **B is used where C (zero-rated) or E (exempt) seems meant.** In the sheet legend and in `vatClass.ts`, B = 8%. In Kenya the 8% rate applies to petroleum products, not milk, pads, bread or medicines. The classes need confirming against KRA's current schedules before any metafield is set.
2. **Similar items, different classes:**
   - Row 42 UHT MILK BROOKSIDE 250ML (barcode 6009610610139 in Shopify) is class A and active, while row 38 BROOKSIDE UHT 250ML is class B and Draft.
   - Row 556 PB SOFT SANDWICH BREAD X8 is A, while row 555 PB WHITE BREAD 400G is B.
   - Row 165 KOTEX PANTY LINERS 20'S is A, while the other Kotex rows are B.
   - The condom rows (535, 547, 605) are A; whether condoms are exempt is worth confirming at the same time.
3. **Row 42 shows −2 available at Haile Selassie**, the only negative stock among the matched rows.
4. **Barcodes:** 34 rows have none (30 matched by title, 4 not found). Two rows have a stray `>` (rows 70, 422). Row 473 CHROME BRANDY 250ML has barcode 6161101609845 in the Excel but none in Shopify.
5. **SKU is blank on every row**, though the Read me sheet marks it required.
6. **Price:** one mismatch among matched rows (row 412, above).
7. **The Checks sheet's saved totals are all 0**: its formulas were never recalculated before the file was sent.

## 5. Shopify variants with no Excel row (14)

All active and stocked at Haile Selassie: `test` (the phase 209 item, price 1.00), BASIL SEEDS S/BERRY 290ML, six DUREX items (EXTRA SAFE 3, FETHERLITE 12'S and 3'S, PLAY CHERRY GEL 50ML, PLEASURE ME, TINGLE GEL 50ML), INDIGO BLUE 4MG MINI, INDIGO BLUE 6MG MINI, JADE GREEN 6MG MINI, KING EGG 7G, PB QUEEN CAKE VANILLA X4, PB SWEET MANDAZI 150G.

## 6. Method

- **Excel:** the Products sheet was read with a short Python script (zipfile and XML; openpyxl is not installed). A row counts if it has a title or a barcode: 725 rows.
- **Shopify:** `curl.exe` POSTs to `admin/api/2026-07/graphql.json`, token from `.env.secrets.local`, never printed or saved. All queries, no mutations:
  1. `locations(first: 50, includeInactive: true)`: `gid://shopify/Location/78361919591` is **Enjoy Haile Selassie**.
  2. `productVariants(first: 250)`, 3 pages, every status: variant id, title, barcode, price, product status, the `rubis.vat_class` and `rubis.hs_code` metafields, and `inventoryItem.inventoryLevel(locationId: Haile Selassie)` `available` and `on_hand`.
- **Matching:** barcode first, after stripping non-alphanumerics, which removes the `>`. Then the exact title, case and spacing ignored. Then a leading-zero-tolerant barcode. No Excel row matched two variants, and no variant matched two rows.
- **Checks:** AQUAMIST PINEAPPLE 500ML (sold in phase 210-3) matched variant `…50363388100711`, active, 7 available. The counts add up (700 + 21 + 4 = 725). The 714 active variants equal the till's cached product count (phase 209-2).

## 7. Not done (each needs an owner go)

- Setting any product from Draft to Active.
- Setting `rubis.vat_class`, `rubis.hs_code` or `rubis.hs_name`.
- Changing class B to C or E.
- Adding the 4 rows in §3.
- Fixing the price on row 412 or the stock on row 42.

Phase 194 says no pilot product gets a VAT class metafield until the per-item VAT proof passes on the spare till.
