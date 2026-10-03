# Phase 210-2 — tags on existing Shopify orders

- **Date:** 2026-10-03
- **Follows:** [phase-210-1.md](phase-210-1.md) section 3 (existing orders) and [phase-209-1.md](phase-209-1.md) (the read-only listing).
- **Outcome:** six orders tagged; the rest deliberately left untagged. **Tags only.** No cancel, refund, fulfillment or stock movement in this phase.

## 1. The split, as the owner confirmed it on 2026-10-03

- **#1082, #1083:** Enjoy Haile Selassie (stated by the owner).
- **#1084, #1085, #1086** (about 16:00 Nairobi on 2 October): the other till's, and the owner confirmed they carry the Haile Selassie tag.
- **#1087:** this till's (Rubis Kisumu), per the owner's rule that the late-evening orders are this till's. It was cancelled earlier the same day (phase 209-2); the tag is for the record.
- **#1062 to #1081:** the owner said to **leave them untagged**.

## 2. What was sent

By curl, one `tagsAdd(id, tags: [...])` per order, adding only the tag, each followed by a read of the order. `userErrors` was empty on every call.

| Order | Shopify id | Tag added | Read back |
| --- | --- | --- | --- |
| #1082 | `gid://shopify/Order/7788530565223` | `location:enjoy-haile-selassie` | tags `[location:enjoy-haile-selassie]`, UNFULFILLED |
| #1083 | `gid://shopify/Order/7788727861351` | `location:enjoy-haile-selassie` | tags `[location:enjoy-haile-selassie]`, UNFULFILLED |
| #1084 | `gid://shopify/Order/7800577785959` | `location:enjoy-haile-selassie` | tags `[location:enjoy-haile-selassie]`, UNFULFILLED |
| #1085 | `gid://shopify/Order/7800622481511` | `location:enjoy-haile-selassie` | tags `[location:enjoy-haile-selassie]`, UNFULFILLED |
| #1086 | `gid://shopify/Order/7800691851367` | `location:enjoy-haile-selassie` | tags `[location:enjoy-haile-selassie]`, UNFULFILLED |
| #1087 | `gid://shopify/Order/7801903054951` | `location:rubis-kisumu` | tags `[location:rubis-kisumu]`, UNFULFILLED, cancelled |

The slug follows the phase 210 rule (lowercase, spaces to hyphens), the same function the till uses for new orders.

## 3. Not done, and why

- **Stock location on these orders is unchanged.** Per phase 209-1 the "test" orders #1082, #1083 and #1087 were decremented at Enjoy Haile Selassie; #1087's unit has since been restocked there. Whether the real-item orders #1084 to #1086 were decremented at the location their tag names was **not checked**. Moving stock needs `fulfillmentOrderMove`, which needs fulfillment-order scopes the token does not have (phase 210 finding B); nothing that changes a stock figure runs without a written go.
- **The verification sale** (phase 210-1 section 3) has not been made yet.

## 4. Rollback

`tagsRemove` on the same ids restores the previous state (the orders carried no tags before).
