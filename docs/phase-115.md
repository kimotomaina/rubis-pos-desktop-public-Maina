# Phase 115 — Sending `keepPortOpen=0` from our own code, logged, and tested against the device

Parts 2–4 of the brief whose Part 1 audit is [phase-114.md](phase-114.md).
Run against the **old** server build now installed on this till
(`servVer 1.8.2`, `defVer 2204120945`). Password redacted as `***`
throughout.

`npm test` 84 files / **1290 tests** passing (was 1286). `npm run
typecheck` clean, node and web.

## The verdict, up front

| Question | Answer |
|---|---|
| Did our app send `keepPortOpen=0`? | **Yes** — logged verbatim, §3 |
| Did the server honour it? | **Yes** — echoed `0`, `/clients` confirmed `false` |
| **Did it change anything about the device?** | **No. Nothing at all.** §4 |

`ReadStatus` against the real device returned **byte-identical results
with the flag off and on** — same code, same message, same timing to
7 ms. The server stores the field; the device does not care.

---

## 1. What changed in the code

Two functions in
[http-client.ts](../src/main/services/integrations/http-client.ts), both
behind one clearly-named seam, **default off**:

```ts
export const KEEP_PORT_OPEN_ZERO_ENV = 'FISCAL_SEND_KEEP_PORT_OPEN_ZERO'
export function shouldSendKeepPortOpenZero(env = process.env): boolean

export function buildSettingsCommand(
  deviceIp, devicePort, password,
  sendKeepPortOpenZero: boolean = shouldSendKeepPortOpenZero()
): string
```

Flag **off** (the default, and the shipped behaviour):

```
settings(ip=…,port=…,password=…,tcp=1)
```

Flag **on** (`FISCAL_SEND_KEEP_PORT_OPEN_ZERO=true`):

```
settings(ip=…,port=…,password=…,tcp=1,keepPortOpen=0)
```

An environment variable rather than an edited constant, mirroring the
existing `FISCAL_DEBUG_LOGGING` pattern: the experiment is runnable
without touching source, and the shipped default stays the vendor's TCP
form that every other test covers. Nothing else about the command shape
changed — a test asserts exactly that by reconstructing the flag-on string
from the flag-off one.

Four unit tests were added (`tests/http-client.test.ts`): the flag-on
string shape, that nothing else changes, that the default is off, and that
the env flag only reads an exact `true`.

---

## 2. The logging

When — and only when — the experiment is on, `getSettings` logs three
lines at INFO, ungated by `debugLogging`:

1. `SENT:` the exact URL, verbatim including `keepPortOpen=0`, password
   redacted by the existing `redactPassword`.
2. `RAW RESPONSE:` the unparsed body, verbatim, with `<password>` redacted
   by a new `redactPasswordElement` — the server echoes the device
   password in cleartext, so any verbatim log has to strip it.
3. `VERDICT:` the derived comparison — requested vs echoed, HONOURED or
   IGNORED.

Getting the *raw* body required one small change: `sendGet` now takes an
optional `onRaw` callback, since it otherwise returns only the parsed
field map. When the experiment is off, no callback is passed and the
function behaves exactly as before.

**The verdict line deliberately carries its own caveat**, because a bare
"HONOURED" is the false positive this phase was most at risk of
manufacturing:

```
VERDICT: requested=0, echoed=0 -> HONOURED (the server stored the field;
settings() never contacts the device, so this says nothing about TCP
session behaviour)
```

---

## 3. The proof — exact command and full echo

Run through the **real app code path** (`createFiscalHttpClient` →
`getSettings` → `postXml`), not a hand-rolled request:

```
[rubis-pos][keepPortOpen] SENT: GET http://localhost:4444/settings(ip=154.79.253.237,port=8000,password=***,tcp=1,keepPortOpen=0)

[rubis-pos][keepPortOpen] RAW RESPONSE: <Res Code="0">
  <settings>
    <com></com>
    <baud>115200</baud>
    <keepPortOpen>0</keepPortOpen>        ← requested 0, echoed 0
    <tcp>1</tcp>
    <ip>154.79.253.237</ip>
    <port>8000</port>
    <password>***</password>
    <defVer>2204120945</defVer>
    <servVer>1.8.2</servVer>
    <clientID>Localhost</clientID>
  </settings>
</Res>

[rubis-pos][keepPortOpen] VERDICT: requested=0, echoed=0 -> HONOURED
```

Corroborated independently by `/clients`, which reports the stored record
rather than an echo of our own request:

```xml
<keepPortOpen>false</keepPortOpen>     ← was true
<keepPortOpenAlways>false</keepPortOpenAlways>
<PortIsOpen>false</PortIsOpen>
```

**So: the server accepted, stored, and reported back `keepPortOpen=0` on a
`tcp=1` string.** Not ignored. That settles the question the brief was
most worried about — and it confirms
[phase-113.md](phase-113.md) from the application's own code path rather
than a script, while standing as the correction to
[phase-112.md](phase-112.md), which had predicted the server would ignore
it.

---

## 4. The part that actually matters: does it change anything?

A stored field is not a behaviour. So the same run did a real `ReadStatus`
— which *does* contact the device — **twice**, once either side of the
change, with nothing else different:

| | `keepPortOpen` | `ReadStatus` result | Time |
|---|---|---|---|
| **Baseline** | `1` (shipped default) | `Code 31` — `Missing password authentication answer` | **4313 ms** |
| **Experiment** | `0` (honoured, §3) | `Code 31` — `Missing password authentication answer` | **4306 ms** |

**Identical.** Same code, same message text, same failure mode, and the
same ~4.3 s timeout to within 7 ms. `PortIsOpen` stayed `false` on both
sides.

Those numbers also match [phase-109.md](phase-109.md) §2's old-server
measurements exactly (*"always ~4.3 s, always Code 31"*), so this is the
device's established behaviour, unmoved. And per
[phase-109.md](phase-109.md) §3, that particular message is provably
password-independent — it is a timeout at the auth step, not a rejected
password.

> **`keepPortOpen=0` changed nothing about how the device behaves.** The
> server honoured the request and stored the value; the connection to the
> device behaved exactly as it did before. This is the measurement
> `settings()` alone could never provide, and it is the answer to Ezra's
> suggestion.

---

## 5. Restore, and a hazard worth knowing

The server-side value is **sticky**: omitting the parameter does not clear
it. Re-sending our normal settings string leaves it at `0` — confirmed in
[phase-113.md](phase-113.md) §3a and relied on here.

So the experiment was explicitly undone:

```
GET /settings(…,tcp=1,keepPortOpen=1)   → <keepPortOpen>1</keepPortOpen>
GET /clients                            → <keepPortOpen>true</keepPortOpen>
                                          <PortIsOpen>false</PortIsOpen>
```

**Restored and verified.**

**The hazard, stated plainly:** turning the code flag back off reverts
*what this app sends*, but **not** the server's stored state. "Revert the
flag" and "undo the experiment" are two different actions. Anyone who
enables `FISCAL_SEND_KEEP_PORT_OPEN_ZERO=true` must run the explicit
`keepPortOpen=1` call above to undo it. This is documented on
`shouldSendKeepPortOpenZero` itself so the next reader meets it at the
flag, not in a phase doc.

---

## 6. Recommendation

**Leave the flag off. It does nothing useful.**

The chain is complete and each link is measured rather than argued:

1. `keepPortOpen` is a **serial-only** parameter in every vendor artefact,
   and absent entirely from the old SDK we are running
   ([phase-114.md](phase-114.md) §1).
2. Serial is **physically impossible** here — no COM ports on this till,
   and the device is on a routable public IP across a WAN
   ([phase-114.md](phase-114.md) §2).
3. The server nonetheless **accepts and stores** it on a TCP string
   (§3) — so anyone testing it will see what looks like success.
4. **It changes nothing about the device** (§4). That is the measurement
   that matters, and it is negative.
5. It is **sticky**, so using it leaves persistent server state that
   nothing in our code reads or manages (§5).

Ezra's suggestion has now been tried exactly as he described, from our own
application, against our own server build, with the wire evidence logged
in both directions. It is not the answer to `0x60`.

**The open lead is unchanged and is not in our code.** Per
[phase-113.md](phase-113.md) §4a: Ezra's own reference payload points at
`154.79.253.237:8000` — *the same device* — and his setup works. The single
highest-value next step is still one question to him rather than any code
change: **close your connection to that device and tell us when**, and we
watch whether `0x60` clears. `PortIsOpen: false` on our side, now observed
across two phases, says the holder is not us.

---

## 7. What was changed

| File | Change |
|---|---|
| `http-client.ts` | `KEEP_PORT_OPEN_ZERO_ENV`, `shouldSendKeepPortOpenZero`, optional 4th arg on `buildSettingsCommand`, the three experiment log lines, `redactPasswordElement`, optional `onRaw` on `sendGet` |
| `tests/http-client.test.ts` | 4 tests for the flag-on string shape and the env gate |

**Default behaviour is unchanged** — with the flag off, the settings
string, the logging and `sendGet` are byte-for-byte what they were, which
is what the other 1286 tests cover.

**Comment hygiene:** everything added is JSDoc, with `@param`/`@returns`;
the "why" for the experiment (serial-only provenance, storage-is-not-
effect, and the stickiness hazard) lives in `shouldSendKeepPortOpenZero`'s
JSDoc rather than as inline chatter. No useless comments were found in the
touched files to remove.

**Temporary artefacts:** the Part 4 probe ran from a throwaway
`tmp-keepportopen-probe.ts` at the repo root, which imported the real
`http-client.ts` and was **deleted immediately after the run**. No fixture
was written and no other file touched.

**ZFPLabServer:** our client's stored settings record was written four
times across the run and left at `keepPortOpen: true`, `tcp: true`, with
the same ip/port/password it already had (§5).
