# Phase 252-2 — Split payment button always on the cart, no admin setting

- **Date:** 2026-10-06
- **Asked by the owner:** the 23:00 file. A customer buys an item of 1,500 and pays 1,000 by M-Pesa and 500 by cash or card: one sale, one fiscal invoice, one receipt. The checkout panel always shows a "Split payment" button. A sale is paid one way unless the cashier taps it. The admin setting goes.
- **Status:** built and tested in one commit. Released in 2.2.10 (see the report).
- **D8:** this phase ends the "off until VIL answers" ruling of 22:35. Splits are now on every till that installs this build. That is the owner's decision in this file; D8 itself is still **Being confirmed**.

## The setting: every place it was read or written (lines at `5b35b2a`), and what happened to each

| Where | What it did | Now |
| --- | --- | --- |
| `src/main/services/checkout.ts:176-180` | `SPLIT_PAYMENTS_SETTING_KEY = 'split_payments_enabled'` | removed |
| `src/main/services/checkout.ts:185-187` | `SPLIT_PAYMENTS_OFF_MESSAGE` | removed |
| `src/main/services/checkout.ts:409-414` | `RunCheckoutDeps.splitPaymentsEnabled` | removed |
| `src/main/services/checkout.ts:652`, `666` | `SplitDeps` carried it; `decideSplit` refused a split when it was not `true` | the field and the refusal removed. `decideSplit` checks the payments and runs the gates exactly as in 252 |
| `src/main/index.ts:237`, `1500` | imported the key; read the row for each checkout | removed |
| `src/renderer/src/lib/splitPayments.ts:10-11` | the key, mirrored for the screen | removed |
| `src/renderer/src/components/PosCheckoutPanel.tsx:20`, `106-107`, `114-129`, `517` | read the row through `getAllConfigs`; showed the button only when it was `'true'` | removed; the button is always there (below) |
| `src/renderer/src/components/AdminScreen.tsx:5`, `467-469`, `682`, `691-713`, `1537-1565` | the System tab's "Split Payments" section: its toggle, its load, its PIN-gated save | removed. `AdminScreen.tsx` is now byte for byte as before phase 252 (`git diff 1e83da5~1` is empty for it) |
| `tests/splitPayments.test.ts:5`, `23`, `87`, `216-235`, `273` | the deps set it; two tests pinned the refusal | the deps no longer set it; the two refusal tests became "accepted with no row" and "accepted with an old row set to false" |
| `tests/splitPaymentsUi.test.ts:97-113` and seven mounts | the button's three setting tests; the mounts served `'true'` | replaced by the button tests below; the mounts serve no row |
| `tests/splitCartLock.test.ts:54` | its stub served `'true'` | removed from the stub |

**An existing row is ignored, not deleted.** Nothing reads `split_payments_enabled` any more, and nothing writes or deletes it. A till that saved it keeps the row, unread; a test pins that an old `'false'` row stays `'false'`.

**Every other split check in the main process is exactly as built in 252:**
- `checkSplitPayments` (two to four payments, cash once and last, nothing above what is due, adding up in cents, no code twice);
- each payment through today's gate;
- the one-transaction write;
- the 249 key.

## The button

| # | Rule | How |
| --- | --- | --- |
| B1 | Always shown, beside Cash, M-Pesa and Card | a fourth button in the method row, which is now four equal columns (`grid-cols-4`), [PosCheckoutPanel.tsx](../src/renderer/src/components/PosCheckoutPanel.tsx) |
| B2 | A sale is paid one way by default; the till never opens in split mode | `splitMode` starts `false` and only the button sets it |
| B4 | Cancel split returns to one way, cart unlocked | unchanged from 252 and 252-1: Cancel split closes the split panel, which clears the lock |
| B5 | Disabled, not hidden, while a one-way payment is in progress | off while the M-Pesa or card screen is open (any method but Cash), while any payment is in progress (the phase-217 flag), and with nothing in the cart |
| B6 | After a split sale, the next sale is one way | a completed sale sets `splitMode` back to `false`, as 252 did |
| B7 | Not changed | the 252 rules (S1 to S8), the 252-1 lock, the fiscal code and request, the M-Pesa and card gates, the 249 key, shifts, reports |

## Tests

**Main process** ([splitPayments.test.ts](../tests/splitPayments.test.ts), real `:memory:` SQLite; 35 tests, 2 replaced and 4 added):
- **No setting:**
  - a split is accepted with no setting row at all;
  - it is accepted with an old row set to `'false'`, which stays as it was.
- **1,500 = 1,000 M-Pesa (manual code) + 500 cash with 1,000 handed over:**
  - one order and two payments;
  - change 500, on the cash part only;
  - one `mpesa_payments` row of 1,000;
  - one fiscal call;
  - the receipt, built from the stored order as the print handler builds it, lists `PAID BY M-PESA 1,000.00`, the code, `PAID BY CASH 500.00`, `Tendered: 1,000.00` and `Change: 500.00`.
- **1,500 = 1,000 M-Pesa (manual code) + 500 card:** the same, with no change line on the receipt and `change_due` 0.
- **All of 252's refusals still refuse,** with nothing written: not adding up, above what is due, two cash, cash not last, five payments, the same code twice, a refused gate, a code already used.

**Screen** ([splitPaymentsUi.test.ts](../tests/splitPaymentsUi.test.ts), real mount; 16 tests):
- **The button:**
  - it shows, enabled, with no setting row and with an old `'false'` row;
  - it sits in the method row: `CASH`, `M-PESA`, `CARD`, `Split payment`;
  - it is disabled while the M-Pesa screen of a one-way sale is open, and while the card screen is open.
- **One-way by default:** a new sale starts one way, Cash selected, with no split panel.
- **Cancel split:** it returns to one way with the cart unlocked.
- **After a split sale completes,** the next sale starts one way, Cash selected, unlocked.
- **252's flow tests,** unchanged but mounted with no setting.

**Admin** ([adminNoSplitSetting.test.ts](../tests/adminNoSplitSetting.test.ts), real mount): there is no split toggle on the main page or the System tab, even with an old `'true'` row served.

### Mutation checks (each restored; the file compared byte for byte afterwards)

| # | Mutation | Failing tests |
| --- | --- | --- |
| 1 | The button hidden when no setting row exists | 20: every button test, every split flow test and every 252-1 lock test |
| 2 | The main-process setting check put back | 22: both "accepted" tests, both examples, and every split test that writes or is refused for another reason |
| 3 | A new sale starts in split mode | 22, including "a new sale starts paid one way, Cash selected" |

## Existing tests changed (each with a note in the file)

| Test | OLD | NEW |
| --- | --- | --- |
| `posCheckoutPanelCard.test.ts` "lays the toggle row out…" | three equal columns (`grid-cols-3`) | four (`grid-cols-4`): the three methods and Split payment |
| `splitPayments.test.ts`, `splitPaymentsUi.test.ts`, `splitCartLock.test.ts` | the setting served or set | as in the table above |

## Rollback

Revert the commit. The setting and its Admin toggle come back, off by default. The rule of 252 stands: once a split sale exists, the payment reader must stay.

## Not verified

- **The method row, not measured:** no `check:fit`, by the standing rule. It now has four buttons in the 35% checkout aside; the owner checks it on the till. The Split payment text is smaller (`text-sm`) and may wrap to two lines inside its 48px button.
- **Never run on a live till here.**

## Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| Full suite | 238 files passed, 2 skipped (the copy rehearsals); 3,895 tests passed, 10 skipped. The tenth is the bundle-wording check, which skips itself while the build is older than the sources; it passed after the build |
| Mutation checks | 3 of 3 caught, every file restored byte for byte |
| `npm run build` | passed, `verify-no-mock-provider` confirmed |
