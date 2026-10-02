# Phase 196 — "Print ETR copy" from the fiscal device: audit

- **Date:** 2026-10-02
- **Requested:** Add a way to print the ETR receipt from the ZFP server, meaning the Tremol device's own printout, not the till's thermal receipt.
- **Outcome:** **Blocked, awaiting a decision.** Nothing in `src/` or `tests/` was changed. This report is the only file added.
- **Branch / base commit:** staging @ d46c26d (version 2.1.4), tree clean at the start. Not committed.

## 1. Audit

- **Candidate commands** (contract: [tremol-contract.json](../tests/fixtures/tremol-contract.json)):
  - `InfoLastReceiptDuplicate`, 0x3A. No arguments, empty response. The definition's own wording is "Informs about the issued document". It exists in both the old (`2204120945`) and new (`2509041522`) definitions. It can only act on the **last** receipt the device issued.
  - `ReadOrStoreInvoiceCopy`, 0x7C. Arguments `OptionInvoiceCopy` (`J0` Reading, `J4` Store to **external SD card**), a hardcoded `I`, and `CUInvoiceNum` (max 10 characters). Empty response. The invoice number the app stores is 19 digits, which does not fit a 10-character field.
- **Neither is called anywhere in `src/`.** [phase-188.md](phase-188.md) §4 lists both under "Held for VIL question 3", and [phase-189.md](phase-189.md) says the same.
- **Prior device behaviour:** [phase-192.md](phase-192.md) sent `ReadEJByDate`. It returned `Code 0` and `OK` with **no content**, so a device command can succeed and produce nothing readable over the plain HTTP API.
- **The claim that these commands "print" is an inference, not a fact.** [phase-110.md](phase-110.md) §3b says `InfoLastReceiptDuplicate` "Prints; returns nothing", but no phase records it being sent to a real device. The definition does not mention a printer. `J4` stores to an SD card, which suggests the Control Unit is a printer-less unit.
- **Where the CU is:** per the pilot topology (ICT answer, 24 Sep 2026), the CU is at **head office**, shared by all shops later. ZFPLabServer runs on the shop till. Any paper from a device-side print would come out at head office, not at the shop counter.
- **How the provider sends commands** ([real-etims-provider.ts](../src/main/services/integrations/real-etims-provider.ts)): public methods run under `exclusive()` and call `sendCommand(path, name, args)`. Endpoints are listed in `FiscalEndpointPaths` and default to `''`. The `FiscalizationProvider` interface ([etims.ts](../src/main/services/integrations/etims.ts)) has three methods, and the mock implements them too. [tremolConformance.test.ts](../tests/tremolConformance.test.ts) checks that every posted command and argument exists in the contract.
- **Where a button would go:** `fiscal:*` IPC handlers in [index.ts](../src/main/index.ts) near line 2579, the bridge in [preload/index.ts](../src/preload/index.ts) near line 247, and Order History in [OrderHistory.tsx](../src/renderer/src/components/OrderHistory.tsx).
- **The till already prints the fiscal data.** [printer.ts](../src/main/services/printer.ts) prints the CU invoice number and QR on the thermal receipt (phase 164), and the Order History button reprints it.

## 2. Changes

None.

## 3. Why the build is held

1. **It may not produce paper.** If the CU has no printer, the command would succeed and print nothing, which looks like a working feature that does not work.
2. **If the CU does print, it prints at head office**, at a CU shared by other shops later. A shop cashier pressing a button would print at the wrong place.
3. **`InfoLastReceiptDuplicate` only reprints the last receipt.** An Order History button for an older sale would reprint a different sale.
4. **It sends a command that was deliberately held** to a device that files real, permanent KRA invoices. The standing rule for this POC is to change the minimum and leave working paths alone ([phase-188.md](phase-188.md), [phase-189.md](phase-189.md)).
5. `ReadOrStoreInvoiceCopy` needs a CU invoice number of at most 10 characters, and the app holds 19. Its `J4` option writes to the SD card.

## 4. Options for a decision

- **A. Ask VIL first (recommended).** Does this CU have a printer? What do `InfoLastReceiptDuplicate` and `ReadOrStoreInvoiceCopy` (`J0`) do over ZFPLabServer? Is a copy a legal ETR receipt? Build only once answered.
- **B. One approved test.** You approve a single `InfoLastReceiptDuplicate` against the live CU while someone watches head office, as in phase 192. Then we know whether anything prints.
- **C. Improve the till's own receipt instead.** Print the missing KRA elements from the stored fiscal data: CU serial number, ORIGINAL/COPY label, per-VAT-class breakdown and a real QR ([POC_AS_BUILT_ASSESSMENT.md](POC_AS_BUILT_ASSESSMENT.md) lists these gaps). This works at the shop with no new device command.

## 5. Verification

Read-only audit. No tests were run, and no command was sent to the device.

## 6. Rollback

Delete `docs/phase-196.md`.

## 7. Observed but not changed

- [POC_AS_BUILT_ASSESSMENT.md](POC_AS_BUILT_ASSESSMENT.md) is dated before phases 164 to 195 and no longer matches the code in places: it says the CU serial number is not stored, but `database.ts` now has a `fiscal_cu_serial` column, and it says the printed label is `Fiscal Inv:`, but phase 164 changed it to `CU Invoice No:`. Treat that document as stale on the receipt. My earlier reply to you quoted it, so those points were out of date.
- `.env.secrets.local` line 5 holds what looks like a live Shopify Admin API token (`shpat_…`) in plain text. The file is git-ignored (`.gitignore:11`, `.env*`) and untracked, so it is not in the repo. Rotate the token if the file was ever shared or backed up.
