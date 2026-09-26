# Phase 161-1 - Make the live-mode discount safeguard fail closed

Disciplined-engineering build task, one commit. Follows on from
docs/phase-161's Commit 1 (the renderer-side discount/override
safeguard), closing the gap where a slow, failed, or not-yet-resolved
read of the fiscal mode defaulted to "safe to show the controls" -
exactly backwards for a safeguard.

**Hard rules observed**: no change to `buildFiscalRequest`,
`real-etims-provider.ts`, `fiscal-retry.ts`, `fiscal-routing.ts`,
`orders.ts`, or the receipt (`printer.ts`/`pdf-receipt.ts`/
`receiptTotals.ts`) - confirmed untouched by `git status`. Tripwires
(fiscal suite, `mpesaPaymentGate`, keyboard tests, Phase E layout tests)
are listed with every affected file below; no assertion in any of them
was changed - three needed a fixture-setup addition to keep their
existing assertions true, explained in full in section 3.

- **Date:** 2026-09-26
- **Branch / base commit:** staging @ c2cb1fd (Phase 161 report).
- **Outcome:** Implemented.

---

## 1. `fiscalModeStore` fails closed

### Audit

- `src/renderer/src/stores/fiscalModeStore.ts` (before this change) -
  `fiscalLive: boolean`, defaulting `false`, staying `false` on any
  failed or thrown read. Every consumer (`CartLineItem.tsx:64`,
  `PosCheckoutPanel.tsx:66,135`) read it as a plain boolean
  (`!fiscalLive` / `fiscalLive && ...`).
- `tests/fiscalModeStore.test.ts` (before this change) - 5 tests, 3 of
  them titled "keeps the false default...".

### Change

`fiscalLive` is now a tri-state `FiscalMode = 'unknown' | 'live' | 'mock'`,
starting and remaining `'unknown'` unless a read comes back and
explicitly says `false`:

```ts
init: async () => {
  if (get().initialized) return
  set({ initialized: true })
  try {
    const result = await window.api.isFiscalLive()
    if (result.success && result.data !== undefined) {
      set({ fiscalLive: result.data ? 'live' : 'mock' })
    }
    // A validation/service failure leaves the state at 'unknown'.
  } catch {
    // Same reasoning - a thrown IPC call leaves 'unknown' in place.
  }
}
```

A new exported `isFiscalModeLiveOrUnknown(mode): boolean` returns `true`
for `'unknown'` and `'live'`, `false` only for `'mock'` - the single
place this "treat unknown as live" rule is written, used by both
`CartLineItem.tsx` (`controlsHidden`) and `PosCheckoutPanel.tsx`
(`controlsHidden`, and `staleDiscountOrOverride = controlsHidden && hasDiscountOrOverride(...)`).
Every `!fiscalLive`/`fiscalLive && ...` check in both components was
replaced with this derived boolean - a raw `boolean | null` was
considered and rejected: `!fiscalLive` would have been `true` for both
`false` (correctly shown) and `null`/unknown (incorrectly shown too) -
exactly the footgun this phase exists to remove, so a named tri-state
plus one small named predicate was used instead of a value that reads
correctly only if you remember its polarity.

### Deliberate test changes (old -> new -> why)

All in `tests/fiscalModeStore.test.ts`:

1. **`keeps the false default when the main process reports the mock provider`**
   -> **`sets fiscalLive to mock only on a successful read of false`**.
   - **Old**: `expect(...fiscalLive).toBe(false)`.
   - **New**: `expect(...fiscalLive).toBe('mock')`.
   - **Why, and a deliberate deviation from the task's literal wording**:
     the task's item 1 says "the three 'keeps false' cases become 'stays
     unknown and treated as live'". This test's title matched that
     pattern textually, but it is a **successful** read of `false` - the
     one case item 1 itself says must show the controls ("Only a
     successful read of false shows the controls"). Turning it into
     "stays unknown" would contradict that sentence directly. Renamed
     and re-asserted to `'mock'` instead, and the two genuinely-failing
     cases below were the ones actually renamed to "stays unknown".
2. **`keeps the false default rather than guessing when the read fails`**
   -> **`stays unknown and treated as live when the read fails`**.
   - **Old**: `expect(...fiscalLive).toBe(false)`.
   - **New**: `expect(...fiscalLive).toBe('unknown')`, plus
     `expect(isFiscalModeLiveOrUnknown(...)).toBe(true)`.
   - **Why**: fails closed - a validation/service failure must never be
     read as a confirmed mock provider.
3. **`keeps the false default rather than guessing when the IPC call throws`**
   -> **`stays unknown and treated as live when the IPC call throws`**.
   - **Old**: `expect(...fiscalLive).toBe(false)`.
   - **New**: same as above.
   - **Why**: same reasoning, the throw path.

Two new tests were added: `starts as unknown before init resolves` (the
store's own default, asserted directly) and one for
`isFiscalModeLiveOrUnknown` itself (`'unknown'`/`'live'` -> `true`,
`'mock'` -> `false`).

### Mutation check (not explicitly requested for this item, run anyway since it was cheap and the new tests are the whole point of this change)

Changed the `catch` block to `set({ fiscalLive: 'mock' })` (the old,
wrong, permissive behaviour) - the "stays unknown... when the IPC call
throws" test failed immediately (`expected 'mock' to be 'unknown'`); the
other 6 tests in the file were unaffected. Reverted; `git diff` on
`fiscalModeStore.ts` matched the intended change exactly.

---

## 2. Server-side belt-and-braces in `orders:checkout`

### Audit

- `src/main/index.ts:1078-1131` (`orders:checkout` handler, before this
  change) - validates the request, then goes straight into the
  manual-M-Pesa handling and `runCheckout`, with no fiscal-mode check at
  all server-side.
- `src/main/lib/ipcValidator.ts:26-42` (`cartItemSchema`) - confirmed
  `basePrice` **is** present on the validated request
  (`basePrice: z.number().finite().nonnegative().optional()`), which
  matters for the decision below.
- The five existing `fiscalizationProvider instanceof RealFiscalizationProvider`
  checks already in `index.ts` (`820,843,985,1712,1976` before this
  change) - the established pattern to read the actual resolved provider
  rather than re-deriving the mock/packaged decision.
- No test in this codebase mounts an `index.ts` IPC handler directly
  (confirmed again here, same finding as docs/phase-158-1's own audit) -
  this shaped how the required test list (item 3) was implemented (see
  below).

### Change

1. **`src/main/lib/requestHasDiscount.ts`** (new):
   - `requestHasDiscount(request): boolean` - `true` if `cartDiscount` is
     set or any line's `discount` is set.
   - `shouldRefuseCheckoutForDiscount(isRealFiscalProvider, request): boolean` -
     `isRealFiscalProvider && requestHasDiscount(request)`. Exported
     separately from the two facts it combines specifically so the
     whole decision is unit-testable without mounting the IPC handler
     (see the audit note above) - `index.ts` calls it with exactly
     `fiscalizationProvider instanceof RealFiscalizationProvider`, never
     re-derived.
2. **`src/main/index.ts`**'s `orders:checkout` handler - immediately
   after schema validation succeeds, **before** the manual-M-Pesa
   handling and before `runCheckout` is called at all:
   ```ts
   if (shouldRefuseCheckoutForDiscount(fiscalizationProvider instanceof RealFiscalizationProvider, validation.data)) {
     return { success: false, error: 'Discounts cannot be filed with KRA yet. Remove the discount and try again.' }
   }
   ```
   Returning here means nothing downstream runs at all for a refused
   request - no `db.queueOrder`/`queueOrderRecordingMpesaPayment`/etc.,
   no `runCheckout` call, no Shopify sync tick, no fiscal submission.
   Mock mode is unaffected - `shouldRefuseCheckoutForDiscount` is `false`
   whenever `isRealFiscalProvider` is `false`, regardless of the
   request's discount fields.
3. **`docs/KNOWN_GAPS.md`** - a new entry recording that a price override
   is **not** checked server-side, with the accurate reasoning (see
   below - a correction to the task brief's own stated premise).

### A correction to the task brief's stated premise (price override)

The task brief says "no `basePrice` in the request" as the reason not to
detect a price override server-side. **This is not accurate** -
`cartItemSchema` (`ipcValidator.ts:35`) does carry `basePrice` on every
line item, confirmed by reading the schema directly. The **actual**
reason not to build an `item.price !== item.basePrice` check, recorded
in `docs/KNOWN_GAPS.md` instead of the brief's stated one: both `price`
and `basePrice` are entirely renderer-supplied and unverified against
the till's real catalog data, so a request could set `price` to any
value while also setting `basePrice` to match it - defeating this exact
check without touching `discount`/`cartDiscount` at all. Building it
would give a false sense of a closed loophole rather than actually
closing one. The task's own instruction (don't build it, record it as a
residual gap) is followed; only the *reason* given is corrected, since
the file:line evidence contradicts the brief's stated premise and this
project's own standing rule is to report what the code actually shows.

### Tests

- **`tests/requestHasDiscount.test.ts`** (new, 9 tests):
  - `requestHasDiscount`: no discount anywhere (false); a line discount
    (true); a cart discount with no line discount (true); both together
    (true); an empty `items` array with no cart discount (false).
  - `shouldRefuseCheckoutForDiscount` (item 3's exact required list):
    refuses a real-provider checkout with a line discount; refuses one
    with a cart discount; does not refuse a real-provider checkout with
    neither; does not refuse a mock-provider checkout even with both a
    line and a cart discount present.

### Mutation check (required by item 3)

Changed `shouldRefuseCheckoutForDiscount`'s body to `return false`
unconditionally - the two refusal tests ("refuses a real-provider
checkout carrying a line discount" / "...a cart discount") failed
immediately (`expected false to be true`); the two non-refusal tests
("no discount at all" / "mock-provider... with both") correctly kept
passing, since they already expected `false`. Reverted; `git diff`
confirmed the file matched the pre-mutation version exactly (the file is
new/untracked, so this was confirmed by re-reading the restored line
rather than `git diff`, which shows nothing for an untracked file).

---

## 3. Ripple effect on three pre-existing real-mount tests (setup only, no assertion changed)

Changing `fiscalModeStore`'s default from `false` (controls shown) to
`'unknown'` (controls hidden, per item 1) has a real consequence: any
existing real-mount test that renders `CartLineItem`/`PosCheckoutPanel`
without itself setting the store now sees the discount/override controls
hidden, where it previously saw them shown. Three pre-existing test
files were affected - all three are tripwires (`posCheckoutPanelFit.test.ts`,
a Phase E layout test; `cartLayout.test.ts`, a layout smoke test;
`priceDiscountKeypad.test.ts`, the docs/phase-156 keyboard-conversion
test) - found by grepping every test file for a `button('Discount')`/
`button('+ Discount')`/`button('Edit Price')` interaction
(`tests/*.test.ts`, five matches: these three plus this phase's own two
new gate-test files, which already set the store correctly).

**No assertion in any of the three was changed.** Each gained the same
one-line addition to its existing `beforeEach`/`afterEach` -
`useFiscalModeStore.setState({ fiscalLive: 'mock', initialized: true })`
/ reset to `'unknown'` on cleanup - restoring the implicit assumption
these tests always made (the controls are visible), which was true by
accident of the old default before this phase and is now true by an
explicit, commented fixture line instead. Each addition carries a
comment explaining exactly this, and pointing at
`cartLineItemFiscalGate.test.ts`/`posCheckoutPanelFiscalGate.test.ts` as
the dedicated coverage for fiscal-mode gating itself, so a future reader
does not mistake the new line for something these tests are meant to be
testing:

- `tests/posCheckoutPanelFit.test.ts` - fixes
  `the merged row still opens the discount entry, exactly as before`
  (was failing with `No button "+ Discount"` before this addition).
- `tests/cartLayout.test.ts` - fixes
  `renders the Edit Price and Discount action pills`.
- `tests/priceDiscountKeypad.test.ts` - fixes all 7 of its tests (every
  one of them taps "Edit Price", "Discount", or "+ Discount" to open an
  editor).

This was found by actually running the affected suites after item 1's
change and reading the failure, not guessed at in advance - the exact
failure (`tests/posCheckoutPanelFit.test.ts > ... > the merged row still
opens the discount entry, exactly as before` -> `No button "+ Discount"`)
is what led to the grep across every test file for the same pattern,
which is how `cartLayout.test.ts` and `priceDiscountKeypad.test.ts` were
found before they could fail a later, unrelated run.

---

## Affected files and functionality

| File | Change | Functionality affected |
| --- | --- | --- |
| `src/renderer/src/stores/fiscalModeStore.ts` | Modified | `FiscalMode` tri-state, fails closed |
| `src/renderer/src/components/CartLineItem.tsx` | Modified | Uses `isFiscalModeLiveOrUnknown` |
| `src/renderer/src/components/PosCheckoutPanel.tsx` | Modified | Same, plus the stale-discount block |
| `src/main/lib/requestHasDiscount.ts` | Added | Server-side discount detection and refusal decision |
| `src/main/index.ts` | Modified | `orders:checkout` refuses a discounted request on a real provider |
| `docs/KNOWN_GAPS.md` | Modified | Records the price-override gap, with the corrected reasoning |
| `tests/fiscalModeStore.test.ts` | Modified | Tri-state transitions, listed above |
| `tests/cartLineItemFiscalGate.test.ts`, `tests/posCheckoutPanelFiscalGate.test.ts` | Modified | Updated to the tri-state values; added `'unknown'`-mode coverage |
| `tests/posCheckoutPanelFit.test.ts`, `tests/cartLayout.test.ts`, `tests/priceDiscountKeypad.test.ts` | Modified | Fixture-setup addition only, no assertion changed (section 3) |
| `tests/requestHasDiscount.test.ts` | Added | The server-side check's own unit tests |

## Possible impact

- **Direct**: on a live till, a slow or failed read of the fiscal mode
  now hides the discount/override controls (previously it briefly
  showed them). A discounted `orders:checkout` request against a real
  fiscal provider is now refused outright with a clear message, even if
  the renderer's own hide somehow failed or was bypassed.
- **Indirect**: three pre-existing tests needed a fixture-setup line to
  keep passing (section 3) - no production code path outside the files
  listed above is affected.
- **Data / schema / contract**: none. The refusal happens before any
  write; the `ServiceResult` error shape is unchanged.
- **Security posture**: improved, specifically for the "buggy renderer"
  case the belt-and-braces check exists for - a request cannot bypass
  the discount refusal by racing the fiscal-mode read; it can still
  claim a `basePrice` that matches its `price` to hide a genuine
  override, which is why that specific check was not attempted (see the
  correction above and the new `KNOWN_GAPS.md` entry).
- **Idempotency / re-run safety**: unchanged - both new functions are
  pure, and the refusal is a plain early return.
- **Residual risk**: exactly the one recorded in `KNOWN_GAPS.md` - price
  overrides are not detected server-side.

## Verification

- `npm run typecheck` - clean (both `typecheck:node` and
  `typecheck:web`).
- `npx vitest run` (full suite) - **124 test files, 1855 tests, all
  passing**, confirmed on two consecutive clean runs.
- `npm run build` - succeeds; `verify-no-mock-provider.cjs` confirms
  neither mock fiscal provider is in the packaged output.
- `npm run check:fit` - **18/18 cases pass**, no overflow, including the
  Cash/M-Pesa checkout panel now gated by the tri-state fiscal mode.
- **Tripwires**: `git status` confirms no file in the fiscal suite
  (`real-etims-provider.test.ts`, `fiscal-retry.test.ts`,
  `fiscal-routing.test.ts`, `fiscalValidate.test.ts`, `checkout.test.ts`,
  etc.), no `mpesaPaymentGate`-related file, and no other Phase E layout
  test (`screensFitDesignBox.test.ts`, `headerLayout.test.ts`,
  `belowLgUnreachable.test.ts`) was touched. The three tripwires that
  *were* touched (`posCheckoutPanelFit.test.ts`, `cartLayout.test.ts`,
  `priceDiscountKeypad.test.ts`) had a fixture-setup line added, with
  every existing assertion in them left unchanged and re-verified
  passing - see section 3.

No version bump. No installer rebuild.

## Rollback

`git revert` this phase's commit. No data or config migration is
involved.

## Observed but not changed

- A genuine server-side price-override check would need the main
  process to independently know a variant's real catalog price (e.g.
  from the last-synced product cache) rather than trusting anything the
  request itself claims - not proposed or built here, recorded in
  `docs/KNOWN_GAPS.md`.
- The mock-mode `console` warning `resolveFiscalizationProvider` already
  logs (`fiscal-provider-factory.ts:63-66`) was not touched and remains
  the only server-side signal of which provider is active outside this
  phase's new `fiscal:is-live` channel (docs/phase-161) and the new
  `orders:checkout` check.

**STOP for review.**
