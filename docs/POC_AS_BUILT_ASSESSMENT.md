# POC as-built assessment — what the till does today, and what is worth changing

**Date:** 2026-09-23 · **Branch:** `staging` @ `8871592` (clean) · **Scope:** read-only, nothing changed

**The scenario:** a real Tremol device behind the ZFPLabServer. Every sale files
with KRA for real. M-Pesa is taken by manual code entry
(`manualEntryEnabled` on), and each sale is 1 KSh.

Every claim below cites code. Anything that can only be proven on the
partner's hardware is marked **VERIFY-ON-DEVICE**. Paths are relative to
`src/` unless they start with `docs/` or `tests/`.

---

## Read this first: three things the brief did not anticipate

1. **Every class-A line is sent to the device with `VATGrRate="0.00"`.**
   - The rate comes from `Number(process.env.VITE_TAX_RATE) || 0`
     ([main/index.ts:513](../src/main/index.ts#L513)). `.env` has no
     `VITE_TAX_RATE` line, and `.env.example:39` sets it to `0`.
   - That rate becomes `VATGrRate: (item.taxRate * 100).toFixed(2)`
     ([real-etims-provider.ts:1503](../src/main/services/integrations/real-etims-provider.ts#L1503)).
   - What the device does with `"0.00"` is **VERIFY-ON-DEVICE**. It may reject
     the line, which is harmless because nothing is filed. It may apply its own
     programmed 16%. Or it may **file the sale at 0% VAT**. The third outcome
     is a wrong filing that is permanent, and there is no credit note to
     correct it.
   - **Changing only the config is not a clean fix.** Setting the rate to
     `0.16` corrects what is filed, but the printed receipt adds tax *on top*
     (`tax = subtotal * taxRate; total = subtotal + tax`,
     [printer.ts:214-215](../src/main/services/printer.ts#L214-L215)). A
     1-KSh sale would then print `Total: 1.16` when 1.00 was charged and filed.

   This is the only item in this document that can make the **first live sale
   file wrongly**.

2. **A stopped ZFPLabServer does not produce `waiting`. It produces
   `needs_fixing`, and nothing retries it automatically.**
   - A connection refusal or a 5-second timeout returns
     `{ success: false, error }` with no `retryable` flag
     ([http-client.ts:419-427](../src/main/services/integrations/http-client.ts#L419-L427)).
   - `checkDeviceResponse` passes that through unchanged
     ([real-etims-provider.ts:465](../src/main/services/integrations/real-etims-provider.ts#L465)),
     and `classifyDeviceFailure` then returns `kind: 'data'` or `'system'`
     ([:559-573](../src/main/services/integrations/real-etims-provider.ts#L559-L573),
     called at [:840](../src/main/services/integrations/real-etims-provider.ts#L840)
     and [:868](../src/main/services/integrations/real-etims-provider.ts#L868)).
   - Because the failure is not retryable, the sale is never put in the retry
     queue ([checkout.ts:540-559](../src/main/services/checkout.ts#L540-L559)).
   - Only **Code 30** (server up, device unreachable) and codes 19, 31 and 53
     are retried automatically ([real-etims-provider.ts:334-357](../src/main/services/integrations/real-etims-provider.ts#L334-L357)).
   - The sale is not lost. It shows in the unfiled count and in Needs
     Attention, and Resend files it. But the test plan's *"lands waiting, resend
     works"* has to become *"lands needs_fixing, and a manual Resend works"*.

3. **Receipts do not print by themselves.** Nothing in `runCheckout` prints.
   The only trigger is the **Print Receipt** button in Order History
   ([OrderHistory.tsx:209-217](../src/renderer/src/components/OrderHistory.tsx#L209-L217),
   wired at [App.tsx:251-253](../src/renderer/src/App.tsx#L251-L253)). The
   cashier has to go and press it after every sale.

---

## Part 1 — The real scenario, walked as-built

### 1. A plain 1-KSh cash sale, with the device working

**What happens:**

1. `runCheckout` writes the order (`queueOrder`,
   [checkout.ts:498](../src/main/services/checkout.ts#L498)).
2. It starts a Shopify sync if the till is online, without waiting for it
   ([:501-511](../src/main/services/checkout.ts#L501-L511)).
3. It stores the fiscal request, then waits for `submitInvoice`
   ([:529-534](../src/main/services/checkout.ts#L529-L534)).

**The device sequence** ([real-etims-provider.ts:836-1008](../src/main/services/integrations/real-etims-provider.ts#L836-L1008)):

1. `settings()` (cached for the session)
2. `ReadCUnumbers` (best-effort)
3. `ReadStatus`, which requires `CU_fiscalized` and `Paired_with_TIMS`
4. `OpenInvoiceWithFreeCustomerData`
5. `SellPLUfromExtDB` for each class-A line
6. `ReadCurrentReceiptInfo`
7. `CloseReceipt`, which returns `InvoiceNum` and `QRcode`
8. `ReadDateTime` (best-effort)

**Invoice numbering.** `TraderSystemInvNum` is `INV-` followed by the local id
padded to 9 digits ([:1415-1421](../src/main/services/integrations/real-etims-provider.ts#L1415-L1421)).
It stays the same across retries.

**What is recorded.** `setOrderFiscalInfo` sets the invoice number, the QR and
`fiscal_status='fiscalized'` ([database.ts:1316-1325](../src/main/services/database.ts#L1316-L1325)).
- `fiscal_fiscalized_at` is the **till's** clock
  ([database.ts:1324](../src/main/services/database.ts#L1324)). The time from
  the device's `ReadDateTime` is discarded.
- The CU serial number is read ([:857](../src/main/services/integrations/real-etims-provider.ts#L857))
  but **never stored**.

**What the cashier sees:**
- The toast says *"Sale complete - tax receipt issued."*
  ([saleCompleteToast.ts:26](../src/renderer/src/lib/saleCompleteToast.ts#L26)).
- The unfiled count stays 0. It counts only `waiting` and `needs_fixing`
  ([database.ts:1571](../src/main/services/database.ts#L1571)).
- Order History parses the ISO date correctly
  ([fiscalDate.ts:35-61](../src/renderer/src/lib/fiscalDate.ts#L35-L61)).

**What prints, once someone presses Print Receipt**
([printer.ts:217-268](../src/main/services/printer.ts#L217-L268)):

- Store name, then `PIN: <store KRA PIN>` if one is set in Admin.
- `Order #n`, the local date and time, and `Cashier:`.
- `Customer PIN:` for a B2B sale.
- Each line item and its line total.
- `Subtotal`, `Tax` (= subtotal × taxRate, so **0.00** today), and `Total`.
- `Payment: cash`, then `Tendered` and `Change`.
- `Thank you!`
- The fiscal block: `Fiscal Inv: <number>`, then the QR.

**The QR almost certainly prints as text, not as a code.** The device returns
`QRcode` as text of at most 128 characters (`tests/fixtures/tremol-contract.json:1966-1969`).
The printer decodes that string as a base64 PNG
([printer.ts:290](../src/main/services/printer.ts#L290)). The decode fails,
and the fallback prints `[QR CODE: <invoice number>]`
([:296](../src/main/services/printer.ts#L296)). The exact payload is
**VERIFY-ON-DEVICE**. Capture it during the POC.

**Compared with the KRA/VIL sample invoice** (the audit is in `docs/phase-65.md`):

| Element | Printed today? |
| --- | --- |
| ORIGINAL / COPY / CREDIT / DEBIT label | **No.** Deferred as checklist item 11 in `docs/phase-65.md:123-125`. |
| CU serial number | **No.** Read but not stored ([database.ts:376-378](../src/main/services/database.ts#L376-L378) has no column for it). `docs/phase-65.md` Finding 3 requires it. |
| CU invoice number | Yes |
| Scannable QR | **Probably not** (see above) |
| Per-VAT-class breakdown (A to E) | **No.** A single flat `Tax:` line. `ReceiptLineItem` has no VAT class ([printer.ts:66-71](../src/main/services/printer.ts#L66-L71)). |
| Device date and time | **No.** The till's local time is printed instead. |
| Buyer PIN, seller PIN | Yes, when they are set |

The sample invoice's image was never compared line by line
(`docs/phase-65.md:14-16`).

### 2. A 1-KSh manual M-Pesa sale

**Before the first sale:**
- An admin ticks *"Allow recording unverified M-Pesa payments"*
  ([AdminScreen.tsx:1229-1246](../src/renderer/src/components/AdminScreen.tsx#L1229-L1246)).
  Saving asks for a PIN, and the save is also checked in the main process
  ([index.ts:1418](../src/main/index.ts#L1418)).
- The same Save button **also requires a valid fiscal device IP and port**
  ([AdminScreen.tsx:456-463](../src/renderer/src/components/AdminScreen.tsx#L456-L463)).
- **The app must be restarted by hand afterwards.** The flag is read once at
  boot ([index.ts:639](../src/main/index.ts#L639)), and the screen only says
  *"Settings saved."*

**What the cashier does**
([PaymentModal.tsx](../src/renderer/src/components/PaymentModal.tsx)):

1. Tap **M-PESA**. The M-Pesa button is never hidden
   ([PosCheckoutPanel.tsx:292-302](../src/renderer/src/components/PosCheckoutPanel.tsx#L292-L302)).
2. The payment screen opens on **STK Push**. Switch to the amber
   **Unverified** tab ([:415-455](../src/renderer/src/components/PaymentModal.tsx#L415-L455)).
3. Type the code. The field forces uppercase, allows only A-Z and 0-9, and
   stops at 10 characters ([:558-567](../src/renderer/src/components/PaymentModal.tsx#L558-L567)).
4. Tick *"I confirm this payment has not been verified…"*
   ([:569-578](../src/renderer/src/components/PaymentModal.tsx#L569-L578)).
5. Press **Continue — needs a manager's PIN** ([:591](../src/renderer/src/components/PaymentModal.tsx#L591)).
6. A **Manager PIN Required** prompt opens. It offers a dropdown of **admin**
   staff, which defaults to the first admin
   ([ManagerPinModal.tsx:37-39, 94-104](../src/renderer/src/components/ManagerPinModal.tsx#L37-L39)).
   Enter the PIN and press **Authorize**. A wrong PIN shows *"Incorrect PIN"*
   and the prompt stays open.
7. The sale is submitted straight away. There is no separate *Complete* tap.

**Tab clutter if Daraja isn't configured.** On a till with no Daraja
credentials, a **Manual Code** tab also appears ([:426](../src/renderer/src/components/PaymentModal.tsx#L426)).
It rejects every code with *"M-Pesa has not been set up…"*, and so does STK
Push ([mpesa-provider-factory.ts:225-237](../src/main/services/mpesa-provider-factory.ts#L225-L237)).
Only Unverified works.

**Server side:**
- `requireAdminPin` ([index.ts:982](../src/main/index.ts#L982)) accepts any
  `admin` role ([requireAdminPin.ts:43-57](../src/main/lib/requireAdminPin.ts#L43-L57)).
  Nothing requires the approver to be someone other than the cashier, and
  there is no lockout after wrong PINs.
- The gate then checks, in order: manual entry enabled, code format,
  acknowledgement, and whether the code was already used in any mode
  ([checkout.ts:392-408](../src/main/services/checkout.ts#L392-L408)).

**What is recorded.** The order and an `mpesa_payments` row are written in one
transaction ([checkout.ts:483-488](../src/main/services/checkout.ts#L483-L488)).
The payment row has `mode='manual'`, `verification_status='manual_unverified'`,
and the entered-by and approved-by ids.

**Fiscalized exactly like cash.** The payment method is never sent to the
device ([real-etims-provider.ts:1393-1406](../src/main/services/integrations/real-etims-provider.ts#L1393-L1406);
`CloseReceipt` is sent with `{}`), so cash and M-Pesa produce identical device
traffic. The printed receipt shows `Payment: mpesa` and `Ref: <code>`.

**Reconciliation.** The Reconciliation tab lists the sale. The *Cashier /
approver* column shows **raw staff ids**
([MpesaReconciliationPage.tsx:131-133](../src/renderer/src/pages/MpesaReconciliationPage.tsx#L131-L133)).
**Mark checked** asks for a PIN ([index.ts:1061](../src/main/index.ts#L1061)),
and the status stays `manual_unverified` permanently.

**Is the PIN an obstacle? No, not for this POC.** If the partner is logged in
as the only admin, the dropdown is already set to them. They re-type their own
PIN, and self-approval is allowed. That adds about three taps per sale.

**The real friction is elsewhere:**
- The manual restart after saving the setting.
- Each test sale needs a **new, never-used** 10-character code, because
  duplicates are refused ([checkout.ts:406](../src/main/services/checkout.ts#L406)).

### 3. A wrong 1-KSh sale filed to KRA

**The app can do nothing about it.**
- `cancelInvoice` has no callers anywhere, so no IPC handler and no screen can
  reach it.
- When called without details, it refuses and tells you to issue a credit
  note manually
  ([real-etims-provider.ts:1061-1088](../src/main/services/integrations/real-etims-provider.ts#L1061-L1088)).
- When called with details, it opens a credit note and never closes it. It
  would leave a receipt open on the device.
- The app has no refund feature.

**Void does not help, and can make things worse.** Void is allowed only while
the order is `pending_sync` for Shopify ([voids.ts:37-66](../src/main/services/voids.ts#L37-L66)).
It sets `status='voided'` and deletes the Shopify and fiscal queue rows
([database.ts:1652-1664](../src/main/services/database.ts#L1652-L1664)). It
**never touches `fiscal_status`**, so a voided sale that was already filed
stays filed with KRA.

Worse, `resendFiscalization` never checks `status`
([fiscal-retry.ts:133-165](../src/main/services/fiscal-retry.ts#L133-L165)).
So a **voided sale that is `waiting` or `needs_fixing` can still be filed** by
pressing Resend. The main process also has no role or PIN check on void
([index.ts:2082-2103](../src/main/index.ts#L2082-L2103)).

**What the operator has to do:** issue a credit note against the invoice
number, outside the app. That means on the device, through its vendor tools,
or on the KRA iTax/TIMS portal. Which of these the partner's setup supports is
**VERIFY-ON-DEVICE**. Keep a list of every invoice number that is filed.

### 4. The device or the ZFPLabServer goes away mid-POC

**The sale always completes (Rule 4).** Every fiscal failure is caught, and
the final `return` is unconditional
([checkout.ts:561-605](../src/main/services/checkout.ts#L561-L605)). What the
cashier sees next depends on which part failed:

| What failed | Fiscal status | Retried automatically? |
| --- | --- | --- |
| The **device** is off or unplugged, with the ZFPLabServer still up (Code 30) | `waiting` | **Yes.** Every 30 s, backing off to 30 min, for up to 10 attempts. After that the queue row is kept but marked abandoned, and the sale stays counted as unfiled ([database.ts:1251-1267](../src/main/services/database.ts#L1251-L1267)). |
| The **ZFPLabServer** is stopped, or any request takes longer than 5 s | `needs_fixing` | **No.** See headline 2. Needs a manual Resend from Needs Attention or the toast. |
| An unexpected exception | `waiting` | Yes ([checkout.ts:561-585](../src/main/services/checkout.ts#L561-L585)) |

**Code 31 and the 5-second timeout.** Code 31 took about 4.3 s live
(`docs/phase-109.md:106`), which is close to the 5-second client timeout
([http-client.ts:48](../src/main/services/integrations/http-client.ts#L48)). A
slow response can therefore land in the `needs_fixing` row instead of
`waiting`.

**Can a resend file twice?**
- **Guard 1:** an order already marked `fiscalized` is never resubmitted
  ([fiscal-retry.ts:62-72, 143-153](../src/main/services/fiscal-retry.ts#L62-L72)).
- **Guard 2:** a retry sends the same `TraderSystemInvNum`, with `isRetry`.

**Guard 2 is not proven on the installed server.** The installed ZFPLabServer
runs the **old** command definitions, `defVer 2204120945`
(`docs/phase-115.md:4-5`). Those definitions have no `ReadCUinvoiceNumber`,
so the recovery step cannot look up an invoice that was already filed. Any
device rejection on a retry is then flagged `needs_fixing` as *unverifiable*,
not recovered
([real-etims-provider.ts:1173-1180](../src/main/services/integrations/real-etims-provider.ts#L1173-L1180)).
That outcome is safe.

**What is not known:**
- Whether the device **rejects** a duplicate `TraderSystemInvNum` at all
  (**VERIFY-ON-DEVICE**). If it silently accepts one, resending after a lost
  `CloseReceipt` response **files twice**.
- Whether any of this has run against a real device. Nothing in `docs/`
  records a duplicate or recovery test on real hardware, only on the mock
  server (`docs/GO_LIVE_READINESS.md:162-184`).

**The device is never serialized.** Nothing makes checkout, the retry engine
and the Resend buttons take turns on the device, which holds one open receipt
at a time. The engine's `running` flag guards only the engine itself
([fiscal-engine.ts:114](../src/main/services/fiscal-engine.ts#L114)). If a
retry overlaps a live sale, one can hit *receipt already open* and cancel the
other's receipt
([real-etims-provider.ts:881-891](../src/main/services/integrations/real-etims-provider.ts#L881-L891)).
This is unlikely with one cashier and one sale at a time.

**A crash mid-sale is invisible.** An order is inserted with no fiscal status,
and it gets one only after the device sequence finishes. If the app dies in
between, the sale is in neither the unfiled count nor Needs Attention.

### 5. The thermal printer is unreachable during a real sale

**When the fallback triggers.** The app falls back to a PDF only when the
printer cannot be reached:
- the printer probe fails, or
- printing fails with `ECONNREFUSED`, `EHOSTUNREACH` or `ETIMEDOUT`
  ([printer.ts:388-392, 452-474](../src/main/services/printer.ts#L388-L392)).

The PDF is saved to the Desktop and opened
([index.ts:2267-2274](../src/main/index.ts#L2267-L2274)). A paper-out or other
error shows a failure message instead.

**Confirmed: the PDF prints no fiscal block.** It has no invoice number and no
QR, and it also omits the store KRA PIN
([pdf-receipt.ts:50-78](../src/main/services/pdf-receipt.ts#L50-L78)). The
data is available: the order passed in carries `fiscalInvoiceNumber` and
`fiscalQrCode` ([index.ts:2331-2332](../src/main/index.ts#L2331-L2332)). The
PDF simply does not print them.

So **yes**: a real, filed sale can produce a receipt with its tax details
missing.

**Severity is low.**
- It **under-states**. It never presents an unfiled sale as filed, so Rule 2
  is not broken.
- Printing is a manual button, so it can be **reprinted from Order History**
  once the printer is back.

**Likelihood is moderate on a fresh setup.** The printer address comes from
`.env`, and the current file says `tcp://192.168.1.50:9100` (`.env:10`). If the
partner's printer is on any other IP, *every* print falls back to the PDF.

**If `VITE_MOCK_PRINTER=true`**, nothing prints at all, yet the result reports
success (*"Receipt printed (mock mode)"*, [printer.ts:446-469](../src/main/services/printer.ts#L446-L469)).
The current `.env` has it set to `false`.

### 6. A B2B customer with a KRA PIN

**What is sent.** `customerPin` becomes `ClientPINnum`, and `companyName`
becomes `CompanyName`, cut to 30 characters
([real-etims-provider.ts:1393-1406](../src/main/services/integrations/real-etims-provider.ts#L1393-L1406)).

**PIN format check.** The PIN must match `^[PA]\d{9}[A-Z]$` before anything is
sent. If it doesn't, the sale goes straight to `needs_fixing`
([fiscal-validate.ts:37, 95-98](../src/main/services/integrations/fiscal-validate.ts#L37)).

**Address fields.** `HeadQuarters`, `Address`, `PostalCodeAndCity` and
`ExemptionNum` are always sent blank. Whether KRA accepts that is
**VERIFY-ON-DEVICE** (`docs/KNOWN_GAPS.md:164-197`).

**A wrong but well-formed PIN.** The device answers Code 40 with STE2=59. The
sale is marked `dataIssue:'wrong-pin'` and `needs_fixing`, and it is not
queued ([real-etims-provider.ts:505-512, 571](../src/main/services/integrations/real-etims-provider.ts#L505-L512)).
The toast then offers Correct PIN, Remove PIN & Resend, and Send to Office.
**Correct PIN** rewrites only `buyerPin` in the stored request and resends
through the same guarded path
([fiscal-retry.ts:208-225](../src/main/services/fiscal-retry.ts#L208-L225)).

**This has only been shown with an injected response, not a real device.**
There is also a coupling risk:
- A correct-PIN resend is a retry, so if the device rejects `OpenInvoice`
  again, the duplicate-recovery path runs.
- On the old definitions that ends as *unverifiable* `needs_fixing`, which is
  safe.
- On the new definitions it would trust whatever `ReadCUinvoiceNumber` returns
  (`docs/KNOWN_GAPS.md:97-101`).

### 7. Going offline mid-sale, then reconnecting

**Fiscalization does not depend on the internet.** The ZFPLabServer is local
and the fiscal engine does not check connectivity
([fiscal-engine.ts:19-23](../src/main/services/fiscal-engine.ts#L19-L23)).
An offline cash sale files normally if the device is on the LAN.

**The Shopify side:**
- The order and its `sync_queue` row are written together
  ([database.ts:1090-1130](../src/main/services/database.ts#L1090-L1130)).
- The sync engine skips its passes while `net.isOnline()` is false. It pushes
  when the network monitor reports the connection is back (a 5-second poll),
  or every 30 s ([sync-engine.ts:79-100](../src/main/services/sync-engine.ts#L79-L100);
  [index.ts:770-785](../src/main/index.ts#L770-L785)).
- The push is an `orderCreate` with `PAID` and a decrement of stock
  ([orders.ts:65-100](../src/main/services/orders.ts#L65-L100)).

**"Syncs once" is not guaranteed.**
- `clientOrderUuid` is written onto the Shopify order, but nothing checks for
  it before pushing, and there is no idempotency key. A push that succeeds but
  loses its response (a 10-second timeout) is retried, and that creates a
  **second Shopify order**
  ([orders.ts:81-111](../src/main/services/orders.ts#L81-L111)).
- **Retry Sync** is also offered on `pending_sync` orders
  ([OrderHistory.tsx:219-220](../src/renderer/src/components/OrderHistory.tsx#L219-L220)).
  It adds a second queue row, which means two Shopify orders
  ([database.ts:1587-1618](../src/main/services/database.ts#L1587-L1618)).
- `net.isOnline()` only means a network link exists. On a LAN with no
  internet, every push fails and uses up one of 10 attempts. After those are
  used up, the order is `failed` and waits for a manual Retry
  ([database.ts:1475-1479](../src/main/services/database.ts#L1475-L1479)).
- The app has no single-instance lock. Two open copies of the app would push
  the same queue twice.

### 8. A fresh install on the partner's machine

**The first-launch sequence**
([App.tsx:325-365](../src/renderer/src/App.tsx#L325-L365)):

1. **Onboarding.** Skipped when `.env` carries the Shopify URL and token.
2. **Login.** A default `Admin` / `1234` account is seeded when the staff
   table is empty ([index.ts:383-388](../src/main/index.ts#L383-L388)).
3. **Location confirmation.** Needs **internet and Shopify**
   ([index.ts:1922-1935](../src/main/index.ts#L1922-L1935)), unless
   `VITE_SHOPIFY_LOCATION_ID` is set in `.env`, in which case it is confirmed
   automatically ([index.ts:468-472](../src/main/index.ts#L468-L472)). **An
   offline first launch cannot get past this step.**
4. **eTIMS setup gate.** Needs the base URL, device IP, port and a
   **non-empty** password ([etimsSetup.ts:46](../src/main/services/etimsSetup.ts#L46)).

**The catalog needs Shopify.** On a new database the product cache is empty,
so an offline first launch has nothing to sell
([index.ts:902-941](../src/main/index.ts#L902-L941)).

**The credential vault.** The vault is Electron `safeStorage` (DPAPI) plus
`%APPDATA%\rubis-pos-desktop\secret-vault.json`
([secretStore.ts:295-351](../src/main/services/secretStore.ts#L295-L351)). It
is not keytar, so there is no native module to fail. The vault is **per
Windows user**:
- The Shopify token and the Daraja secrets are copied in again from `.env`.
- The fiscal device password has no `.env` fallback, so it **must be re-typed**
  for every Windows user.

**The ZFPLabServer is neither bundled nor started.** Nothing in `main/`
starts another process. The app expects `http://localhost:4444/`
([http-client.ts:45](../src/main/services/integrations/http-client.ts#L45)),
so the partner must have it installed and set to auto-start.

**Auto-update:**
- It never runs on launch, only from **Admin → Check for Updates**
  ([index.ts:2578-2581](../src/main/index.ts#L2578-L2581)).
- `autoDownload = true` ([updater.ts:42](../src/main/services/updater.ts#L42)),
  and electron-updater installs on quit by default. **Don't press that button
  during the POC.**
- The build is unsigned, so expect a SmartScreen warning (**VERIFY-ON-DEVICE**).

**`.env` is read at runtime.** It loads from `resources/.env`
([index.ts:26-28](../src/main/index.ts#L26-L28)), and the main-process
`VITE_*` values are read then, not at build time. That means
`VITE_TAX_RATE`, `VITE_PRINTER_INTERFACE`, `VITE_MOCK_PRINTER` and
`VITE_SHOPIFY_LOCATION_ID` **can be corrected on the installed till** by
editing `resources/.env` and restarting.

**The `release/` build is stale.** It dates from 12 Sep, and 22 source files
are newer, including `checkout.ts`, `database.ts`, `real-etims-provider.ts`
and `index.ts`. **Rebuild before installing.**

**Uninstalling wipes the database and the vault**, unsynced orders included
(`build/installer.nsh:20-22`).

**Nothing found that makes the first launch crash.** Every table is created
with `IF NOT EXISTS`, and adding a column that already exists is tolerated
([database.ts:328-346, 953-981](../src/main/services/database.ts#L328-L346)).

---

## Part 2 — The proposed changes, judged against go-live risk

| # | Change | Risk if **not** done | Risk if done | Verdict |
| --- | --- | --- | --- | --- |
| A | **Live / dry-run switch** (`docs/phase-122.md` §4) | Every test sale files for real, which is the purpose of the POC. A dry-run sale **never reaches the device**, so it could not have caught any of the device-side risks in Part 1, including the VAT rate. What it rehearses (printing, M-Pesa, Order History) is harmless to rehearse live at 1 KSh. | A new branch on the sale path, a new column, and a new Admin control, all days before go-live. | **DO AFTER POC** |
| B | **Manager PIN on manual M-Pesa as a config flag** | About three extra taps and a PIN per manual sale. The partner, as the only admin, approves their own sales ([requireAdminPin.ts:43-57](../src/main/lib/requireAdminPin.ts#L43-L57); nothing prevents self-approval). | Touches the `orders:checkout` handler, which is on the payment path, and relaxes a guard rail. | **DON'T DO before the POC.** Revisit only if a non-admin cashier will run manual sales. |
| C | **Daily sales CSV export** | Nothing breaks. Order History, the Reconciliation tab and M-Pesa Logs show everything a 2-to-5-sale POC needs. Capture it with photos and screenshots. | Low, because it is additive and read-only. But it is still new IPC, a new file-write path and new UI. | **DO AFTER POC** |
| D | **PDF fallback missing the fiscal block** | Only if the printer can't be reached. It **under-states** (Rule 2 intact), and the receipt can be reprinted from Order History. Likely only if the printer IP in `.env` is wrong, which a pre-flight print catches. | Small and printer-only. | **DON'T DO before the POC.** A pre-flight test print is the substitute. **Fix before real trading.** |
| E | **Receipt layout** (ORIGINAL label, CU serial, per-VAT breakdown, scannable QR) | For a 1-KSh POC the invoice is on KRA's side regardless of what is printed, so this is not a POC failure. **For real trading it is a compliance gap**, the QR most of all. | Moderate: printer layout plus a new stored column for the CU serial. | **DO AFTER POC, before trading with customers.** Capture the raw `QRcode` payload during the POC so the fix is made against a real value. |
| F | **Fiscal credit note / refund** | A wrong filing can't be corrected in the app. It needs a manual credit note (Part 1 §3). | **Large.** A new device sequence (open, sell, close) that has never been run on hardware, plus new screens. | **DON'T DO before the POC.** Budget for one manual correction. |
| G | **Found here: VAT rate `0.00`** (headline 1) | The first live sale may **file at 0% VAT**, permanently, with no credit note. | Depends on the fix. See Part 3. | **RESOLVE BEFORE the first live sale.** This is the one pre-POC item. |
| H | **Found here: a stopped ZFPLabServer goes to `needs_fixing` instead of `waiting`** (headline 2) | The sale stays visible in the unfiled count and Needs Attention, and a manual Resend files it. Nothing is lost. | Changes how every fiscal failure is classified. It is inside the fiscal engine, which is the path that must not move. | **DON'T DO before the POC.** Change the test-plan expectation instead. |
| I | **Found here: void leaves the KRA invoice filed, and a voided sale can still be resent** | A POC void of a filed sale leaves KRA and the till disagreeing. Resend on a voided sale files a sale that no longer exists. | A one-line guard in `fiscal-retry.ts`, which is still fiscal-engine code. | **DON'T DO before the POC.** Take void out of the POC plan, and never press Resend on a voided sale. |
| J | **Found here: discounts are not sent to the device** ([checkout.ts:275-288](../src/main/services/checkout.ts#L275-L288)) | A discounted sale files the undiscounted price. | Fiscal request shape. | **DON'T DO before the POC.** No discounts in the POC. |
| K | **Found here: duplicate Shopify orders** (lost response, or Retry Sync on a pending order) | A duplicate 1-KSh order in Shopify, which is cosmetic and easy to delete. | Sync path. | **DO AFTER POC.** Don't press Retry Sync on pending orders. |

---

## Part 3 — The minimum viable POC

### The change set: zero code changes plus one config decision, or one small printer-only change

**1. Before the first live sale, decide the VAT rate. This is the only
blocker.** First confirm with the business that Shopify prices are
**VAT-inclusive**. Then choose one of these:

- **(a) Config only (recommended for the POC).**
  - Set `VITE_TAX_RATE=0.16` in the till's `resources/.env` and restart.
  - Class-A lines then send `VATGrRate="16.00"`, which is what every design
    doc assumed (`docs/phase-60.md:245`).
  - **Known side effect:** the paper receipt, and the Z-report and daily
    summary, compute tax *on top*, so the printed total is 1.16 on a 1.00
    sale ([printer.ts:214-215](../src/main/services/printer.ts#L214-L215),
    [reports.ts:136](../src/main/services/reports.ts#L136)).
  - That is acceptable only on internal test receipts, and must be fixed
    before customers see a receipt.
  - To revert, remove the line and restart.
- **(b) The same config, plus a small printer-only fix** so that receipts treat
  the price as tax-inclusive. It would change `printer.ts` and
  `pdf-receipt.ts`, and not touch the fiscal engine.
- **(c) Leave it at 0 and observe.** Not recommended. The only way to observe
  is to file a real invoice, and if the device files it at 0% VAT, it is a
  wrong filing that cannot be corrected.

### Operational precautions, in place of changes

**Build and install:**
- **Rebuild.** The `release/` exe is stale.
- **Check the installed `resources/.env`:**
  - `VITE_TAX_RATE=0.16`
  - `VITE_MOCK_PRINTER=false`
  - `VITE_PRINTER_INTERFACE` set to the partner's real printer IP
  - `VITE_SHOPIFY_LOCATION_ID` set, so the first launch does not need the
    location picker
  - `VITE_USE_MOCK_ETIMS=false`
- **Set the ZFPLabServer to auto-start.** The app neither bundles nor starts
  it.
- **Change the default `1234` admin PIN** on first login.
- **Run only one copy of the app.**
- **Do not press Check for Updates** during the POC.
- **Do not uninstall**, because it wipes the database.

**Before the first live sale:**
- **Do a pre-flight test print** of an old or cash order. Confirm it comes out
  on paper, not as a Desktop PDF.
- **Enable manual M-Pesa, then restart** the app.
- **Have one unique 10-character code** ready for each manual sale.

**During the sales:**
- **Keep live sales to the minimum**, all 1 KSh:
  - one cash sale,
  - one manual M-Pesa sale,
  - one B2B sale, only if blank address fields must be proven.
- **No discounts, and no voids.**
- **After every sale:**
  - Press Print Receipt in Order History.
  - Photograph the receipt.
  - Write down the invoice number.
  - Note the unfiled count.
  - Save the `[DEBUG-HTTP]` or `[ETIMS]` log lines if anything fails.
- **Capture the raw `QRcode` value** of the first live sale. It is in the
  database (`orders.fiscal_qr_code`), so no UI is needed. It feeds the fix for
  E.

**Testing an outage:**
- **Stopping the ZFPLabServer** should give `needs_fixing` and **a manual
  Resend**.
- **Unplugging the device with the server running** should give `waiting` and
  an automatic retry.

**If anything goes wrong:**
- **If a sale ends up `needs_fixing` after a timeout at or near
  `CloseReceipt`, check the device or the KRA portal for that `INV-…` number
  before pressing Resend.** Whether the device rejects a duplicate
  `TraderSystemInvNum` has never been proven. This is the one path where a
  resend could file twice.
- **Budget for one manual KRA credit note.** There is no in-app route.

**Stop rules, from the brief, kept as written.** STOP if a real sale:
- files without a real invoice number,
- prints a fiscal block while unfiled, or
- files twice.

**Add one more:** STOP if the filed invoice shows **0% VAT** on a class-A item.
