# Phase 233 — Every KRA class sold at the pilot tills: audit and the sign-off sheet (read-only)

- **Date:** 2026-10-05
- **Asked by the owner:** add every item of every KRA class from `Rubis_POS_Product_List_Pilot (1).xlsx` so the tills sell, file, print and report them correctly; phase it, audit first; idempotent; nothing that works breaks; no check:fit; KISS and SOLID.
- **Owner rulings (2026-10-05):** I draft a C or E class and an HS name per item and the owner or the accountant signs; of the 4 Excel rows not in Shopify only COKE PET 350ML - SE is added, the other 3 are duplicates; Shopify-side work runs now, till code waits until the other session working in this repo has committed.
- **Status:** audit done. **Nothing written** to Shopify, the device, the till or its database. One section (§6, the device's HS table) waits for the owner's nod because it reads the live control unit.
- **Follows:** [phase 231 (reconciliation, commit a8efab9)](phase-231.md), [phase 194 (per-item VAT, built)](phase-194.md), [phase 214 (device groups are gross)](phase-214.md). Phase numbering: 231-1 and 232 belong to the other session's shift work, so this is 233.

## 0. The short answer

**The till already does per-item VAT.** Phase 194 Part 2 built the chain end to end on 2 Oct and it has shipped since release 2.1.8. What is missing is **data in Shopify** (class, HS code, HS name on the 21 non-16% products, and their status set to Active) and **one live proof** that the shared control unit puts each HS code in the group the class letter claims. Till code changes, if any, come after the proof (phase D in the plan). The classes in the Excel need correcting first: all 21 are marked **B (8%)**, a rate Kenya no longer has for these goods.

## 1. What is already built (verified in the code today)

| Hop | Where | What it does |
| --- | --- | --- |
| Sync | [shopify.ts:44-52](../src/main/services/shopify.ts#L44-L52), `mapTaxFields` | reads product-level `rubis.vat_class`, `rubis.hs_code`, `rubis.hs_name`; a blank value is not carried |
| Cache | `database.ts` `cacheProducts` / `getCachedProducts` | three nullable TEXT columns on `products`; the offline till keeps the class |
| Cart | [lib/cartItem.ts](../src/renderer/src/lib/cartItem.ts) | passes the three fields when present; the cart draft (phase 197) is rebuilt from the catalogue; a held sale (phase 217) stores the whole payload JSON |
| Rule | [lib/vatClass.ts](../src/main/lib/vatClass.ts) | `resolveVatClass`: absent or blank → A; A–E accepted (trimmed, upper-cased); anything else `null` = refused. `HS_CODE_PATTERN` `^\d{4}\.\d{2}\.\d{2}$`. `expectedGroupTotals`, `compareVatGroups` (B–E against the device, before `CloseReceipt`), `grossToVat` |
| Gate | [lib/vatClassGate.ts](../src/main/lib/vatClassGate.ts), run first in `runCheckout` | refuses, **before anything is saved or paid**, a line with an unknown class, or a non-A line whose HS code is malformed or whose HS name is blank; names the item |
| Device | `real-etims-provider.ts` | A → `SellPLUfromExtDB`; B–E → `SellPLUfromExtDB_HS` (NamePLU, Price, HSCode, Quantity). The device takes the group from its own HS table. `MAX_HS_NAME_LENGTH = 20` |
| Receipt | `receiptLayout.ts`, `receiptTotals.ts` | class letter per line; VAT from class-A lines only; VAT table from the stored device groups read as gross (phase 214); footer key per class present. The Enjoy customer slip prints no VAT at all (phase 198, by design) |
| Reports | `reports.ts` `orderVatBase` / `sumVatBase`, `reportsExport.ts` | Z report, daily, sales summary, CSV; reconciliation compares the non-A groups. The window report (the other session's phase 231) has no VAT arithmetic |
| Refresh | `App.tsx`, `AdminScreen.tsx`, `LocationConfirmScreen.tsx` | products are fetched at sign-in, on the Location screen and from the Admin refresh button. **No timer.** A till learns of a Shopify change only on one of those |

**Never run against a device:** a B, C, D or E line, and `ReadHScode`. Phase 194 §6 planned the "spare-till proof" for exactly this; it is phase C of this plan.

**Baseline on today's tree** (`main`, with the other session's 60 modified files present): `npx vitest run tests/vatClass.test.ts tests/vatClassFiscal.test.ts tests/vatClassSync.test.ts tests/vatClassReceiptReports.test.ts tests/vatGroupsGross.test.ts tests/vatReconcile.test.ts` → **6 files, 157 tests, all passing**; `npm run typecheck` clean. The full suite was not run (the other session's uncommitted work is not mine to measure). check:fit not run (owner's rule).

## 2. How products are shaped in Shopify (read 2026-10-05, 735 variants)

| Field | Pattern seen | Note |
| --- | --- | --- |
| SKU | `ENJ-00001` … `ENJ-00734`, contiguous, no gaps | only the phase-209 `test` product has none. **Next free: `ENJ-00735`** |
| Handle | lower-case SKU, e.g. `enj-00035` | the Excel Read me says the SKU builds the web address |
| Title | the Excel title, verbatim (double spaces kept, e.g. `TUZO ESL  450ML`) | |
| Vendor | the Excel vendor | `productType` empty, `category` null |
| Tags | `Enjoy pilot` | |
| Variant | one, `Default Title` | barcode = Excel barcode; price = Excel price; `taxable` **true on A items, false on the 21 B items** |
| Inventory | `tracked`, `inventoryPolicy CONTINUE`, `requiresShipping false`, `unitCost` = Excel cost | stock at Enjoy Haile Selassie on all 735 |
| Status | 714 ACTIVE, 21 DRAFT (the B items) | `publishedAt` null (not on the online store) |
| Metafields | **none**; no `rubis` metafield definitions exist | |
| Token scopes | `write_products, write_inventory, write_orders, read_products, read_inventory, read_orders, read_all_orders, read_locations` | enough for every write in phase B |
| Mutations available (2026-07) | `metafieldDefinitionCreate`, `metafieldsSet` (upsert), `productUpdate`, `productVariantsBulkUpdate`, `productSet` with `identifier {handle}`, `inventoryActivate`, `inventorySetQuantities` | `productSet` by handle is create-or-update, which is what makes the one new product idempotent |

## 3. Sign-off sheet A: the class per item

The Excel marks all 21 as **B**. In the sheet's own legend and in the till, B is 8%. Kenya's 8% VAT rate applied to petroleum products and no longer exists for these goods, so B is a mislabel. Below is my proposal per item: **C = zero-rated** (no VAT, input VAT claimable), **E = exempt** (no VAT, input VAT not claimable). The device treats both as 0%; the difference is the `OptionTaxable` flag of the HS code in its table (§6) and Rubis's own input-VAT position. **The owner or the accountant signs each row; I do not decide tax law.**

| Excel row | Item | HS code (Excel) | Proposed | Basis | Confidence |
| --- | --- | --- | --- | --- | --- |
| 36 | TUZO ESL 450ML | 0039.11.08 | **C** | Second Schedule Part A item 15: milk and cream of 0401.10/.20/.40/.50, not concentrated, no added sugar (Finance Act 2017). KRA's list of 16 Jul 2026 keeps milk zero-rated. ESL and UHT plain milk fall in 0401. | medium: the First Schedule still carries "unprocessed milk" (para 21), and one secondary source lists 0401 under both schedules; the accountant should confirm 0401 is read as zero-rated |
| 37 | MOLO ESL 500ML | 0039.11.91 | **C** | as row 36 | medium; **its HS code differs from the other milks (see §3b)** |
| 38 | BROOKSIDE UHT 250ML | 0039.11.08 | **C** | as row 36 | medium |
| 39 | TUZO TCA 200ML | 0039.11.08 | **C** | as row 36 | medium |
| 41 | BROOKSIDE LONGLIFE FINO 500ML | 0039.11.08 | **C** | as row 36 | medium |
| 72 | ROSY GIRL PADS NORMAL 10S | 0039.11.90 | **E** | First Schedule: sanitary towels (pads) and tampons, 9619.00.10. Moved from zero-rated to **exempt** by the Tax Laws (Amendment) Act 2024, effective 27 Dec 2024. KRA's 16 Jul 2026 list: exempt. | high |
| 164 | KOTEX ULTRATHIN 7'S EXTRA LONG | 0039.11.90 | **E** | as row 72 | high |
| 166 | KOTEX TAMPOONS SUPER 16'S | 0039.11.90 | **E** | as row 72 | high |
| 167 | KOTEX TAMPON NORMAL | 0039.11.90 | **E** | as row 72 | high |
| 273 | ALWAYS ULT EXTRA LONG DUO 8*14 | 0039.11.90 | **E** | as row 72 | high |
| 372 | SOFTCARE HEAVY PADS | 0039.11.90 | **E** | as row 72 | high |
| 424 | KOTEX ULTRATHIN DUOS 8'S LONG LONG | 0039.11.90 | **E** | as row 72 | high |
| 555 | PB WHITE BREAD 400G | 0013.12.02 | **C** | Second Schedule Part A item 13A, "the supply of ordinary bread" (Tax Laws (Amendment) Act 2018). The Finance Bill 2024's 16% proposal was withdrawn. KRA's 16 Jul 2026 list: zero-rated. | high for ordinary white bread |
| 717 | PANADOL ADVANCE | 0039.11.91 | **E** | First Schedule Part I: medicaments of headings 30.03 and 30.04 put up for retail sale (paracetamol is 3004.90). The Finance Act 2025 removed the exemption only for medicaments containing alkaloids (3003.41–3003.49), effective 1 Jul 2025 with approvals honoured to 30 Jun 2026. | medium-high |
| 718 | ENO LEMON | 0039.11.91 | **E** | as row 717 (antacid, 3004.90) | medium-high |
| 723 | ENO TABLETS 2S | 0039.11.91 | **E** | as row 717 | medium-high |
| 725 | PANADOL EXTRA | 0039.11.91 | **E** | as row 717. **Contains caffeine, an alkaloid**: the accountant should confirm it is not caught by the 2025 alkaloid removal (that removal names 3003.4x, unmixed products, not 3004) | medium |
| 162 | MARAMOJA | 0039.11.91 | **E** | as row 725: a paracetamol-caffeine analgesic, same alkaloid question | medium |
| 536 | STREPSILS HONEY AND LEMON 50*2 | 0039.11.91 | **E** | medicated lozenges are 3004.90 when sold as medicaments; if Rubis's supplier invoices them as confectionery (1704) they are 16% (A) | medium-low: **accountant to confirm from the supplier invoice** |
| 546 | STREPSILS REGULAR 50*2 | 0039.11.91 | **E** | as row 536 | medium-low |
| 211 | BUBBLE GUM BOOSTER X STRONG 80MG | 0039.11.16 | **A** (16%) | this is X-Booster energy gum / caffeine pouches, 80 mg caffeine, tobacco-free (nicbud listings). Not a medicament, not on either schedule: standard-rated. Keep its HS code only if the accountant wants one on an A line. | high that it is not B; **the owner decides whether it stays non-A** |

### 3b. Code and class inconsistencies the owner must rule on before anything is loaded

1. **MOLO ESL 500ML (row 37) carries `0039.11.91`**, the code the medicines use, while every other milk is `0039.11.08`. Likely a typo in the Excel. Proposal: `0039.11.08`.
2. **UHT MILK BROOKSIDE 250ML (row 42, barcode 6009610610139) is class A and Active** while BROOKSIDE UHT 250ML (row 38) is B and Draft. One of them is wrong. Row 42 also shows **−2** stock at Haile Selassie.
3. **PB SOFT SANDWICH BREAD X8 (row 556) is A**, PB WHITE BREAD 400G (row 555) is B. "Ordinary bread" covers both unless the sandwich loaf is treated as non-ordinary.
4. **KOTEX PANTY LINERS 20'S (row 165) is A** while every other Kotex item is B. Panty liners are 9619 too.
5. **Condoms (rows 535, 547, 605) are A.** Not on my list to change; mentioned because the accountant may know otherwise.
6. **The 9 rows with no class** (19, 30, 57, 70, 240, 281, 351, 412, 422) stay A: the resolver's default, and the Excel legend says most shop items are A.
7. **BLUEBAND PEANUT BUTTER 100G (row 412):** Excel 90, Shopify 150. Not a class matter; listed so it is not forgotten.
8. **The HS codes themselves (`0039.11.xx`, `0013.12.02`) are not Harmonised System headings** (chapter 00 does not exist). They are the five codes the owner supplied in phase 194 and the device's table is what decides their treatment. §6 is the only test of them that matters.

## 4. Sign-off sheet B: HS names

A non-A line needs an HS name or the till refuses to sell it ([vatClassGate.ts](../src/main/lib/vatClassGate.ts)). The device keeps 20 characters; `sanitizeFiscalText` keeps letters, digits, space and `. , -`. One name per code:

| HS code | Items | Proposed HS name (≤20) |
| --- | --- | --- |
| 0039.11.08 | the four milks (five with Molo, §3b.1) | `Milk` |
| 0039.11.90 | the seven pads and tampons | `Sanitary towels` |
| 0013.12.02 | PB White Bread | `Bread` |
| 0039.11.91 | Panadol ×2, Eno ×2, Strepsils ×2, Maramoja (and Molo unless moved) | `Medicaments` |
| 0039.11.16 | Booster gum | `Energy gum` (only if it stays non-A; an A line needs no name) |

If the device's table already holds a name for a code (§6), that name is used instead, so the slip and the device agree.

## 5. The two blockers before any product goes Active

1. **Both tills must run release ≥ 2.1.8** (the first published build carrying phases 194 and 214). A till below that reads no metafields and would file an exempt item as **A at 16%, permanently**. This PC (Rubis Kisumu) is on 2.2.x. **The build at Enjoy Haile Selassie is for the owner to confirm**; I cannot read it from here.
2. **Each HS code must be in the control unit's table with the expected `OptionTaxable`** (§6). A code that is not there is refused by the device (`0x40`, phase 188 §3.2); the till's gate then cancels the receipt before `CloseReceipt` and the sale lands in Needs Attention, paid but unfiled, with no credit-note path in the POC.

## 6. The control unit's HS table: not readable from this PC; what stands in

**Method tried (owner's nod given 2026-10-05 ~23:00).** `ReadHScode` takes a **position** (`HS_Number`, 1–305) and returns `HS_Code`, `HS_Name`, `OptionTaxable` (1 exempt, 0 taxable), `MesureUnit`, `VAT_Rate` (protocol 2509041522 §2.4.5; [tests/fixtures/tremol-contract.json](../tests/fixtures/tremol-contract.json)). The check is therefore a scan of all 305 positions, one read at a time through ZFPLabServer (`POST http://localhost:4444/`, body `<Command Name="ReadHScode"><Args><Arg Name="Option" Value="Z"/><Arg Name="OptionR" Value="R"/><Arg Name="HS_Number" Value="0001"/></Args></Command>`), as phase 188 ran its reads: app closed, one command at a time, stop on Code 53, raw replies saved outside git.

**Result: no read reached the device.** With RUBIS POS closed on this PC (checked), position 0001 was sent six times between 23:07 and 23:13; every reply was ZFPLabServer's **Code 19, "The Fiscal Printer has open socket. FP refuses new socket connection."** This PC held no TCP connection to the CU's port at any time (checked twice), so the socket the CU was guarding was another client's. The owner then stated that **the control unit is connected only to the live POS** (the Enjoy Haile Selassie till) and is not for reading from here. The retries were stopped at once; nothing further was sent. Raw replies: `C:\rubis-scratch\probe-2026-10-05\`.

**What the documents establish instead** (all read locally or online, none from the device):
- **The table is KRA's list, pushed by Tremol.** KRA's ETR specification v2.0 (14 Jul 2021): "HS Code Table — Over the Air from Manufacturer System"; "Control Unit is capable of updating HS Codes and VAT rates"; and for each invoice line, "HS Code of the Item (Optional) … Mandatory for the Zero Rated and Exempted Items", "HSDesc … not more than 20 characters". So the 305 codes on this CU (phase 188) are Tremol's copy of KRA's exempt and zero-rated tariff list, not something Rubis or Flient loaded.
- **Format.** Every sell command takes `HSCode` as "10 symbols for HS Code in format XXXX.XX.XX" (protocol §2.5.5–2.5.7); a code the CU does not hold is refused with error `40`, "HS code is not valid" (protocol §error table). `AddNewHScode` / `ProgHScode` exist (§2.3.5–2.3.6) but they write to the device: Tremol's or ICT's call, never the till's.
- **Consequence for the Excel's five codes.** `0039.11.08`, `0039.11.91`, `0039.11.90`, `0039.11.16`, `0013.12.02` have the right shape but **are not tariff numbers** (there is no HS chapter 00). A KRA-derived table is keyed by the tariff numbers the VAT Act uses, so these five are very unlikely to be in it, and a sale carrying one would be refused `0x40`. The till's gate then cancels before `CloseReceipt` (phase 194 M3), so nothing would be filed wrongly, but the item could not be sold. **The owner should say where the five codes came from** (phase 194 recorded them as the owner's).
- **Shopify holds nothing on this.** No product carries a metafield, and Shopify has no concept of the CU's table. The only Shopify facts that matter are already in §2.

**Tariff numbers to sign instead, from the Act's own wording (for the table check, then for `rubis.hs_code`):**

| Items | Tariff number proposed | Why |
| --- | --- | --- |
| Tuzo ESL, Molo ESL, Brookside UHT, Tuzo TCA, Brookside Longlife | `0401.20.00` | Second Schedule item 15 lists milk of 0401.10/.20/.40/.50 by fat content; whole milk (1–6% fat) is 0401.20.00 |
| the seven pads and tampons | `9619.00.10` | the First Schedule names this tariff number for sanitary towels (pads) and tampons |
| PB White Bread 400G | **unknown**: item 13A reads "the supply of ordinary bread" with no tariff number; 1905.90.00 is the HS heading for bread | the table scan (below) is the only way to see which code Tremol loaded for bread |
| Panadol ×2, Eno ×2, Strepsils ×2, Maramoja | `3004.90.00` | First Schedule: medicaments of heading 30.04 put up for retail sale; "other" medicaments are 3004.90 |
| Booster energy gum | none | proposed class A (§3); an A line needs no HS code |

**How the table can still be read, in order of preference:**
1. **Run the same scan on the Enjoy Haile Selassie till**, whose ZFPLabServer is the CU's one client: the owner closes RUBIS POS there (off hours), runs the script in Appendix A in PowerShell, and sends back `hs-table.csv` (305 rows: position, code, name, taxable flag, unit, rate). Read-only; about one minute; the same Code 53 / Code 19 stops apply.
2. **Ask Tremol / VIL for the HS list loaded on CU serial `KRAMW011202207060504`** (the manufacturer system pushes it, so they have it), together with whether a code can be added for an item that is missing.
3. **Fall back to the phase C proof alone**: one 1 KSh sale per code on the live till; a wrong or missing code is refused `0x40` before filing and the item goes back to Draft. Safe, but each refusal is a paid-and-unfiled sale to clear by hand, so 1 or 2 first.

Until one of these has been done, **§5 blocker 2 stands** and no product goes Active.

## 7. Edge-case register

| # | Case | Today | Action |
| --- | --- | --- | --- |
| 1 | Typo class in a metafield (`e`, ` E`, `Z`) | `e` → E; `Z` refused at checkout, item named, nothing saved | handled; phase B's definitions restrict `vat_class` to A–E so a typo cannot be saved in Shopify either |
| 2 | Class set, HS code blank or malformed, or HS name blank | refused before pay | handled; phase B flips a product Active only after its three metafields read back |
| 3 | HS code not in the device table | `0x40` → cancel before `CloseReceipt` → Needs Attention, paid, unfiled | §6 scan first; phase C proves; rollback is DRAFT |
| 4 | Device puts the amount in a different group than the letter | `compareVatGroups` cancels before `CloseReceipt` | handled; phase C proves |
| 5 | Mixed basket A + C + E | VAT from A lines; table from device groups (gross); footer keys | handled (phase 194 tests); phase C proves live |
| 6 | Discount or price override on a non-A line | refused ("Discounts cannot be filed with KRA yet") | handled |
| 7 | Offline till | class columns in the SQLite cache | handled |
| 8 | Held sale made before the till refreshed, released after | keeps the class it had | the 21 are Draft today, so none can be in a held sale; after the switch both tills refresh at once (phase C step 0) |
| 9 | Cart draft restore after restart | rebuilt from today's catalogue | handled |
| 10 | Retry, resend, reprint | from the stored `fiscal_request_json` | handled: the class is fixed at checkout |
| 11 | Shopify's own order tax | no tax lines sent; Shopify uses the variant's `taxable` | the 21 are already `taxable:false`; an A item stays `true` |
| 12 | A till below 2.1.8 | files E as A at 16% | **blocker §5.1** |
| 13 | Two sessions in one working tree | — | no till code in phases A–C; phase numbers re-checked at write time |
| 14 | Re-running a phase B step | — | diff first, write only what differs, read back |
| 15 | A `rubis` definition already exists with another type | — | stop and report; never overwrite |
| 16 | The `test` product (phase 209) | active, price 1.00, no SKU | untouched; for the owner to archive |
| 17 | A product's class changes later in Shopify | the till keeps the old class until refreshed | the Admin refresh button; a timer is phase D only if the owner wants it |
| 18 | `VITE_TAX_RATE` unset on a till | class A sent at `VATGrRate 0.00` (phase 194 §9.1) | unchanged; phase D candidate, owner's call |

## 8. What phase B will write (for the record; nothing written yet)

In order, each read back, each a no-op on a second run: (B1) three `rubis` metafield definitions on PRODUCT (`vat_class` single-line text, choices A–E; `hs_code` single-line text, regex `^\d{4}\.\d{2}\.\d{2}$`; `hs_name` single-line text, max 20); (B2) `metafieldsSet` of the signed class, code and name on each of the 21; (B3) `taxable` false on C/E items, true on A (already so); (B4) `productSet` by handle `enj-00735` for COKE PET 350ML - SE (price 60, vendor COCA-COLA BEVERAGES KENYA LIMITED, tag `Enjoy pilot`, Draft, tracked, CONTINUE, no shipping), activated at Enjoy Haile Selassie and Rubis Kisumu with 0 stock unless the owner gives a count; (B5) **status Active**, last, in one go, on a separate GO line from the owner, only after §5 is cleared and B2 has read back; (B6) the phase-231 read-back repeated. Rollback: status back to Draft restores the tills' view; `metafieldsDelete` and `productDelete` if wanted.

## 9. Verification, rollback, not done

- **Run:** the Excel read (zipfile + XML), Shopify reads (locations, 3 pages of variants, scopes, definitions, two sample products, type introspection), the six VAT test files, typecheck. Sources for §3: EY on the Tax Laws (Amendment) Act 2024 (sanitary items zero-rated → exempt, 27 Dec 2024); KRA's updated list as reported 16 Jul 2026 (milk and ordinary bread zero-rated, sanitary towels exempt); EY and PKF on the Finance Act 2025 (medicaments 3003.41–49 exempt → 16%, 1 Jul 2025, transition to 30 Jun 2026); the VAT Act schedules as reproduced by vatakenya (Second Schedule items 13A and 15; First Schedule 9619.00.10 and headings 30.03/30.04). Kenya Law's consolidated text refused the fetch (403), so the paragraph numbers come from secondary copies: **the accountant should check them against the Act.**
- **Not run:** anything that writes; a sale; the full suite. `ReadHScode` was attempted six times and never reached the device (§6, Code 19).
- **Rollback:** nothing to roll back; delete this file.
- **Not done, by ruling:** the 3 duplicate Excel rows (142, 517, 604); Blueband's price; row 42's stock; archiving `test`; programming the control unit's HS table (Tremol / ICT).

## Appendix A. The read-only HS-table scan, for the live till

Run in PowerShell on the Enjoy Haile Selassie till with RUBIS POS closed and ZFPLabServer running. It sends one `ReadHScode` per position, waits for each reply, stops on Code 53 (no session: press Admin → Integrations → Test Connection once in the app, then run again) or Code 19 (the CU is busy with another client), retries a Code 34 once, and writes `hs-table.csv` plus every raw reply (IPv4 addresses and any `<password>` redacted) to the output folder. It sends nothing else.

```powershell
param([int]$From = 1, [int]$To = 305, [string]$OutDir = "$env:USERPROFILE\Desktop\hs-scan")
New-Item -ItemType Directory -Force $OutDir | Out-Null
$url = 'http://localhost:4444/'
$rows = @()
for ($n = $From; $n -le $To; $n++) {
  $num = $n.ToString('0000')
  $body = "<Command Name=""ReadHScode""><Args><Arg Name=""Option"" Value=""Z""/><Arg Name=""OptionR"" Value=""R""/><Arg Name=""HS_Number"" Value=""$num""/></Args></Command>"
  $attempt = 0
  do {
    $attempt++
    try { $raw = (Invoke-WebRequest -Method Post -Uri $url -ContentType 'text/plain' -Body $body -UseBasicParsing -TimeoutSec 30).Content } catch { $raw = "HTTPERROR " + $_.Exception.Message }
    $redacted = $raw -replace '\b\d{1,3}(\.\d{1,3}){3}\b', '[ip]' -replace '<password>.*?</password>', '<password>[redacted]</password>'
    [IO.File]::WriteAllText("$OutDir\readhscode-$num-$attempt.xml", $redacted)
    $code = if ($raw -match 'Code="(\d+)"') { [int]$matches[1] } else { -1 }
  } while ($code -eq 34 -and $attempt -lt 2)
  $get = { param($name) if ($raw -match "Name=""$name""[^>]*Value=""([^""]*)""") { $matches[1] } else { '' } }
  $rows += [pscustomobject]@{ Pos = $num; Code = $code; HS_Code = (& $get 'HS_Code'); HS_Name = (& $get 'HS_Name'); Taxable = (& $get 'OptionTaxable'); Unit = (& $get 'MesureUnit'); Rate = (& $get 'VAT_Rate') }
  if ($code -eq 53 -or $code -eq 19) { Write-Output "STOP: Code $code at position $num"; break }
}
$rows | Export-Csv -NoTypeInformation -Encoding UTF8 "$OutDir\hs-table.csv"
Write-Output ("rows {0}; Code 0: {1}" -f $rows.Count, ($rows | Where-Object Code -eq 0).Count)
```
