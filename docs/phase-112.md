# Phase 112 — AUDIT: can we set `keepPortOpen=0` on the TCP `settings()` call, and would it help?

Read-only. **Nothing was changed** — no source, no test, no fixture, no
config, and no request was sent to the ZFPLabServer or the device.

Short answer: **no, and no.** `keepPortOpen` is not a parameter of the TCP
connection in any vendor artefact — client, server template, or manual —
and even if it were, it governs *our* connection's persistence, not the
session someone else is holding. It is not a lead on `0x60`.

[phase-97.md](phase-97.md) §3.4 reached the same conclusion from
`fp_core.js` alone. This phase re-derives it independently and adds five
confirmations that phase did not have, so the question can be closed
rather than re-asked.

---

## 1. Is it settable on TCP? **No.**

### 1a. The vendor JS client — the two settings paths side by side

`ZFP_SDK_KE_2509041522_ControlUnit/Libs/JS/fp_core.js`:

```js
:384  * @param {boolean} keepPortOpen Keeps serial port open. For Bluetooth connection - not used.
:386  this.ServerSetDeviceSerialSettings = function (serialPort, baudRate, keepPortOpen) {
:389      sendReq("GET", "settings(com=" + serialPort + ",baud=" + baudRate
                        + ",keepPortOpen=" + (keepPortOpen ? "1" : "0") + ",tcp=0)", null);

:407  this.ServerSetDeviceTcpSettings = function (ipaddress, tcpport, password) {
:410      sendReq("GET", "settings(ip=" + ipaddress + ",port=" + tcpport
                        + (password ? (",password=" + password) : "") + ",tcp=1)", null);
```

The TCP function **does not accept `keepPortOpen` as a parameter at all**
— it is a three-argument function — and its settings string has no such
field. The vendor's own doc comment on the serial one calls it *"Keeps
**serial port** open."*

### 1b. Four independent confirmations

The JS omission could in principle be a quirk of one client. It is not:

| Source | Evidence |
|---|---|
| **The server's own command template** — `Libs/FileServer/_Settings.xml` | The canonical `settings` arg list is exactly six: `com`, `baud`, `tcp`, `ip`, `port`, `password`. **`keepPortOpen` is not among them**, for either transport. |
| **C# core** — `Libs/C#/FPcore.XML` | Public signature `ServerSetDeviceTcpSettings(System.String, System.Int32, System.String)` — ip, port, password. And the serial one is `ServerSetDeviceSerialPortSettings(System.String, System.Int32)` — **no `keepPortOpen` even there**. |
| **Python lib** — `Libs/PY/FP_core.py:284` | `settings(ip=…,port=…,tcp=1[,password=…])`. Its serial setter (`:266`) is `settings(com=…,baud=…,tcp=0)` — again no `keepPortOpen`. |
| **The older SDK** (`API Files/`, defVer 2204120945) | The string `keepPortOpen` **does not appear anywhere in that entire tree** — not in `FP.cs`, `FP.java`, `FP.vb`, or any demo. |

Across three languages and two SDK generations, `keepPortOpen` is emitted
by exactly one function: the **JS serial** setter. It is a serial-port
concept, and in the current SDK a vestigial one — two of the three
libraries have dropped it from the serial setter too.

### 1c. So why is it in our response?

Because `settings()` echoes the server's **whole** device-settings record,
both transports at once, not just the fields you set. Our real capture
[tests/fixtures/wire/settings-ok.xml](../tests/fixtures/wire/settings-ok.xml):

```xml
<settings><com></com><baud>0</baud><keepPortOpen>1</keepPortOpen>
          <tcp>1</tcp><ip>154.79.253.236</ip><port>8000</port>…</settings>
```

Note the ordering and the values: `com` is **empty** and `baud` is **0** —
the serial fields are present but inert, because this is a TCP connection.
`keepPortOpen` sits between them, *before* `<tcp>`, inside that same
serial block. It is a reported default from the serial half of a record
we are only using the TCP half of.

`fp_core.js:326-341` (`ServerGetDeviceSettings`) reads all of them back
into one `DeviceSettings` object for the same reason — it is a getter over
the whole record.

---

## 2. What the documentation says: **nothing at all**

Both PDFs were extracted to text in full and searched.

| Document | Pages | `keepPortOpen` hits |
|---|---|---|
| `protocol_description_KE_CU_2509041522.pdf` | 61 | **0** |
| `Manual.pdf` (ZFPLabServer manual) | 34 | **0** |

The extraction is sound, not silently empty — the same text yields 73 hits
for "TCP", 87 for "password", 24 for "ZFPLabServer".

Two things worth recording from what the docs *do* say:

- **The protocol PDF documents no `settings(...)` call whatsoever.** It
  describes the device command protocol (the `0xNN` commands) only. The
  HTTP `settings()` interface is a **ZFPLabServer** feature and belongs to
  the Manual. So there was never going to be an answer in the protocol PDF
  — worth stating, since the brief named that document.
- **Manual §4 (HTTP API), p.29** gives the authoritative HTTP form:
  ```
  TCP:    http://localhost:4444/Settings(tcp=1,ip=10.10.10.113,port=8000,password=123456)
  Serial: http://localhost:4444/Settings(tcp=0,com=COM3,baud=115200)
  ```
  No `keepPortOpen` on **either**. Manual §5.2.1 (p.31) says the same in
  prose: *"Serial port – complete `com` and `baud` value. TCP/IP –
  complete `IP`, `port` and `password` value."*

---

## 3. What our code sends

[http-client.ts:214-221](../src/main/services/integrations/http-client.ts#L214):

```ts
export function buildSettingsCommand(deviceIp, devicePort, password): string {
  const passwordSegment = password ? `,password=${password}` : ''
  return `settings(ip=${deviceIp},port=${devicePort}${passwordSegment},tcp=1)`
}
```

Sent as an absolute GET from `getSettings`
([:255](../src/main/services/integrations/http-client.ts#L255)).

**We send no `keepPortOpen`** — confirmed, and correct: this is
byte-for-byte the vendor's TCP form from `fp_core.js:410`, including the
"omit `password=` entirely when blank" detail.

On the read side, `parseXmlResponse` flattens the echo, so
`keepPortOpen` *is* present in `result.data` — but **nothing in
`src/` ever reads it.** A repo-wide grep finds it only in the captured
fixture and in phase docs. It is inert in both directions.

---

## 4. What `keepPortOpen=0` would do, if it applied

Per the only two places the vendor defines it — `fp_core.js:384`
(*"Keeps serial port open"*) and `:746` (*"Keeps the port opened"*) — it
controls whether the server **holds the port handle open between
commands** or opens and closes it around each one.

That is a meaningful distinction for a serial port, which is an exclusive
OS handle: holding `COM3` open locks out every other process on the
machine, so releasing it between commands is how two applications share
one cable.

It has no defined behaviour for a TCP connection in any vendor artefact.
Any statement about what `keepPortOpen=0` "would do over TCP" is therefore
speculation, and this report will not make one.

---

## 5. Relevance to `0x60` — **none, and it is important not to over-hope**

The reasoning, plainly:

`keepPortOpen` — in the only sense the vendor defines it — governs **how
long our own side holds its connection**. The `0x60` condition is that the
device's single session is held by **somebody else**. Those are different
objects. A setting that makes *us* release promptly cannot make *another
party* release.

And the established facts make it worse than merely unrelated:

- **We hold no connection to release.** [phase-97.md](phase-97.md) §3.5
  and [phase-106.md](phase-106.md) §3: this machine has no TCP socket to
  the device, and `ZFPLabServer.exe` owns none either. There is nothing
  for `keepPortOpen=0` to close.
- **The device answers the probe as busy regardless of us.**
  [phase-109.md](phase-109.md) §2 logged `0x60` on both addresses across
  eight minutes, interleaved with runs where we were not connected at all.
- **Both server versions fail identically** ([phase-109.md](phase-109.md)),
  so this is not a server-side connection-handling setting either way.

There is exactly one scenario in which it would matter: a strict
take-turns device where **every** client must release promptly, and we
were one of the offenders. We are demonstrably not an offender — we hold
nothing. So even in that scenario, changing our setting would make us
well-behaved without changing the outcome, because the party actually
holding the session is not us and would have to release on its own.

**Conclusion: `keepPortOpen` is not a lead on `0x60`.** The open question
is unchanged and still the only one that matters — *what holds the session
on these units?*

### 5a. The release primitives that DO exist for TCP

For completeness, since "can we make the server drop a connection?" is the
real question underneath: the vendor exposes this through `clientremove`,
not `keepPortOpen` (`fp_core.js:455/482/496`):

| Call | Effect |
|---|---|
| `clientremove(who=me)` | Releases **this** client's session. We already call it, on app shutdown ([http-client.ts:300](../src/main/services/integrations/http-client.ts#L300)). |
| `clientremove(ip=X)` | Removes another client **by IP**. |
| `clientremove(who=all)` | Removes **all** clients. |
| `clients` (GET) | Lists each registered client with a `PortIsOpen` flag. |

These act only on clients registered with **our** ZFPLabServer. The `0x60`
holder is not one of them, so none of these reaches it either — but
`clients` is a genuine diagnostic, and it is the call that would prove or
disprove "some other client of our own server is holding it" in one hop.

---

## 6. Risks, if it were settable

Recorded for completeness, though §1 makes them moot:

1. **Per-command reconnect cost.** Closing between commands means a fresh
   TCP connect plus the device's ping/password handshake on every
   command. The old server's handshake alone timed out at ~4.3 s
   ([phase-109.md](phase-109.md) §2); a 7-command sale would pay that
   repeatedly. Our request timeout is **5 s**
   (`ETIMS_REQUEST_TIMEOUT_MS`), so a reconnect-per-command shape could
   push ordinary commands past it and turn healthy sales into timeouts.
2. **It fights our session caching.** `ensureSettings` deliberately runs
   the handshake at most once per session and caches the promise;
   `clientremove` is deliberately *not* called per sale, precisely to
   avoid a fresh handshake per transaction. `keepPortOpen=0` would be the
   opposite policy, applied invisibly. The vendor agrees with our current
   design — Manual §2 (p.13): *"It is enough to set settings only once —
   on application start."*
3. **Unknown server-side semantics.** Passing an argument the documented
   six-field list does not contain risks the server rejecting the whole
   `settings()` string. Since `settings()` is hop 1, a rejection there
   takes out *every* sale, not one.
4. **Silent no-op.** The likeliest outcome is that the server ignores the
   unknown parameter and still echoes `<keepPortOpen>1</keepPortOpen>` —
   leaving a misleading "we tried setting it" note in the code and no
   behaviour change.

---

## Recommendation: **not worth trying. Close the question.**

It is not settable over TCP — established from four independent vendor
sources across three languages and two SDK generations, plus the absence
of any mention in 95 pages of documentation. Even granting it were, it
governs our own connection's persistence, and the session blocking us is
held by another party, while we hold no connection at all. The upside is
zero by construction; the downside (risks 1–3) is real.

**If someone still wants an empirical answer**, there is one cheap, honest
test available *without* a working device, because `settings()` never
touches the device — it only stores parameters and returns in under 100 ms
([phase-109.md](phase-109.md) §2). A single scratchpad GET of
`settings(ip=…,port=…,password=…,tcp=1,keepPortOpen=0)` would show
immediately whether the server accepts the extra parameter and whether the
echo changes to `0`. Two caveats: it **rewrites this client's stored
settings on the server** (recoverable by re-sending our normal
`settings()`), and a `Code 0` would prove only that the server *tolerated*
the parameter, not that it changed any TCP behaviour.

**The better use of that effort is the `0x60` question itself** — and
§5a's `clients` call is the one unexplored hop that could still say
something about it.
