# Phase 207 — a shared control unit: can this till ever mark, or print, another till's sale? (read-only audit)

- **Date:** 2026-10-03
- **Requested:** read-only, eight items, for the case where a second Flient installation files sales to the same G03 and its `local_id` sequence overlaps ours. Goal: this till never marks a sale filed with a number that belongs to another till's sale, and never prints a fiscal slip for a sale it did not close itself. Propose, do not build.
- **Outcome:** **Today the till can do both.** Three facts decide it: `ReadCUinvoiceNumber` has no argument that ties it to a sale, so on a collision it would return the other till's number; the retry path stores whatever non-empty number comes back with no other check; and the slip prints as a fiscal receipt from the number alone. The vendor definitions do contain a stronger check (`ReadEJByTraderSystemInvNum_JSON`), and **the project already holds a real device reply in that report family**, so its fields are known. Details, the guard-by-guard assessment, a uniqueness proposal and ten decisions are below.
- **Changes made:** none to code, config, fixtures or tests. This document is the only file added.
- **Calls made to the device or server in this phase:** **none.** Everything quoted from the fiscal server's log is from the copy fetched in [phase 206](phase-206.md); everything else is files.
- **Branch / base commit:** staging @ `60406a1`, tree clean at the start (`git status --short` printed nothing).

## 1. The trader invoice number

**It is `INV-<local_id>` and nothing in it identifies the till.** `INV-` plus the local order id zero-padded to nine digits, e.g. `INV-000000001`: 13 characters. [real-etims-provider.ts:1810-1818](../src/main/services/integrations/real-etims-provider.ts#L1810-L1818). `local_id` is `INTEGER PRIMARY KEY AUTOINCREMENT` ([database.ts:704](../src/main/services/database.ts#L704)), so it is unique within one database and restarts at 1 in a fresh one.

**Every place that builds it: four, not two** (phase 158 counted the first two):

| # | Where | What |
| --- | --- | --- |
| 1 | the provider, private `buildTraderSystemInvNum` ([real-etims-provider.ts:1810](../src/main/services/integrations/real-etims-provider.ts#L1810), called at [:1796](../src/main/services/integrations/real-etims-provider.ts#L1796)) | what is **sent** to the device; `.slice(0, 15)` |
| 2 | the shared helper ([traderSystemInvoiceNumber.ts:28-37](../src/main/lib/traderSystemInvoiceNumber.ts#L28-L37)), a deliberate byte-for-byte duplicate of #1, kept in step by `tests/traderSystemInvoiceNumber.test.ts` | what is **shown**: [reports.ts:1023](../src/main/services/reports.ts#L1023), [reportsExport.ts:115](../src/main/services/reportsExport.ts#L115) and [:175](../src/main/services/reportsExport.ts#L175), [index.ts:3599](../src/main/index.ts#L3599) (invoice list). It recomputes from `local_id` and **ignores the stored `fiscal_trader_inv_num`** that phase 198 added. |
| 3 | the mock provider, inline ([mock-etims-provider.ts:116](../src/main/services/integrations/mock-etims-provider.ts#L116)) | same string, for the recorder |
| 4 | credit notes: the provider takes a caller-supplied `traderSystemInvNum` ([real-etims-provider.ts:2137](../src/main/services/integrations/real-etims-provider.ts#L2137), [etims.ts:124](../src/main/services/integrations/etims.ts#L124)); **no caller exists in `src/`** | not built here at all |

When no `localId` exists the builder falls back to the dash-stripped `clientOrderUuid`, cut to 15. **Every build site truncates silently** (`slice`, and `sanitizeFiscalText` cuts again, [fiscal-sanitize.ts:42-46](../src/main/services/integrations/fiscal-sanitize.ts#L42-L46)), so a longer number would be shortened into a collision rather than refused.

**Every place that parses it: none.** `grep` finds no regex or split on the string anywhere in `src/`; it is only built, stored (`orders.fiscal_trader_inv_num`, written before each send by the recorder, [real-etims-provider.ts:1100](../src/main/services/integrations/real-etims-provider.ts#L1100), [:1826-1837](../src/main/services/integrations/real-etims-provider.ts#L1826-L1837)) and printed.

**The device's `MaxLen` and type, from the defs blob** (the SDK's own `var defs = '<Defs>…'` in `DEMOS/JS/js/fp/fp.js:1472`, parsed; the repo fixture `tests/fixtures/tremol-defs.xml` has the identical structure for every command quoted in this document, checked name by name, type, value, `MaxLen` and options, 0 differences):

```
OpenInvoiceWithFreeCustomerData              ARG TraderSystemInvNum   Type=Text MaxLen=15
OpenCreditNoteWithFreeCustomerData           ARG TraderSystemInvNum   Type=Text MaxLen=15   (RelatedInvoiceNum Type=Text MaxLen=19)
OpenDebitNoteWithFreeCustomerData            ARG TraderSystemInvNum   Type=Text MaxLen=15   (RelatedInvoiceNum MaxLen=19)
OpenReceipt / OpenSellAndCloseReceipt / OpenSellAndCloseInvoice   ARG TraderSystemInvNum Type=Text MaxLen=15
ReadEJByTraderSystemInvNum, ReadEJByTraderSystemInvNum_JSON, StoreEJByTraderSystemInvNum   ARG TraderSystemInvNum Type=Text MaxLen=15
```

So there are **two spare characters** today (13 of 15). The characters that survive our sanitiser are `[A-Za-z0-9 .,-]`.

## 2. `ReadCUinvoiceNumber`, precisely

From the defs blob (`CmdByte 0x5D`):

```
FPOperation: Request for original invoice number in case of open receipt rejection due to duplicate
             TRADER SYSTEM INVOICE NUMBER and response received.
ARG  Name='Option' Type=OptionHardcoded Value='I' MaxLen=1                   ArgsFormatRaw: <Option['I']>
RES  Name='Option' Type=OptionHardcoded Value='I' MaxLen=1
RES  Name='CU_InvoiceNumber' Type=Text MaxLen=19  Desc: 19 symbols for CU Invoice number
ResFormatRaw: <Option['I']><;> <CU_InvoiceNumber[19]>
```

- **It is not keyed to a trader invoice number.** Its only argument is the hardcoded letter `I`. There is nowhere to say which sale is meant.
- **It is not "the device's last invoice" either.** Two real replies in the server log: `;0110605040000000000;` at 00:37:09 and again at 10:48:48 on an earlier day, while the device's last invoice was `0110605040001000809` (`ReadLastAndTotalReceiptNum`, 00:38:40). So it answers from some device-side state about the most recent rejected open, and gave an all-zero number when there was nothing to give. The definition says only "original invoice number in case of … duplicate"; how the device chooses is **not documented**.
- **Therefore the recovery path can return another till's number.** If a collision on `INV-n` is real, the "original invoice" the device means is the *other* till's, and it answers with that till's CU number, which the recovery stores as ours. **Inference** (basis: the definition's own wording plus the absence of any key); not observed, since no live duplicate has ever been captured ([real-etims-provider.ts:1516](../src/main/services/integrations/real-etims-provider.ts#L1516)).
- **It exists only under `defVer=2509041522`.** The older definitions (`2204120945`) do not declare it, nor the two EJ commands in section 4.

## 3. The recovery path, end to end

**Who sets `fiscal_status = 'fiscalized'`.** One SQL statement, `setOrderFiscalInfo` ([database.ts:2326-2336](../src/main/services/database.ts#L2326-L2336)), reached from exactly three places. Each takes the `ok: true` data of `submitInvoice` unchanged:

| Caller | When |
| --- | --- |
| [checkout.ts:642](../src/main/services/checkout.ts#L642) `settleCheckoutFiscalSuccess` ([database.ts:1977-1979](../src/main/services/database.ts#L1977-L1979)) | the first attempt, at checkout |
| [fiscal-engine.ts:168](../src/main/services/fiscal-engine.ts#L168) `markFiscalQueueItemSynced` ([database.ts:1887-1902](../src/main/services/database.ts#L1887-L1902)) | a queued retry |
| [fiscal-retry.ts:223](../src/main/services/fiscal-retry.ts#L223) | manual resend and the correct-PIN resend |

`submitInvoice` has **two** `ok: true` returns ([real-etims-provider.ts:1117](../src/main/services/integrations/real-etims-provider.ts#L1117) and [:1269](../src/main/services/integrations/real-etims-provider.ts#L1269)):

| Producer | Evidence it accepts | Could that evidence come from another till? | QR |
| --- | --- | --- | --- |
| **Normal**, after `CloseReceipt` ([:1235-1280](../src/main/services/integrations/real-etims-provider.ts#L1235-L1280)) | a `CloseReceipt` reply with a **non-empty** `InvoiceNum` ([xml-utils.ts:192-197](../src/main/services/integrations/xml-utils.ts#L192-L197): `if (parsed[key]) return`). No format check. | Only if the CU lets another client's receipt interleave with ours; the lock covers this process only ([phase 184](phase-184.md) §"New context"), and whether the CU keeps clients' receipts apart is **VIL question 6, unanswered**. **Not verified.** | `extractQrCodeFromXml(...) ?? ''` ([:1273](../src/main/services/integrations/real-etims-provider.ts#L1273)): **a missing QR is accepted and stored as an empty string.** |
| **Recovery**, "already-filed" ([:1103-1128](../src/main/services/integrations/real-etims-provider.ts#L1103-L1128), decided at [:1558-1561](../src/main/services/integrations/real-etims-provider.ts#L1558-L1561)) | an `OpenInvoice` rejection **on a retry, of any kind**, then a `ReadCUinvoiceNumber` reply that is **non-empty**. Nothing else: not the trader number, not the total, not the time. | **Yes**, by section 2. | `qrCode: ''`, always ([:1117-1123](../src/main/services/integrations/real-etims-provider.ts#L1117-L1123)); also `local-fallback` time, no VAT groups. |

Two things the code does that matter here:
- The trigger is **"open rejected on a retry"**, not "open rejected as a duplicate". The device's code for a duplicate trader number has never been captured, so the code cannot tell the two apart. That is how an unrelated STE2 `0x32` refusal reached the recovery in [phase 206](phase-206.md).
- Nothing on the way in is stopped by the database: `fiscal_invoice_number` is write-once (`COALESCE`) and the index on it is **not unique** ([database.ts:747](../src/main/services/database.ts#L747)), so two orders can hold the same CU number and nothing notices.

**Your expectation, confirmed with two corrections.** Confirmed: recovery captures no QR (`qrCode: ''`), and order 1 stored an empty QR. Corrections:
1. **Order 1 did not print.** There is no printer configured here and `receipt_printed_at` is NULL. It *would* have printed as a `FISCAL RECEIPT` with no QR lines, because the layout decides on the number alone ([receiptLayout.ts:371](../src/main/lib/receiptLayout.ts#L371)) and prints the QR only if one is stored ([:520](../src/main/lib/receiptLayout.ts#L520)).
2. **A missing QR does not identify a recovered sale**, because the normal path also stores one (table above). In practice a real `CloseReceipt` returns a QR (`MaxLen=128`), but **no real `CloseReceipt` reply is on file in this project**: the only sample is a fixture, and the go-live check "a QR that is not prefixed `MOCK-QR-`" is listed as an open check there ([GO_LIVE_READINESS.md](GO_LIVE_READINESS.md), item 1 of its verification table).

**Where the till prints a fiscal slip, and what each gate trusts:**

| Gate | Trusts |
| --- | --- |
| [receiptLayout.ts:371](../src/main/lib/receiptLayout.ts#L371), [receiptFiscalBlock.ts:84-87](../src/main/lib/receiptFiscalBlock.ts#L84-L87) | the stored number alone |
| [printer.ts:193-198](../src/main/services/printer.ts#L193-L198) (`shouldMarkReceiptPrinted`), [:872-877](../src/main/services/printer.ts#L872-L877) (`kraNoteFor`) | the stored number |
| [late-filed-slip.ts:51](../src/main/services/late-filed-slip.ts#L51), [printer.ts:213-218](../src/main/services/printer.ts#L213-L218) | `fiscal_status` |

## 4. The stronger check in the definitions

`ReadEJByTraderSystemInvNum` and `_JSON` are in the vendor definitions (SDK_RECON.md §9.4, which lists both among the 32 commands absent from our contract) and **absent from the older `2204120945` definitions**. Quoted from the blob:

```
ReadEJByTraderSystemInvNum   CmdByte=0x7C   Response ACK="true" ACK_PLUS="true"      (no <Res> fields)
FPOperation: Read Electronic Journal Report by Trader System Invoice Number (Single Invoice).
  ARG ''                              OptionHardcoded 'J0'
  ARG OptionTraderSystemReportFormat  Option MaxLen=1   's'=Brief EJ  'S'=Detailed EJ
  ARG TraderSystemInvNum              Text MaxLen=15    "15 symbols for trader system invoice number"
  ArgsFormatRaw: <'J0'> <;> <TraderSystemReportFormat[1]> <;> <TraderSystemInvNum[15]>

ReadEJByTraderSystemInvNum_JSON   CmdByte=0x7C
FPOperation: … in the JSON format. The number of bytes equal to Length for JSON data must be read subsequently.
  ARG ''  OptionHardcoded 'JY'   ARG OptionTraderSystemReportFormat (as above)   ARG TraderSystemInvNum Text MaxLen=15
  RES ''  OptionHardcoded 'JY'   RES ''  OptionHardcoded 'Z'   RES Length  Decimal MaxLen=10  "Up to 10 symbols for length"
  ResFormatRaw: <'JY'> <;> <'Z'> <;> <Length[1..10]>
```

- **Plain variant:** `output: ACK+`, "Output data: n. a." (protocol §2.7.16). The journal text follows outside any declared field, and `ACK+` is defined nowhere in these files, so there is nothing to parse against.
- **JSON variant:** the reply is only `JY;Z;<Length>`; the JSON itself is then read with `RawRead(Count, EndChar)` (`Bytes`, Base64, up to 100,000). **The definitions do not describe the JSON.**
- **But the project holds one real reply in this report family.** On 2026-09-29, 19:47-19:48, someone ran `ReadEJByDate_JSON` (22-29 Sep) then `RawRead` through the ZFPLabServer page; the server log (lines 76-130) kept it. Its content, verbatim:

```
{"REPORT":{"DATA":{"INVOICES":[{"TraderSystemInvoiceNumber":"101","MiddlewareInvoiceNumber":"0110605040001000809",
 "RelevantInvoiceNumber":"","QRCode":"0110605040001000809","Discount":"0.00","InvoiceType":"Original",
 "InvoiceCategory":"Tax Invoice","InvoiceDate":"2026-09-22T15:03:41","PINOfBuyer":"","ExemptionNumber":"null",
 "TotalInvoiceAmount":"10.00","TotalTaxAmount":"1.38","TotalTaxableAmount":"8.62",
 "ItemDetails":[{"HSCode":"","HSDesc":"Test001","Category":"Taxable","Quantity":"1.00","UnitPrice":"8.62",
                 "ItemAmount":"8.62","TaxRate":"16.00","TaxAmount":"1.38"}]}]}}}
```
  followed by 24 bytes that are not JSON (the reply was `Length=605`; the JSON text is 573 characters), so a reader must cut at the end of the JSON.

**Would a reply let us confirm the device's entry is ours?** Yes for all four, and more, **if** the by-trader-number reply has the same layout as this by-date one (**Inference**: same report family, same `INVOICES` array; this exact command's reply has never been seen):

| Test | Field | Compare with |
| --- | --- | --- |
| same trader number | `TraderSystemInvoiceNumber` (exact string) | the number we sent |
| same total | `TotalInvoiceAmount` (`"10.00"`) | `order.total` |
| same time window | `InvoiceDate` (`2026-09-22T15:03:41`, device clock) | the order's attempt window; the device clock ran about six minutes slow on 29 Sep ([phase 188](phase-188.md)), so the window needs a margin |
| same line count | `ItemDetails.length` | the order's lines; also `HSDesc`, `Quantity`, `UnitPrice` per line |
| **the number we want** | `MiddlewareInvoiceNumber` (19 digits) | stored as `fiscal_invoice_number` |

Limits, stated plainly:
- **Same trader number alone is not proof it is ours**; that is the whole problem. Total, lines and time narrow it; only the uniqueness scheme in section 6 removes it.
- **The journal's `QRCode` in that sample is the 19-digit invoice number, not a 128-symbol URL.** Whether a journal entry can give a scannable QR is **not verified**. A sale confirmed this way may still have no QR to print.
- It is **two device calls** (the command, then `RawRead` for `Length` bytes), a new command in `tremol-contract.json`, and **only available on a server running `2509041522`**. On older definitions the only safe outcome is the existing "unverifiable → needs_fixing".
- The one invoice on the device in 22-29 Sep has trader number `101`, "Test001", not our format. **No invoice from this app was on the device by 29 Sep**, and the device's last invoice number has not moved since (section 7).

## 5. The four guards, against the code

| Guard | Verdict | Evidence |
| --- | --- | --- |
| **A.** fiscalized only on a `CloseReceipt` success carrying invoice number **and** QR, or a verified journal match | **Missing, and as worded it conflicts with D.** The normal path requires a number only ([:1273](../src/main/services/integrations/real-etims-provider.ts#L1273) accepts an empty QR); recovery requires no proof ([:1558-1561](../src/main/services/integrations/real-etims-provider.ts#L1558-L1561)). **Wording problem:** a journal-verified sale has no `CloseReceipt` QR, and the journal's own `QRCode` field may not be a QR (section 4), so under A-then-D such a sale would be fiscalized yet print as a sale record. | |
| **B.** an all-zero or malformed CU number is never accepted | **Missing.** The only test is truthiness ([xml-utils.ts:192-197](../src/main/services/integrations/xml-utils.ts#L192-L197), [:1558](../src/main/services/integrations/real-etims-provider.ts#L1558)). `0110605040000000000` is 19 digits and non-empty. The two real numbers on file have the shape ten digits + nine (`0110605040` + `001000809`), so "counter part all zeros" is a testable rule; that structure is inferred from two samples, not documented (`MaxLen=19`, `Text` is all the definitions say). | |
| **C.** a duplicate rejection with no verified match becomes `needs_fixing` with the phase 111 message; never fiscalized; never a second `OpenInvoice` | **Partly true, and partly wrong in the way that matters.** *True* on old or unrecognised definitions: `UNVERIFIABLE_RETRY_REASON` ([:270-273](../src/main/services/integrations/real-etims-provider.ts#L270-L273), returned at [:1142](../src/main/services/integrations/real-etims-provider.ts#L1142)), `kind: 'system'`, `retryable: false`. *Wrong* on the live definitions (`'available'`): any non-empty number wins and the sale is fiscalized. *Also not true:* "never a second `OpenInvoice`": every queued retry re-runs the whole sequence, `OpenInvoice` included ([fiscal-engine.ts:136-192](../src/main/services/fiscal-engine.ts#L136-L192)); the log shows two `OpenInvoice` calls 231 ms apart. Narrowing the trigger to "a duplicate" is not possible from the rejection code, since none has been captured. | |
| **D.** the fiscal slip renders as a fiscal receipt only when a QR is present | **Missing.** Every gate in section 3 decides on the number or the status. It would touch the layout, `receiptFiscalBlock`, `shouldMarkReceiptPrinted`, `kraNoteFor`, the late-filed print and the ETR copy. **Tests that currently pin QR-less behaviour and would need a stated change:** `printer.test.ts:242`, `fiscalSlipMarkers.test.ts:94`, `enjoySlip.test.ts:87`, `orderSlips.test.ts:116`, `receiptLayout.test.ts:86,203,248` (and `realEtimsProvider.test.ts:1123`, which pins the recovery's empty QR). **Tripwire warning:** `fiscalEngine.test.ts:450`, `fiscalRouting.test.ts:87`, `fiscalRetry.test.ts:59,132`, `fiscalIntegration.test.ts:328,371,396,472` and `fiscalResend.test.ts:384` all use success fixtures with `qrCode: ''`; **enforcing A or D in a consumer (engine, retry, routing, DB) would break those unmodified tests, so A belongs in the provider**, where it produces `ok: false`. | |

**Guards I would add to the list** (not asked; each follows from the code above):
- **E.** Refuse to store a CU number that another order already holds (no unique index exists; section 3).
- **F.** Narrow the recovery's trigger and replace its evidence: stop calling `ReadCUinvoiceNumber`; verify by the journal (section 4) or give up to `needs_fixing`.
- **G.** Refuse, rather than truncate, a trader number longer than 15 (section 1).

## 6. Uniqueness going forward (proposal only; compliance-sensitive)

**Shape.** `INV-` + a **two-letter till code** (A-Z only) + the local id as **seven digits**, e.g. `INV-AB0000001`: 13 characters, the same length as today's, inside `MaxLen=15` with two spare. Letters only guarantees a new number can never equal an old `INV-` + nine digits, so nothing already filed can collide with a new one. 676 codes cover a 100-outlet chain. Seven digits allow 9,999,999 local ids per till; the builder must **throw** past that, never truncate. `[A-Za-z0-9-]` is inside what the sanitiser keeps and what the VIL manual allows (it warns against symbols).

**Where the identifier comes from.** A new `settings` row (the table already stores `location_id` and `location_name`; `getSetting`/`setSetting`, [database.ts:2643](../src/main/services/database.ts#L2643), [:2656](../src/main/services/database.ts#L2656)), set once per install by an admin behind the manager PIN, format-checked, with a list of assigned codes kept centrally. **Not** derived from the Shopify location (several tills can share one) nor from the PC name (changes on reinstall). **If unset, the till must refuse to file**, not fall back to `INV-n`; whether that means "sale stays waiting" or "blocked at checkout" is a decision.

**Orders already filed as `INV-n`:** nothing happens to them. Their references are never edited. Two rules make that safe:
1. **A sale's number is fixed once, at creation, and stored.** Today the provider rebuilds it from `local_id` at every send ([:1810](../src/main/services/integrations/real-etims-provider.ts#L1810)), so a format change would make a retry of an old unfiled sale send a *different* number from the one it may already have partly reached the device under, and the device's duplicate check would miss the genuine retry. The number must be put in the stored request and reused; an order with no stored number (created before 2.1.6) keeps the legacy `INV-n` builder.
2. **Reports and exports must read the stored number first** and recompute only when it is NULL. Today four call sites recompute from `local_id` (section 1, row 2) and would silently show the wrong number for every new order.

**Does the device's duplicate check still catch a genuine retry from the same till?** Yes: same till code and same `local_id` give the same string, so a genuine retry is rejected as a duplicate exactly as now. **One new hazard:** `AUTOINCREMENT` restarts at 1 in a fresh database, so a reinstalled or reset till reuses `INV-AB0000001` and collides with *its own* earlier sale (this PC's two databases, `Electron` and `rubis-pos-desktop`, both start at 1). A till code alone does not cure that; options are an install-time sequence floor stored beside the till code, or keeping the database across reinstalls (an update keeps it; an uninstall wipes it, [build/installer.nsh](../build/installer.nsh), [release-2.1.6.md](release-2.1.6.md) §3).

**What I could not establish:** Flient's own trader-number format, length and character set. If Flient also uses an `INV-…` prefix with digits, letters-only codes still separate us, but only Flient can confirm they do not use letters in that position.

## 7. Session contention

- **Does the other till run its own ZFP Lab Server against the same CU?** **Not recorded anywhere in the project** (no technical mention of Flient exists; the only occurrence is a column heading, phase 157). It is the natural arrangement, since the server is a per-PC driver ("Only a single instance of the server can run in the system on the same port", `Manual.pdf` §3.2) and each till PC needs one, but **Not verified**.
- **The 0x60 byte, and what the evidence says now.** `0x60` is the CU's reply to the connection probe meaning "CU is already busy with another connection (LAN or WiFi connection only)" (protocol §1.3); it was captured once, at the pilot, as Code 19 at `154.79.253.237:8000` ([phase 104](phase-104.md); note that is not today's `…245`). **The server log we hold has none:** all 347 probe replies in it are `0x40` (ready). So the log shows no contention from another client. Read with the next point, it does not show another till filing either.
- **The device itself shows no other filing since 22 September.** Its last CU invoice number is `0110605040001000809` on 29 Sep ([phase 188](phase-188.md)) and again at 00:38 on 3 Oct; `LastInvoiceDate = 220926`. If a Flient installation has been filing to this unit, it was not doing so over this period. (The receipt counter did move, 4945 to 4946, unexplained.)
- **Operational decision, not code:** how many tills may hold a TCP session to one CU, and whether the other till's server and ours are ever used at once. The CU accepts one connection at a time (0x60), and we hold ours open (`keepPortOpen=1`, [phase 206](phase-206.md) §1d). **If** another till is on the same CU, then its server and ours would be competing for that single connection; that is the origin of 0x60 if it recurs.

## 8. Daily closure on a shared device

- **What the project assumes:** that **this app never sends `DailyReport`** and that someone else closes the day. `DailyReport` is "not wired into this app at all" ([KNOWN_GAPS.md](KNOWN_GAPS.md) "Fiscal device daily closure"; [phase 162](phase-162.md) §"daily closure itself … remains entirely unwired"); the app only recognises the refusal (STE1 `0x3B`, "24 hours block, missing Z report") and tells the cashier "Call support" ([real-etims-provider.ts:246-248](../src/main/services/integrations/real-etims-provider.ts#L246-L248)); the code's comment says "only VIL or an authorized operator can run that closure" (same file, :236-245). The sale is saved and retried until the closure is done.
- **Does two tills break it?** The assumption survives in the sense that neither till closes the day. What changes is that the closure is **device-wide**: one closure ends the business day for both tills' sales, and the 24-hour block blocks both. The files do not say what the CU does with a closure while another client holds an open receipt, who is meant to send it for a shared unit, or when. The device's last EOD was 21 Sep as of 29 Sep with filing still working ([phase 188](phase-188.md) §"LastEODDate age"), so the 24-hour block was not enforced on that date; **why is not verified**.
- **Decision for you,** not code: who owns the daily closure for the shared CU, at what time, and how both tills learn it has happened.

## 9. Verification

- Files read: the provider, `xml-utils.ts`, `fiscal-sanitize.ts`, `database.ts`, `checkout.ts`, `fiscal-engine.ts`, `fiscal-retry.ts`, `late-filed-slip.ts`, `printer.ts`, `receiptLayout.ts`, `receiptFiscalBlock.ts`, `reports.ts`, `reportsExport.ts`, `index.ts`; phases 104, 106, 111, 162, 168, 183, 184, 188, 196, 206; `KNOWN_GAPS.md`; `SDK_RECON.md` §5.5, §9.4, §10; the protocol PDF text (`pdftotext`) §1.3, §2.4.4, §2.4.13, §2.7.16-17.
- **Definitions:** the SDK's `fp.js` blob parsed with `ElementTree` and compared structurally with `tests/fixtures/tremol-defs.xml` (0 structural differences for the seven commands quoted; 100 of 122 commands differ only in whitespace and quote escaping) and with `tremol-old-defs.xml` (the three recovery-related commands are absent there).
- **Device evidence:** the fiscal server's log as fetched in phase 206 (not re-fetched), parsed for the journal reply, probe bytes and `settings()` history. The reply contains no password; it contains one test invoice's line item, quoted above.
- **Not run, as instructed:** `OpenInvoice`, `SellPLU`, `CloseReceipt`, `ReadEJByTraderSystemInvNum`, `DailyReport`, or any other device command. Nothing in this phase touched the device or the server.
- **Not verified:** the by-trader-number reply layout; whether a journal entry can give a scannable QR; how the CU chooses what `ReadCUinvoiceNumber` returns; whether Flient runs its own server; whether the CU keeps two clients' open receipts apart (VIL question 6); the CU-number structure beyond two samples; why the receipt counter moved.

## 10. Decisions needed

1. **Guard A versus guard D.** A journal-verified sale has no `CloseReceipt` QR, and the journal's `QRCode` field in the one sample was the invoice number, not a URL. How should such a sale print: as a sale record with a Needs Attention flag, as a fiscal receipt with no QR (today), or not until a QR can be built (the QR URL pattern is not in the files)?
2. **Recovery evidence.** Replace `ReadCUinvoiceNumber` with the journal lookup (two device calls, defVer `2509041522` only), and on older definitions keep `needs_fixing`? Or drop recovery entirely and send every unconfirmed duplicate to a person?
3. **A live capture first.** `ReadEJByTraderSystemInvNum_JSON` has never been observed. May a one-off read of a known trader number (`101`, the 22 Sep test invoice) be captured to a fixture before anything relies on it? It is read-only but is a device command, so I will not send it unasked.
4. **Where guard A lives.** In the provider, so the tripwire tests stay unmodified (section 5). Confirm, and confirm the list of QR-pinning tests in D that you accept changing, each with an old/new note.
5. **Guard E and G** (no duplicate CU number across orders; refuse instead of truncating): add to the narrow phase or later?
6. **Till code.** Confirm the shape (`INV-` + two letters + seven digits), who assigns codes, how many tills, and whether an unset code blocks filing (and how). **Needs Flient first:** their trader-number format, length and character set, and whether they run their own ZFP Lab Server.
7. **Self-collision after a reinstall.** Install-time sequence floor, or rely on the database surviving updates (an uninstall still wipes it)?
8. **Number fixed at creation** and reused on every retry, with reports reading the stored value first (section 6). Confirm the design before the uniqueness phase.
9. **Operational:** one TCP session per CU. Is the other till's server ever on while ours is, and who arbitrates?
10. **Operational:** who owns `DailyReport` on the shared CU, when, and how the tills learn it has run.

**Order of work as you set it:** the guards in section 5 as one narrow phase; the uniqueness scheme after Flient confirms the identifier; phase 184's classification (the `0x32` "retryable" decision, which is what sent order 1 into the recovery); then the single-instance lock. One note on that order: with guard C narrowed and the recovery's evidence replaced, the `0x32` case stops being able to produce a false "filed", so the classification phase becomes a wording and routing question rather than a safety one.

## 11. Rollback

Nothing to roll back: no code, config, fixture or test changed, and nothing was sent to the device or the server in this phase.
