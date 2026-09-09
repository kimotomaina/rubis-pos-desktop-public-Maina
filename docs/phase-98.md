# Phase 98 — Test Connection: report the hop that actually broke

Reporting-layer fix. The Admin "Test Connection" button now names the
hop that failed and the specific reason, instead of collapsing every
device-end failure into one sentence that was, in the cases that
mattered, false.

**No wire change.** `settings()`, `ReadStatus`, fiscalization, resend and
the routing/classification of failed sales are all byte-for-byte what
they were. The test performs exactly the same two calls in the same
order; only the account it gives of the result changed.

---

## 1. What was wrong

`testConnection` sent **any** `readStatus()` failure to hop 3:

```ts
const status = await this.readStatus()
if (!status.success) {
  return connectionTestFailed('ready', describeNotReady(status.error))
}
```

and `describeNotReady` matched two substrings, falling through to:

> The fiscal device answered but is not ready to file sales. Contact the
> device supplier.

Three things were wrong with that, at once:

1. **The sentence was false.** Server codes 19 / 30 / 31 / 53 / 63 all
   mean the session never opened — the device answered *nothing*. The
   message asserted the opposite.
2. **It pointed at the wrong people.** "Contact the device supplier" reads
   as a KRA-provisioning problem. During the phase-97 live audit it sent
   the investigation after fiscalization and TIMS pairing while the
   actual fault was that nothing at `154.79.253.237:8000` answered the
   protocol's first ping.
3. **Hops 1 and 2 showed green ticks they had not earned**, because
   `buildHops` marks every hop before the failure as passed. A device
   that never answered displayed "Fiscal device answering ✓".

Underneath it, `mapFiscalServerError` had *already* computed an accurate,
actionable cause for each of those codes. It was discarded one function
call later.

---

## 2. The fix

### 2.1 Carry the cause instead of re-deriving it from text

Two additive optional fields on `DeviceResult`
([real-etims-provider.ts](../src/main/services/integrations/real-etims-provider.ts)):

| Field | Set where | Why |
|---|---|---|
| `serverFailure?: { code, message }` | `checkDeviceResponse`, wherever `errSource === 'Server'` | marks "this came from the fiscal server, so the device did not answer", and carries the raw `<Message>` that `parseXmlResponse` already captured but that the rewritten `error` string threw away |
| `notReady?: 'not-fiscalized' \| 'not-paired'` | `readStatus`'s two status-bit checks | a **typed** marker for the genuine hop-3 case, replacing substring-matching on the error text |

The typed `notReady` is the structural half of the fix. Matching words is
how the wrong hop got reported in the first place; a value set at the
point the bit is read cannot drift from what it describes.

### 2.2 One description function, not two

`describeSettingsFailure` and the server half of `describeNotReady` were
answering the same question — "why did the device not answer?" — with
different wording depending on which command hit the failure. They are
now one `describeDeviceNotAnswering(failure)` covering
19 / 30 / 31 / 32 / 34 / 53 / 63, with the existing already-approved
sentences kept verbatim for 30 / 32 / 34 and the default.

`describeNotReady(reason)` now takes the typed reason. A new
`STATUS_UNREADABLE_MESSAGE` covers the case the old code had no words
for: the device answered `ReadStatus` but rejected the command, so its
readiness is *unknown* rather than bad.

### 2.3 The Code-31 split

Code 31 is issued at two different stages and only the `<Message>`
separates them (phase-97 §5):

| `<Message>` | Stage | Now reported as |
|---|---|---|
| `Missing password authentication answer` | the password was refused | "The fiscal device refused the password. Check the fiscal device password above and save it again." |
| `Missing first ping answer` | the device never answered the initial ping, before any password | "The fiscal device did not respond to the connection. Check the device is switched on and reachable at the IP address and port above." |

**The match is on the password variant, not the first-ping one.** The
brief suggested keying on `"first ping"`, but that cannot satisfy the
fallback rule it states in the next paragraph: a Code 31 whose message is
empty, reworded or unrecognized must fall to the *connection* reading.
Matching `"first ping"` would send every unrecognized message to the
password branch — the exact wrong-way-round failure. Matching
`"password"` makes the password case the one that must be positively
proven, and everything else defaults to "the device did not answer",
which sends someone to the right place either way. The reasoning is in a
comment on `CODE_31_PASSWORD_FRAGMENT` so nobody quietly inverts it
later.

### 2.4 Four explicit branches in `testConnection`

```ts
const status = await this.readStatus()
if (status.success)      return connectionTestPassed()
if (status.notReady)     return connectionTestFailed('ready',  describeNotReady(status.notReady))
if (status.serverFailure)return connectionTestFailed('device', describeDeviceNotAnswering(status.serverFailure))
if (status.code === undefined)
                         return connectionTestFailed('server', SERVER_UNREACHABLE_MESSAGE)
return connectionTestFailed('ready', STATUS_UNREADABLE_MESSAGE)
```

Ordered so the genuine hop-3 case is claimed first and nothing falls
through to a catch-all. `notReady` is checked before `serverFailure`
because they are mutually exclusive by construction and the explicit
order documents which wins.

| Situation | Before | After |
|---|---|---|
| server codes 19/30/31/53/63 | hop 3, "device answered but not ready" | **hop 2**, the specific cause; hop 3 shown as not attempted |
| device answered, rejected `ReadStatus` | hop 3, same sentence | hop 3, "answered but could not report whether it is ready" |
| `CU_fiscalized=0` / `Paired_with_TIMS=0` | hop 3, correct | hop 3, unchanged — the one case "contact the device supplier" is right for |
| no `<Res>` at all | hop 3, same sentence | **hop 1**, "could not reach the fiscal server" — the rule the handshake branch already used |

### 2.5 What this device would say now

Re-running Test Connection against the phase-97 device, which returns
Code 19 / 30 / 31-first-ping:

> **Fiscal device answering — failed.** The fiscal device did not respond
> to the connection. Check the device is switched on and reachable at the
> IP address and port above.

With hop 3 shown as not attempted. That is what was true all along.

---

## 3. One change outside the connection test

`mapFiscalServerError`'s Code-31 **text** — the reason recorded against a
sale that could not be filed, shown on the Needs Attention list — asserted
the wrong-password stage too. It now names both possibilities:

> Fiscal device session could not be opened — either the device did not
> answer, or it rejected the TCP password. Check the device is powered on
> and reachable, and the device password in Admin → Integrations

This is message text only. The code's classification (`retryable: true`,
kind `technical`) is untouched, so routing, queueing and resend behave
identically. It is in scope because it is the same false claim in the
same investigation's path — the audit that misdirected phase-97 would
have read this string next.

The function's docblock now records that Code 31 covers two stages.

---

## 4. Confirming the hard constraint

**Reporting-only, verified rather than assumed.** Every consumer of
`DeviceResult` that drives a filing or routing decision reads only
`success` / `data` / `error` / `code` / `retryable`:

- `classifyDeviceFailure` takes `Pick<DeviceResult, 'error' | 'retryable' | 'code'>`
  — structurally incapable of seeing the new fields.
- `sendCommand`'s Code-53 recovery branches on `first.code` alone.
- `submitInvoice`'s steps 1-7 go through `classifyDeviceFailure`.
- No `DeviceResult` is ever spread wholesale into an outcome or a stored
  row (checked: there is no `...result` / `...statusResult` /
  `...settingsResult` anywhere in the provider), so the new fields cannot
  reach the database or the renderer by accident.

Both new fields are optional and read in exactly one place: the reporting
path in `testConnection`.

**THE FOUR RULES — untouched.** This is Admin diagnostics. It does not
touch checkout, the fiscalization sequence, the resend path, receipt
rendering, or the unfiled-count instrument. Nothing here can file a sale
twice (no filing code changed), print a valid-looking receipt for an
unfiled sale (no receipt code changed), lose an unfiled sale (no routing
or queue code changed), or block the till (the connection test is
manual, admin-only, and off the sale path entirely).

---

## 5. Tests

`tests/fiscalNotConfigured.test.ts` — 69 tests in the file, all passing.
Pure assertions on the reporting derivation, no device needed.

New coverage:

- **Hop attribution**, parameterised over 19 / 30 / 31-first-ping /
  31-password / 63: each reports `failedAt: 'device'` with hops
  `[true, false, undefined]` — hop 3 not attempted, never a fake pass.
- **Specific cause named**, same parameterisation: each message matches
  its own distinct phrase, so no two causes read alike.
- **Never claims the device answered**, same parameterisation: no message
  matches `/device answered/i` or `/contact the device supplier/i`.
- **The Code-31 split**: the two messages produce two different outcomes,
  the first-ping one says nothing about passwords, and an
  empty/unrecognized message produces the *connection* wording — the
  fallback rule pinned as a test, not just a comment.
- **Transport failure** (`ReadStatus` rejects with no envelope) → hop 1.
- **Device command error** (Code 40 / STE2) → hop 3 with
  `STATUS_UNREADABLE_MESSAGE`, hops `[true, true, false]` — hop 2 passed
  because the device genuinely answered.
- **Genuine hop 3 preserved**: `CU_fiscalized=0` and
  `Paired_with_TIMS=0` each still report hop 3 with the "contact the
  device supplier" guidance.
- **Two inverted assertions** in the plain-language sweep: "the device
  answered" appears in exactly the three messages where it is true, and
  "contact the device supplier" only where the device reported its own
  status.
- The existing plain-language sweep (no vendor names, no protocol codes,
  no config keys, finished sentences) extended to all nine new messages.

```
npx vitest run     76 files, 1140 tests, 0 failures
npm run typecheck  node + web, exit 0
```

---

## 6. Documentation corrected

- **`SDK_RECON.md` §6.3** — the row glossing Code 31 as *"Wrong device
  TCP password"* is the gloss that started the confusion. The vendor's
  quoted enum text is left verbatim (it is a quote), with a note beneath
  giving both messages, what each actually means, and the rule that
  anything acting on Code 31 must read the message and default to the
  connection reading.
- **`docs/phase-97.md`** — §7's "not fixed" and §10's step 5 now point
  here, and Appendix B's "note for a future revision" records the
  correction as made.

---

## 7. Not done, deliberately

- **Hop 2's meaning is still weaker than its label.** It reads "Fiscal
  device answering", but on the success path it is still only
  `settings()`, which stores parameters and proves nothing about the
  device. After this fix a *failure* is attributed correctly, but a hop-2
  **pass** still does not mean the device answered — `ReadStatus`
  succeeding at hop 3 is what proves that. Making hop 2 mean what it says
  would change what the test does, not how it reports, so it is outside
  this task's constraint. Worth a decision: either re-label hop 2, or
  fold hops 2 and 3 into one.
- **`describeSettingsFailure`'s old Code-31 wording** on the settings
  path is gone with the merge, but a Code 31 from `settings()` has never
  actually been observed — `settings()` returns Code 0 every time
  (phase-97 §3.8). The merged function handles it correctly if it ever
  appears.
