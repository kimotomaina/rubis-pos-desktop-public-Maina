# Phase 249 — One order per checkout (repeat-submit key)

- **Date:** 2026-10-06
- **Asked by the owner:** the go of 20:15 Nairobi, after the phase 248 audit found that only the screen stops a second submit. The same checkout submitted twice must give one order, one trader invoice number and one fiscal invoice, for every payment method.
- **Status:** built and tested in one commit. No version bump, no installer.
- **Also done (ruling D9):** the two `tsconfig.*.tsbuildinfo` files were TypeScript's incremental build output: each is a one-line JSON (`{"fileNames":[…`), and `git diff --stat` showed one line changed in each. Both were put back with `git restore` and are not in any commit.

---

## Audit (before building): where the three things are made today

| Thing | Where | Inside the order's write transaction? |
| --- | --- | --- |
| The write transaction | `queueOrder`, `const enqueue = this.conn.transaction(…)` at [database.ts:2397](../src/main/services/database.ts#L2397), run as `enqueue.immediate()` at [2449](../src/main/services/database.ts#L2449) (it takes the write lock at the start, phase 211) | — |
| The order id | `insertOrder.run(…)` at [database.ts:2407](../src/main/services/database.ts#L2407); `const localId = Number(orderInfo.lastInsertRowid)` at [2420](../src/main/services/database.ts#L2420) | yes |
| The trader invoice number | `this.allocateTraderInvNum(input.locationId)` at [database.ts:2421](../src/main/services/database.ts#L2421) | yes |
| The Shopify queue row | `insertQueue.run('order', localId, 'orderCreate', …)` at [database.ts:2427](../src/main/services/database.ts#L2427) | yes |
| The fiscal request and its queue row | `queued.fiscalQueueId = this.queueFiscalInvoice(localId, request).queueId` at [database.ts:2442](../src/main/services/database.ts#L2442) | yes |
| **The fiscal call** | `await fiscalizationProvider.submitInvoice(fiscalRequest)` at [checkout.ts:710](../src/main/services/checkout.ts#L710), after `fiscalEngine.claim(localId)` at [707](../src/main/services/checkout.ts#L707) | **no**: after the transaction has committed |
| The payment gates | [checkout.ts:508-590](../src/main/services/checkout.ts#L508-L590); the only `await` before the write is the SMS check, `await mpesaProvider.verifyTransactionCode(…)` at [542](../src/main/services/checkout.ts#L542) | no: before it |

**The look-up sits before all of them, twice:**

1. **At the start of `runCheckout`,** [checkout.ts:443](../src/main/services/checkout.ts#L443).
   - It comes before the VAT-class refusal (451), the payment gates (508), the order's UUID (`idGen`, 593), the write (653-665) and the fiscal call (710).
   - It must sit before the gates. Otherwise a repeat of a manual-code sale would be refused as "code already used" by the very sale it made, instead of being told about that sale.
2. **Inside the write transaction,** [database.ts:2401](../src/main/services/database.ts#L2401).
   - It is the first statement, before the order id, the trader number, the Shopify row and the fiscal row.
   - When the key is found, the transaction returns that order with `existing: true` and writes nothing.
   - The three M-Pesa wrappers (SMS claim, confirmed, manual) then skip their own writes too.
   - `runCheckout` returns at [checkout.ts:670](../src/main/services/checkout.ts#L670), before the fiscal call.

**The fiscal call is outside the transaction. Here is how a second submit is stopped while the first is still filing:**
- The first submit commits its order, with its key, before it calls the device.
- A second submit with the same key finds that order at the first look-up and returns its receipt, `fiscalStatus: 'waiting'`. It never reaches the fiscal block.
- If the two submits overlap (the SMS check is the only `await` before the write), both can pass the first look-up. The write transaction is serialised (`immediate`), so the second finds the first's order inside it and returns before the fiscal call.
- The fiscal engine's claim on the sale (707) keeps the background retry off the sale while the first submit files, as before.

**This needed nothing beyond the ordered design. Two additions, both inside its words:**
- **A repeat whose total differs is refused, not answered.** The screen keeps one key per cart. A key reused with a different total means the first submit did make a sale and the cart changed after. Answering with the earlier sale would hide that, so the repeat is refused, with a message naming the sale, and nothing is written.
- **"When the payment screen opens" is per cart.** The payment panel is always on screen, so it never "opens". The key is made at the cart's first submit and kept, through a failed submit and its retry, until the cart is cleared (sale done, held or discarded). It is also cleared when a held or saved cart is put back. A new sale gets a new key.

## What changed

| Where | What |
| --- | --- |
| [database.ts](../src/main/services/database.ts) | **New:** `orders.checkout_key TEXT`, nullable, in the `CREATE TABLE`; `migrateOrdersCheckoutKey` (check then add, [1028](../src/main/services/database.ts#L1028)); `idx_orders_checkout_key`, unique where the key is not null ([1241](../src/main/services/database.ts#L1241)). **`queueOrder`:** looks the key up first inside its transaction and stores it with the order. **The three M-Pesa wrappers:** write nothing for an existing order. **New:** `getOrderByCheckoutKey` ([3090](../src/main/services/database.ts#L3090)). **Types:** `QueuedOrder.existing`; `QueueOrderInput.checkoutKey`; `CheckoutRequest.checkoutKey`. |
| [checkout.ts](../src/main/services/checkout.ts) | **Before everything:** the look-up. **After the write:** `existing` returns. **New:** `receiptOfEarlierOrder` (the earlier order's receipt, read from its row as the first submit's is), `repeatOfCheckout` (that receipt, or the refusal when the totals differ to the cent) and `checkoutKeyReusedMessage`. **Slice:** `CheckoutDb.getOrderByCheckoutKey`. |
| [ipcValidator.ts](../src/main/lib/ipcValidator.ts) | `checkoutKey` **required** on `orders:checkout`, shaped like `crypto.randomUUID()`. A missing or malformed key fails with `CHECKOUT_KEY_MISSING_MESSAGE`: "This sale was sent without its checkout key, so nothing was recorded. Close and reopen the till, then complete the sale again." The handler validates first ([index.ts:1406](../src/main/index.ts#L1406)) and returns before the location, the discount check or `runCheckout` (1474). |
| [cartStore.ts](../src/renderer/src/stores/cartStore.ts) | `checkoutKey` state: made at the first submit and sent with every submit (321-328); cleared by `clearCart`, `restoreCart` and `resumeHeldSale`. |

**Not changed:** the fiscal code, the trader invoice format and its sequence, the payment gates' checks, shifts, reports, Shopify, receipts. `runCheckout` still works with no key for a direct caller with no screen (there is none in the app; only the IPC handler calls it). The IPC channel, the one way in from the screen, refuses a keyless submit.

## Tests

[checkoutKey.test.ts](../tests/checkoutKey.test.ts), 18 tests, real `:memory:` SQLite (a real file for the migration) and the real `runCheckout`.

**Two submits with one key:**
- **Each method:** cash, card, Daraja STK and a manual M-Pesa code each give one order, one trader number, one Shopify queue row, one `mpesa_payments` row (for M-Pesa) and one fiscal call. The second answer equals the first.
- **The answer:** the repeat gets the first order as it now stands, its CU invoice included.
- **A different total:** refused with the sale named, and nothing written.

**Two submits with different keys:** two orders, two fiscal calls.

**Filing in progress:**
- A submit while the first is filing gets the first order as `waiting`, and the device is called once.
- A submit that passed the first look-up before the order existed is answered inside the write.
- The SMS claim, a confirmed payment and a manual code each write nothing for a key that already made its order.

**No key:**
- A missing or malformed key is refused at the channel with the message.
- In the handler, that refusal comes before the location and `runCheckout`.

**The column and the index:**
- On a new database the index is unique among keyed orders and allows any number of `NULL`s.
- An old database (the column and index removed) is brought forward by `init` three times with no error. Its old rows are identical with `checkout_key` `NULL`, and the index is partial.

**The screen:**
- One key across a failed submit and its retry, a new key for the next cart.
- A cart put back from hold or from its draft starts with no key.

**On the 1606 copy** (`RUBIS_COPY_DIR`, the files copied to a temp folder first):
- The rehearsal passes 8 of 8 with the migration run on the real database.
- Every one of the 180 old orders reads `checkout_key` `NULL` and is otherwise unchanged.
- The copy's files are byte-identical after the run.

### Mutation checks (each restored; the file compared byte for byte afterwards)

| # | Mutation | Failing tests |
| --- | --- | --- |
| 1a | The look-up before the gates removed | 1: the manual M-Pesa repeat (refused as "code already used" instead of answered); the others are still caught by the look-up in the write |
| 1b | The look-up inside the write transaction removed | 4: the raced submit, and the SMS claim, confirmed payment and manual code wrappers |
| 2 | The unique index dropped | 2: the new-database index test, the migration test |
| 3 | A new key made on each submit | 1: the screen sends one key per cart |
| 4 | A keyless submit let through (`.optional()`) | 1: refused at the channel |

## Existing tests changed (each with an old/new note in the file)

| Test | Old | New |
| --- | --- | --- |
| `ipcValidator`, `cartDraftDb`, `cardManualPayment`, `mpesaManualPayment` (the schema fixtures) | checkout payloads with no key | each carries a key, which the schema now requires; no assertion changed |
| `runCheckout.test.ts` (3 hand-built database slices) | the slice without the look-up | `getOrderByCheckoutKey` added to the slice |
| `shifts.test.ts`, "persists shift_id…" | `shift_id` was the last INSERT parameter | `checkout_key` follows it (null); `shift_id` is the one before |
| `database.test.ts`, "safe to run against an already-migrated database" | every orders migration swallowed a duplicate-column throw | the key's migration reads the table's columns first; the fake now lists `checkout_key` for an already-migrated table |
| `tests/rehearsal/paulCopy.test.ts` | every column of every order compared | the columns the orders had compared, and the new `checkout_key` must read NULL |

## For the owner to check on the till after install

1. A cash sale, then the next one: two sales, as before.
2. A sale whose checkout failed (for example a manual code typed wrong), corrected and completed: one sale.

Nothing else on the till changes. A double tap was already stopped by the screen; this makes the main process stop it too.

## Observed but not changed

- **A cart restored from its saved draft after a crash starts with a new key** (the draft holds the items and the cart token, not the key). If the crash came after the order was written, the cart comes back and a second sale is possible, as today. Keeping the key in the draft would close it; it is a change to the draft, not asked here.
- **A repeat answered with the first order is treated by the screen as a completed sale:** the cart clears and the automatic print runs. A fiscal receipt already printed comes out marked as a copy by the existing print rule (phase 164), never as a second original.

## Rollback

Revert the commit. The `checkout_key` column and its index stay. Orders written with a key keep it; nothing reads it after the revert, and the partial index only refuses a duplicate key, which nothing writes after the revert.

## Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| Full suite | 232 files passed, 1 skipped (the rehearsal); 3,812 tests passed, 9 skipped (8 rehearsal, 1 build-freshness) |
| Rehearsal on the 1606 copy | 8 of 8; the copy's files unchanged |
| `npm run build` | passed, `verify-no-mock-provider` confirmed |
| Installer | not built |
