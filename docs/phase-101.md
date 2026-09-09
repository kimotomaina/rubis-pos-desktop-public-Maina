# Phase 101 — Part 1: the SMS inbox reader and the reassembly question

Builds the reader half of the SMS M-Pesa confirmation method designed in
`docs/phase-100.md`. No provider, no UI, no checkout change yet — this part
settles how messages get off the modem and into the database exactly once.

**Nothing in this part can complete a sale.** The reader stores confirmations;
approving one against a sale is Part 5/6. Daraja is untouched.

---

## 1. The reassembly question, and how it is answered

The audit named this the highest-risk unknown: an M-Pesa confirmation is longer
than a single 160-character SMS, so it travels as a concatenated multipart
message, and whether gammu-smsd's files backend writes the parts as one file or
several has not been observed against the real modem.

**The reader handles both, through one code path.** A single-file message is a
group of one.

### How parts are grouped

gammu's documented inbox file name carries everything needed:

```
IN20260907_134401_00_MPESA_00.txt
  └─date──┘ └time┘ │  └sender┘ └sequence
                   └ part index within a multipart message
```

- **Group key:** sender + received timestamp.
- **Order within a group:** part index, then gammu's same-second sequence, then
  file name — so the result never depends on the order the directory happened
  to list.
- **Join:** contents concatenated with no separator, after stripping *only* each
  part's trailing line break. Trailing spaces are left alone deliberately: a
  concatenated SMS can split on a space, and swallowing it would run two words
  together and change what the parser sees.
- **A file whose name is not gammu's** — a differently-configured `InboxFormat`,
  or anything else in the folder — becomes a message of its own rather than
  being dropped or guessed at.

### If the grouping assumption is wrong, it fails safe

The assumption is that gammu writes every part of one concatenated message with
the same sender and received timestamp. **If the real modem writes parts with
differing timestamps, each part becomes its own message, every one fails to
parse, and the payment is simply not offered to the cashier.**

That blocks a sale, which is the correct direction for a payment: the cost is a
delay, not released stock. It is also immediately visible rather than silent,
which is what makes this a verify-with-real-modem item and not a hidden risk.

A deliberate non-decision: I did not add content-sniffing fallbacks (joining
groups whose text "looks incomplete"). That is speculative complexity on a
money path, and the failure it would guard against is already safe. Settle it
with one real payment instead.

### Two payments in the same minute stay apart

Explicitly tested. Grouping on the exact timestamp means two payments a minute
apart are two messages. Merging them would produce a blob that fails to parse —
still safe, but the test pins the correct behaviour rather than relying on the
safety net.

---

## 2. What was built

| File | What it is |
|---|---|
| `src/main/lib/mpesaSms.ts` | the `MpesaSmsPayment` / `MpesaSmsParser` contract, types only |
| `src/main/services/integrations/gammu-inbox.ts` | pure: decode one file, group and join parts |
| `src/main/services/mpesa-sms-inbox.ts` | the poller: folder I/O, settle window, store, health |
| `database.ts` | `mpesa_sms_messages` table plus three methods |

**The parser is injected, not imported.** It is the piece that still has to be
settled against real captured messages, and keeping it out means this part's
behaviour is proven on its own rather than betting on a regex at the same time.
Its tests use a deliberately crude stand-in. Part 2 fills in the real one behind
the same type.

### Polling, not watching

`setInterval` every 3 seconds, on the pattern
[connectivityMonitor.ts:108-111](../src/main/services/connectivityMonitor.ts#L108-L111)
already uses. `fs.watch` on Windows, against a folder another process is
writing, misses events, doubles them, and fires before a write finishes — none
of which are acceptable on a payment path. The project has no watcher dependency
today and does not gain one here.

Concurrent polls coalesce into the one in flight, so a slow folder cannot stack
up passes.

### Encoding

The byte-order mark decides, rather than an assumption: UTF-8 (mark stripped),
UTF-16LE, UTF-16BE (byte-swapped), and plain UTF-8 when there is no mark. That
covers gammu writing UCS-2 for a message that needed it. **Still to pin against
a real file** — see §5.

### The settle window

A parse failure hides two different things: a file gammu is still writing, and
the first part of a multipart message whose second part has not landed yet. Both
resolve in seconds, and neither is a reason to write a file off.

So a message that fails to parse is left exactly where it is and reconsidered on
the next poll — **with any later part of the same message alongside it** — until
it has been untouched for `FILE_SETTLE_MS` (10 seconds). Only then is it
accepted as not a payment.

Ten seconds is a deliberate choice: long enough for the second part of a
concatenated SMS to arrive, short enough that a genuinely unreadable file stops
being re-read quickly. The residual edge — a second part arriving more than ten
seconds after the first — ends in the safe direction (no payment offered,
nothing approvable) and is on the verify list.

A file that cannot be read at all this pass (locked mid-write, `EBUSY`, deleted
between listing and reading) is skipped and retried next poll. Tested.

### Non-payment messages are ignored, not flagged

A till receives plenty of legitimate non-payment SMS: balance alerts, promos,
airtime. Once settled, these are marked resolved and logged only when debug
logging is on. Treating them as errors would bury a real problem in noise.

### Gammu's files are never touched

No deletes, no moves. Deleting races with gammu still writing, and a destroyed
inbox file is unrecoverable evidence for a money transaction. Processed state
lives in the database.

An in-memory set of already-resolved file names keeps each poll proportional to
what is new rather than to a folder that only grows. **That set is an
optimisation and never the thing that prevents a double payment** — losing it on
restart costs one full re-read and nothing else. There is a test that builds a
second reader over the same folder, proving the second pass stores nothing new.

---

## 3. Dedup lives in SQLite, and that is load-bearing

```sql
CREATE TABLE IF NOT EXISTS mpesa_sms_messages (
  transaction_code TEXT NOT NULL UNIQUE,
  ...
  raw_text TEXT NOT NULL,
  matched_order_local_id INTEGER,
  approved_by_staff_id INTEGER,
  approved_at TEXT,
  ...
)
```

`insertMpesaSmsMessage` uses `ON CONFLICT(transaction_code) DO NOTHING` and
returns `{ inserted }`. Three consequences, each tested against a real in-memory
SQLite rather than a mock:

1. **One payment can never become two approvable rows**, however many times its
   message is read.
2. **A repeat is not an error.** It is the normal case, so it does not throw and
   does not log.
3. **A conflict never overwrites.** If the same code somehow arrives with
   different details, the first reading wins and stays beside its `raw_text`,
   rather than a later re-read silently rewriting a payment a cashier may
   already have approved.

`raw_text` keeps the message verbatim. The parsed fields are an interpretation;
anyone checking a disputed payment later needs the original.

Read methods added now: `getMpesaSmsMessageByCode` (case- and
whitespace-insensitive, because a cashier types it) and
`listUnmatchedMpesaSmsMessages`. Matched messages are excluded from the list
outright rather than shown greyed — a payment already spent is not a candidate
for this sale, and offering it invites a double credit.

**Deliberately not built yet:** marking a message matched. Its rules (exact
amount, already-matched, who approved) are Part 5/6's subject and belong with
the tests that pin them.

---

## 4. Silence is a visible state

The failure this guards against: a cashier reading "no payments" off a screen
when the truth is that nothing is being read at all.

`getStatus()` reports `configured`, `folderPresent`, `lastPolledAt`,
`lastPaymentAt`, `quiet`, and `error`. `quiet` means nothing new for 15 minutes,
measured from the last payment or from start-up if there has not been one.

`describeInboxHealth(status)` turns that into one sentence, or `null` when
payments are arriving and there is nothing worth saying:

| State | What the cashier reads |
|---|---|
| not configured | "M-Pesa payments by message have not been set up on this till yet. Ask an administrator to finish the setup." |
| folder unreadable | "This till cannot read M-Pesa payment messages right now. The message reader may not be running. Payments cannot be confirmed until it is fixed." |
| quiet | "No M-Pesa message has come in for a while. If a customer has paid and nothing appears here, check that the payment phone or modem is switched on and has signal." |

A test asserts none of these leak a folder path, a service name, or an error
code. The quiet message deliberately does not claim a fault: a dead modem and a
quiet shop look identical from here, so it reports the silence and lets the
person decide.

---

## 5. Verify with the real modem

Unit tests prove the rules. They prove nothing about a modem.

| # | Item | Why it cannot be settled here | Consequence if wrong |
|---|---|---|---|
| 1 | **Does a multipart message land as one file or several?** | never observed on this hardware | none — both handled; this confirms which |
| 2 | **Do all parts share a timestamp and sender?** | the grouping assumption | parts land as separate messages, all fail to parse, payment not offered (safe, visible) |
| 3 | **Is 10 seconds enough between parts?** | depends on the network | a late part is missed, payment not offered (safe, visible) |
| 4 | **What encoding does gammu actually write?** | depends on `InboxFormat` and the message | garbled text, parse fails, payment not offered (safe) |
| 5 | **The exact file naming this install produces** | depends on gammu's version and config | non-matching names become one message each, which is correct for single-file messages |
| 6 | **The notification SIM is the one in the modem** | physical | nothing arrives at all, and every symptom looks like a software fault |

**How to settle 1-5 in one go:** send one real M-Pesa payment to the SIM and
copy the raw inbox files out of the folder untouched. That is sample #7 from
audit §3, and it is worth getting before Part 3 finalises the parser — it can
change the reader, where the other samples only tune a regex.

Every failure mode in that table ends in "payment not offered". That is the gate
working: **ambiguous means not paid.**

---

## 6. Tests

```
tests/gammuInbox.test.ts        16   grouping, ordering, joining, decoding
tests/mpesaSmsInbox.test.ts     14   polling, settle window, idempotence, health
tests/mpesaSmsMessages.test.ts  12   the UNIQUE constraint, on real SQLite
```

The three the brief asked for, and what each actually pins:

- **Reassembly joins multi-file parts** — two- and three-part messages join in
  part order regardless of listing order; a single-file message goes through the
  same path; two payments a minute apart stay separate; only the trailing line
  break is stripped.
- **A partial or young file is retried, not junked** — a half-written file
  records nothing on the first pass, then stores correctly once its remainder
  arrives inside the settle window. A settled non-payment is ignored once and
  not re-read.
- **Re-reading the folder inserts each code once** — three polls, one insert
  attempt; and separately, a fresh reader over the same folder (the restart
  case) makes a second attempt that the database refuses.

```
npx vitest run     79 files, 1182 tests, 0 failures   (was 76 / 1140)
npm run typecheck  node + web, exit 0
```

---

## 7. Still open

Nothing in this part is wired into the running app yet — the reader is
constructed by nobody until Part 4 adds the factory and the config field. That
is deliberate: an unconfigured till should not gain a polling timer for a folder
it does not have.

Stopping here for review, per the brief.
