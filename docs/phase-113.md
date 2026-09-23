# Phase 113 — Testing `keepPortOpen=0` on TCP, and diffing Ezra's reference payload

Date: 2026-09-14, ~12:10 (+03:00). Device password redacted as `***`
throughout. **No app source, test, fixture or config was changed.** The
only things sent were `settings()` and `clients` GETs to the local
ZFPLabServer, neither of which contacts the fiscal device.

Three results, in order of how much they matter:

1. **The same device that gives us `0x60` reportedly works for Ezra**, from
   his payload's own `ip`/`port`. That reframes the whole problem — §4.
2. **The server on this machine was replaced with the OLD one today**, at
   09:19. We are now running `1.8.2` / defs `2204120945` — §1.
3. `keepPortOpen=0` **is accepted and stored** over TCP, correcting
   [phase-112.md](phase-112.md)'s prediction — but it proves nothing about
   session behaviour, and it is **sticky** — §3.

---

## 1. First, a state change nobody recorded: we are on the OLD server

Before anything else, `/clients` reported `servVer 1.8.2` / `defVer
2204120945`. [phase-109.md](phase-109.md) ended with the Program Files
install *"verified intact afterwards — `ZFPLabServer.exe 1.9.6.0`, defs
`2509041522`"*. That is no longer true:

```
C:\Program Files (x86)\ZFPLabServer\ZFPLabServer.exe
  ProductVersion / FileVersion : 1.8.2.0
  XML\_ServerStartupSettings.xml : <GenerationTimeStamp>2204120945</GenerationTimeStamp>

Add/Remove Programs entry : "ZFPLabServer version 1.7.7"
  InstallLocation         : C:\Program Files (x86)\ZFPLabServer\
  unins000.exe written    : 2026-09-14 09:19:59   ← today
```

Package 1.7.7 → binary 1.8.2.0 → defs 2204120945 is exactly
[phase-109.md](phase-109.md) §0's row for the **old** `API Files`
installer. Someone installed it over the good one this morning, and
because both installers share an Inno Setup AppId
([phase-109.md](phase-109.md)'s "operational hazard"), it took the same
location and the same registry entries.

**Consequence:** this till is now driving the old definitions for real.
The both-versions work in [phase-111.md](phase-111.md) stopped being
hypothetical this morning — which is fortunate timing, but it should be a
deliberate choice, not an accident. Both installers are still on disk:

| Installer | Package | Gives |
|---|---|---|
| `API Files/ZFPLabServerWindows/…/ZFPLabServerSetup.exe` | 1.7.7 | 1.8.2 / 2204120945 ← **installed now** |
| `ZFP_SDK_KE_2509041522_ControlUnit/ZFPLabServerWindows/ZFPLabServerSetup.exe` | 1.8.8 | 1.9.6 / 2509041522 |

Neither produces Ezra's `1.9.3`.

---

## 2. Part 1 — Ezra's payload vs ours

| Field | **Ezra (working)** | Our live server, now | `settings-ok.xml` (committed) | phase-97/106 captures |
|---|---|---|---|---|
| `keepPortOpen` | **0** | 1 | 1 | 1 |
| `tcp` | 1 | 1 | 1 | 1 |
| `ip` | **154.79.253.237** | 154.79.253.237 | 154.79.253.236 | .237 / .244 |
| `port` | 8000 | 8000 | 8000 | 8000 |
| `password` | `Password` | `Password` | `Password` | (redacted by our own script) |
| **`defVer`** | **2212221540** | 2204120945 | *(blank)* | 2509041522 |
| **`servVer`** | **1.9.3** | 1.8.2 | 1.8.2 | 1.9.6 |
| `clientID` | Localhost | Localhost | Localhost | Localhost |

### 2a. `defVer 2212221540` — a third definitions version

Decoded on the same `YYMMDDHHMM` pattern as the other two, that is
**2022-12-22 15:40** — between the old set (2022-04-12) and the new one
(2025-09-04). We have never seen it, we do not have it on disk, and it is
not in either SDK bundle here.

This matters for the [phase-111.md](phase-111.md) work: this build now
supports `2509041522` and `2204120945` by name, and treats anything else —
including `2212221540` — as `'unknown'`. That path is deliberately
fail-safe (it probes, and flags rather than resends), so Ezra's build would
**work** rather than break, but it would run in the conservative mode
rather than a version-matched one.

### 2b. `servVer 1.9.3` — a server build we do not have

Between our two (1.8.2 and 1.9.6). **This is the most actionable artefact
to request from Ezra** — but see §4 before treating it as the fix:
[phase-109.md](phase-109.md) already established that server version alone
does not change `0x60` (1.8.2 and 1.9.6 failed identically, five runs, two
addresses).

### 2c. `password` — the premise in the brief is not borne out

The brief flags Ezra's capital-P `Password` as possibly differing from a
lowercase `password` we use. The evidence says there is **no discrepancy**:

- Our own committed real capture, `settings-ok.xml`: `<password>Password</password>`.
- The live server's stored record for our client, read today: the same value.

Both show capital-P `Password`, matching Ezra exactly. It is not a
placeholder in his example, and it is not a difference. (It is, separately,
a very weak password sitting in cleartext in every `settings()` echo — the
disclosure warning in [phase-109.md](phase-109.md) applies.)

### 2d. `keepPortOpen 0 vs 1` — see §3. Real, but the least consequential line in the table.

---

## 3. Part 2 — the empirical test: does the server accept `keepPortOpen=0`?

**Yes. It accepts it, stores it, and echoes it back.** One GET, sent from a
scratchpad script, not through the app:

```
GET /settings(ip=154.79.253.237,port=8000,password=***,tcp=1,keepPortOpen=0)
HTTP 200 in 4ms
<Res Code="0"><settings>
  <com></com><baud>115200</baud>
  <keepPortOpen>0</keepPortOpen>     ← was 1
  <tcp>1</tcp><ip>154.79.253.237</ip><port>8000</port><password>***</password>
  <defVer>2204120945</defVer><servVer>1.8.2</servVer><clientID>Localhost</clientID>
</settings></Res>
```

`/clients` agreed independently: `<keepPortOpen>true</keepPortOpen>` →
`false`.

**This corrects [phase-112.md](phase-112.md).** That audit predicted the
server would reject the string or silently ignore the parameter. It did
neither. phase-112 was right that `keepPortOpen` appears in no TCP client
path, no server command template and no page of documentation — but it was
wrong to infer from that that the server would not take it. The server is
more permissive than its own documented surface. That inference is
corrected here rather than left standing.

### 3a. It is STICKY — the restore the brief specified is not sufficient

Re-sending our **normal** settings string, which omits the parameter
entirely, did **not** put it back:

```
GET /settings(ip=154.79.253.237,port=8000,password=***,tcp=1)
<Res Code="0"> … <keepPortOpen>0</keepPortOpen> …     ← still 0
```

Omitting a parameter is not the same as clearing it. Only an explicit
`keepPortOpen=1` restored it — which was then done and verified:

```
GET /settings(…,tcp=1,keepPortOpen=1)      → <keepPortOpen>1</keepPortOpen>
GET /settings(…,tcp=1)   (normal form)     → <keepPortOpen>1</keepPortOpen>
GET /clients             (final state)     → <keepPortOpen>true</keepPortOpen>
                                             <PortIsOpen>false</PortIsOpen>
```

**Restore confirmed.** The record is back to `keepPortOpen: true` and is
otherwise exactly what the app itself writes on each launch.

> One field genuinely differs from the pre-test reading: `tcp` was `false`
> before the test and is `true` after. That is not damage — `tcp=1` is what
> our app's `settings()` sets every session. Before the test the record had
> never been put into TCP mode by anything since this morning's server
> install (`baud 115200`, `tcp false` are the serial defaults).

### 3b. What this does and does not prove

It proves the server **persists the flag**. It proves nothing about TCP
session behaviour, because `settings()` never contacts the device — it
returned in 4 ms and `PortIsOpen` stayed `false` throughout. There is still
no vendor definition of what `keepPortOpen` means for a TCP connection, so
what the server *does* with the stored `0` is unknown.

The only test that could answer that is `settings(…,keepPortOpen=0)`
followed by a real `ReadStatus` against the device. That was deliberately
**not** run — this task was scoped to `settings()` calls only.

---

## 4. Part 3 — the `clients` diagnostic, and what Ezra's payload implies

Every reading, before and after, showed exactly one registered client:

```xml
<Client>
  <Id></Id>
  <Last_Activity>2026-09-14T11:38:25+03:00</Last_Activity>
  <Settings>… <keepPortOpenAlways>false</keepPortOpenAlways> …</Settings>
  <PortIsOpen>false</PortIsOpen>
</Client>
```

**`PortIsOpen` is `false`, in all five readings.** Nothing registered with
our ZFPLabServer holds a port. This is the server's own view, which is the
gap `netstat` could not see, and it closes it: it corroborates
[phase-97.md](phase-97.md) §3.5 and [phase-106.md](phase-106.md) §3 from
the other side. **The `0x60` holder is definitively external to this
machine and this server.**

(Incidentally, `/clients` exposes a field the `settings()` echo does not:
`keepPortOpenAlways`. Not investigated — out of scope, and no vendor
definition exists for it either.)

### 4a. The most important line in Ezra's payload is not the version

His payload reads `ip=154.79.253.237, port=8000` — **the same physical
device we cannot reach.** And his setup works.

That is the first evidence we have that this device is not permanently
wedged. It answers *somebody*. Which makes the following a serious
hypothesis, stated as a hypothesis:

> **Ezra's own working connection may be the session that locks us out.**

It fits every fact: the device allows exactly one session; `0x60` says
that session is held by another party; our machine and our server hold
nothing; and we now know of a working client on that same device. It also
explains why swapping server versions changed nothing — the holder was
never on our side.

It is **not proven**. His payload is a settings echo, which is stored
parameters, not a live connection; he may have been connected at a
different time, or through a different route.

**The test is one question to Ezra, not a code change:** *close your
connection to `154.79.253.237` completely and tell us when.* If our `0x60`
clears in that window, the question that has been open since
[phase-97.md](phase-97.md) is answered.

---

## 5. Recommendation

**Is `keepPortOpen=0` doing anything? There is no evidence that it is.**
The server stores it; nothing shows it changes TCP behaviour, and the
vendor defines it only for serial ports. Do **not** put it in app code on
the strength of this:

- no defined TCP semantics in any vendor artefact (phase-112, unchanged);
- it is sticky, so setting it once silently changes the server's stored
  state for every later session — a real footgun for a value nothing in
  our code reads or manages;
- it cannot address `0x60` by construction, and §4 now shows *why* with
  the server's own `PortIsOpen: false`: we hold nothing to release.

**Is the real lead "get ZFP server 1.9.3 from Ezra"? Partly — but it is
the second-best lead.** Getting 1.9.3 / defs `2212221540` is worth doing:
it is the one concrete artefact separating his working setup from ours,
and this build already handles an unrecognized `defVer` safely. But temper
the expectation — [phase-109.md](phase-109.md) proved server version alone
does not clear `0x60`, so 1.9.3 is unlikely to be the fix by itself.

**The best lead is §4a**, and it costs one message rather than an install:
ask Ezra to drop his connection to `154.79.253.237` and watch whether our
`0x60` clears. If it does, everything since phase-97 resolves at once.

**Two smaller follow-ups worth a decision:**

1. **Decide which server we want installed.** It was downgraded to 1.8.2 by
   accident this morning (§1). Staying there is now viable — the old defs
   are supported ([phase-111.md](phase-111.md)) — but it should be chosen,
   and the choice recorded, rather than inherited from an installer
   overwriting another.
2. **If anyone still wants `keepPortOpen=0` tested properly**, the only
   meaningful version is `settings(…,keepPortOpen=0)` followed by a real
   `ReadStatus`. Cheap, but it contacts the device, so it was out of scope
   here.

---

## 6. What was changed

**App:** nothing. No source, test, fixture, config or database write. The
one database read was against a **copy** of `rubis-pos.db` taken to the
scratchpad.

**ZFPLabServer:** our client's stored settings record was written three
times (the test, then two restores) and left at `keepPortOpen: true`,
`tcp: true`, with the same ip/port/password it already had. Verified by a
final `/clients` read.

**Machine:** nothing. The 1.8.2 server install predates this phase (§1) and
was not touched.
