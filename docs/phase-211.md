# Phase 211 — the trader system invoice number from the location id: audit (stopped before the build)

- **Date:** 2026-10-03
- **Requested:** audit first (items 1 to 4), report and stop.
- **Outcome:** audit done, nothing built. The design holds; **two decisions** (section 5) and **three build notes** (section 4) come out of it.
- **Branch / base:** staging on `de5c838`.

## 1. Every builder, store and reader of the trader number

Phase 207 section 1 listed these; **nothing has been added since** (checked by search of `src/` for `buildTraderSystemInvNum`, `fiscal_trader_inv_num`, `traderInvNum`, `traderInvoiceNumber`, `TraderSystemInvNum`, `INV-`).

**Builders (three, one format):**
- The provider's private `buildTraderSystemInvNum(request)` ([real-etims-provider.ts:1680-1686](../src/main/services/integrations/real-etims-provider.ts#L1680-L1686)): `INV-<local_id, 9 digits>`, or the dash-stripped client uuid when there is no local id, then `slice(0, 15)`. Called once, in `buildOpenInvoiceArgs` ([:1666-1669](../src/main/services/integrations/real-etims-provider.ts#L1666-L1669)).
- The shared helper `lib/traderSystemInvoiceNumber.ts:34-43`: the same logic, a deliberate duplicate for reporting, pinned equal by `tests/traderSystemInvoiceNumber.test.ts`. **It truncates with `slice`; the new builder must throw instead.**
- The mock provider, inline ([mock-etims-provider.ts:116](../src/main/services/integrations/mock-etims-provider.ts#L116)): `INV-<local_id>`.

**Store:** `db.recordTraderInvNum` ([database.ts:2192-2196](../src/main/services/database.ts#L2192-L2196)), write-once (`COALESCE`), called by the provider's `recordTraderNumber` just before the first send ([real-etims-provider.ts:1104](../src/main/services/integrations/real-etims-provider.ts#L1104)) and by the mock. Column added at [database.ts:601](../src/main/services/database.ts#L601), schema [:744](../src/main/services/database.ts#L744). **Today the column is written at the first send, not at sale creation**, so an unsent sale holds NULL.

**Readers:**
- Reads the stored column: the receipt, [index.ts:3024](../src/main/index.ts#L3024) (`order.fiscal_trader_inv_num ?? undefined`), printed by `receiptLayout.ts:428-431` as `Invoice No:` and by `enjoySlip.ts:119`.
- Recompute with the shared helper (the four): [index.ts:3620](../src/main/index.ts#L3620), [reports.ts:1023](../src/main/services/reports.ts#L1023), [reportsExport.ts:115](../src/main/services/reportsExport.ts#L115) and [:175](../src/main/services/reportsExport.ts#L175).
- `cancelInvoice` takes `details.traderSystemInvNum` from its caller ([real-etims-provider.ts:2007](../src/main/services/integrations/real-etims-provider.ts#L2007)); it has no caller.

**Receipt width (new finding):** the number prints through `keyValueLines('Invoice No:', value, width)` ([receiptLayout.ts:269-283](../src/main/lib/receiptLayout.ts#L269-L283)); the default width is 48. A 14 or 15 character value plus the 11-character label fits any width of 32 or more on one line. If the width were smaller, the function moves the value to its own line rather than cutting it. **Not verified:** the narrowest width the till can be set to, and the receipt tripwire tests (phases 164, 165, 171) against a 14-character value; any fixture holding `INV-000000001` is unchanged because legacy numbers stay legacy.

## 2. The checkout path, and whether it is serialised

- The sale is written by `queueOrder` ([database.ts:1662-1727](../src/main/services/database.ts#L1662-L1727)): one `this.conn.transaction(...)`. Inside it the order row is inserted, then `input.buildFiscalRequest(localId)` is called ([:1717](../src/main/services/database.ts#L1717)) and the fiscal row queued. **This is the one place the number and the location can be written together**: allocate the number inside this transaction, insert it with the order, and hand it to `buildFiscalRequest` (a second argument).
- **Checkouts are not serialised as a whole.** `runCheckout` is async and awaits before it reaches `queueOrder` (payment gates, shift lookups), so two checkouts can interleave there. **What serialises the allocation is that `queueOrder`'s transaction is synchronous** (better-sqlite3, no `await` inside it): within one process two allocations cannot interleave, so reading `last_trader_seq`, choosing the value and writing it back are atomic.
- **Across two processes on one database file** (the two app copies running now) the transaction is `DEFERRED` by default. A second writer that read before the first committed would be refused rather than allowed to duplicate (Inference from SQLite's WAL rules; **Not verified here**). The single-instance lock is out of scope for this phase; **build note: take this one transaction `.immediate()`** so the read-modify-write holds the write lock from the start. That is a one-word change to `queueOrder`'s call.

## 3. The `settings` helpers

`getSetting(key)` ([database.ts:2662](../src/main/services/database.ts#L2662)) returns a string or `undefined`; `setSetting(key, value)` ([:2692](../src/main/services/database.ts#L2692)) stores a string. `last_trader_seq` is stored as a decimal string. Both use the same connection, so calling them inside `queueOrder`'s transaction is inside it.

## 4. The base 36 codes (item 4)

The Shopify location ids this store returned in phase 209-1 (read 3a), converted with Python:

| Location | Id (digits) | Base 36 | Length |
| --- | --- | --- | --- |
| Enjoy Haile Selassie | 78361919591 | `ZZYNW4N` | 7 |
| HQ | 77486882919 | `ZLHOTIF` | 7 |
| Hurlingham | 77486915687 | `ZLHPISN` | 7 |
| Rubis Enjoy Karen | 77557923943 | `ZMNZH47` | 7 |
| **Rubis Kisumu** | 77557989479 | `ZMO0VON` | 7 |
| Rubis Kitengela | 77557956711 | `ZMO06EF` | 7 |
| Westlands | 77488226407 | `ZLIHM5J` | 7 |

**All seven are 7 characters.** 36^7 is 78,364,164,096 and Enjoy Haile Selassie's id is **2,244,505 below it**, so the next location Shopify creates is likely to have an **8-character** code. Both lengths are therefore real, not hypothetical, and the total is then exactly 15 (`L` + 8 + 6), with no room to spare. A 9-character code would need an id above 2.8 trillion; the builder's throw covers it.

**Example numbers for a sale at 2026-10-03T00:00:00Z.** Seconds since 2026-01-01T00:00:00Z: 23,760,000, which is `0E59C0` in 6 characters.
- This till, Rubis Kisumu: **`LZMO0VON0E59C0`** (14 characters).
- The Haile Selassie till, Enjoy Haile Selassie: **`LZZYNW4N0E59C0`** (14 characters).
- (36^6 seconds is 68.98 years, so the 6-character sequence lasts until about 2095.)

**The location list came from the earlier read, not a fresh one:** no Shopify token is set in my shell (`SHOPIFY_TOKEN` is empty), so I made no new curl call. A location created after 2026-10-02 is not in this table.

## 5. Findings that need a decision, and build notes

**D1. Two tills at one location can collide.** The code is the location's, so two tills in the same shop get the same code, and each till's sequence comes from its own clock. Two sales in the same second, one at each till, would produce the same 14-character number on a control unit shared by the shop. The monotonic guard works only inside one till's database. **What the device does with a duplicate `TraderSystemInvNum` has never been captured (phase 208).** Today the topology is one till per shop (the owner's split: Kisumu and Haile Selassie are different shops), so the risk is not present now. Options: (a) accept it and record it in `docs/KNOWN_GAPS.md`, to be revisited when a second till joins a shop (my recommendation); (b) add a till discriminator, which has no room when the code is 8 characters and costs the "nothing configured, nothing stored" rule when it is 7.

**D2. A clock before 2026-01-01.** The sequence would be negative. Proposed rule: treat a negative value as 0, then apply the monotonic guard. A wiped database loses `last_trader_seq`, so a wiped till with its clock set **behind** its earlier sales could repeat a number; that needs a wrong clock and a wipe together, and I propose to record it as a known limit rather than build for it.

**Build notes:**
1. The allocation goes inside `queueOrder`'s transaction (made `.immediate()`), writes `orders.fiscal_trader_inv_num` with the INSERT (so it exists from creation, not from first send), and passes the number to `buildFiscalRequest`. `FiscalInvoiceRequest` gains an optional `traderInvNum`; the provider sends it when present and builds the **legacy** `INV-<local_id>` form only when it is absent.
2. The new builder lives in `traderSystemInvoiceNumber.ts` beside the legacy one, takes the location **id** (it parses the digits from `gid://shopify/Location/<digits>`, and throws if there are none), and throws when the result exceeds 15. The legacy function keeps its `slice`, as the old tests pin.
3. The four recompute readers read `fiscal_trader_inv_num` first and fall back to the legacy form only on NULL; the mock builds from the same function.

## 6. Not verified

- Two-process behaviour of the allocation (section 2).
- The narrowest receipt width and the layout tripwire tests against a 14-character number.
- The current list of locations (no token in this shell).
- What the device does on a duplicate `TraderSystemInvNum`.

## 7. Rollback

Nothing to roll back: audit only.
