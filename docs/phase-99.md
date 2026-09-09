# Phase 99 — Second device address (`.236`) probed, and what the failure actually is

Read-only follow-up to `docs/phase-97.md`. The question was simple: the
old default in the code was `154.79.253.236`, the configured value is
`154.79.253.237` — does the other address work?

**It does not.** `.236` fails identically to `.237`. But the controls run
to establish that answered a bigger question phase-97 left open: **what
is actually wrong at the far end.**

**Scope and safety.** No code changed. No sale filed. Only `settings()`
and `ReadStatus` were sent, plus bare TCP connects with no bytes written.
The device password was decrypted from the app's own vault at run time
and redacted as `***` in all output. Date: 2026-09-07. ZFPLabServer 1.9.6
(PID 6012) on this till.

---

## Headline

Both addresses present **the same dead endpoint**: a TCP listener that
completes the handshake and then never services the connection. The
ZFP session cannot open against either, so `CU_fiscalized` and
`Paired_with_TIMS` remain **UNKNOWN**, exactly as in phase-97.

Switching the configured IP to `.236` would change nothing. Do not try
it as a fix.

---

## 1. `.236` answers exactly like `.237`

Raw TCP first, five probes each, interleaved:

```
154.79.253.236:8000  CONNECTED/34ms  CONNECTED/29ms  CONNECTED/29ms  CONNECTED/578ms  CONNECTED/54ms   5/5
154.79.253.237:8000  CONNECTED/32ms  CONNECTED/28ms  CONNECTED/41ms  CONNECTED/25ms   CONNECTED/33ms   5/5
```

Then the protocol, four rounds against `.236`:

```
=== 154.79.253.236:8000 — settings() + ReadStatus, 4 rounds ===
round 1: settings Code=0 | ReadStatus Code=19 ServUndefined "The Fiscal Printer has open socket. FP refuses new socket connection. Internal error"
round 2: settings Code=0 | ReadStatus Code=19 ServUndefined "..."
round 3: settings Code=0 | ReadStatus Code=19 ServUndefined "..."
round 4: settings Code=0 | ReadStatus Code=19 ServUndefined "..."
```

`settings()` echoes the new address back and still reports the SDK
version, so the server did accept the change:

```xml
<Res Code="0">
  <settings>
    <tcp>1</tcp>
    <ip>154.79.253.236</ip>
    <port>8000</port>
    <***>***</***>
    <defVer>2509041522</defVer>
    <servVer>1.9.6</servVer>
    <clientID>Localhost</clientID>
  </settings>
</Res>
```

Same codes, same messages, same `settings()` Code 0 as `.237`. No
`ReadStatus` has ever returned Code 0 from either address.

---

## 2. The control that phase-97 was missing

Phase-97 could not tell whether ZFPLabServer was genuinely reaching the
far end or failing before it. Pointing `settings()` at addresses where
nothing is listening settles it:

```
=== 192.0.2.1:8000  (TEST-NET-1, guaranteed dead) ===
round 1: settings Code=0 | ReadStatus Code=30 ServSockConnectionFailed "Socket connect FAILED"

=== 127.0.0.1:8000  (this machine, nothing on 8000) ===
round 1: settings Code=0 | ReadStatus Code=30 ServSockConnectionFailed "Socket connect FAILED"
```

**A server that cannot connect says Code 30.** So Code 19 from `.236`
and `.237` is not "could not connect" — the server *did* establish TCP,
and the session was refused afterwards. That narrows the fault from
"somewhere between here and there" to "after the TCP handshake, during
the ZFP protocol's opening exchange".

This also retires the worry, live since phase-97, that the codes might
be pure server-side noise. They are not: the server reports connect
failure distinctly, and it is not reporting it here.

---

## 3. A hypothesis I raised and then disproved

The `.236` probing suggested a self-inflicted cause: if the far end
allows only one session, then **our own** probes might be occupying it,
and "FP refuses new socket connection" would be the device refusing
*us because of us*. Phase-97 hammered this endpoint with dozens of
connects, so this was a real possibility and would have invalidated the
earlier conclusion.

Tested by going completely silent for two minutes — no TCP probes, no
`settings()`, nothing — and then sending exactly one `settings()` and one
`ReadStatus`:

```
154.79.253.236: staying silent for 120s (no probes of any kind)...
154.79.253.236: sending ONE settings() + ONE ReadStatus
settings  Code=0
<Res Code="19"><Err Source="Server" Type="ServUndefined">
  <Message>The Fiscal Printer has open socket. FP refuses new socket connection.
Internal error</Message></Err></Res>
```

```
154.79.253.237: staying silent for 120s (no probes of any kind)...
154.79.253.237: sending ONE settings() + ONE ReadStatus
settings  Code=0
<Res Code="19">... identical ...
```

**Not self-inflicted.** A completely quiet endpoint refuses the very
first request, on both addresses. Phase-97's conclusion survives.

---

## 4. What the endpoint actually does

Holding sockets open and counting, with no bytes ever written:

```
=== 154.79.253.236:8000 — concurrent socket test ===
A: CONNECTED in 32ms
B (while A held): CONNECTED in 45ms
C (while A+B held): ECONNREFUSED in 2240ms
A still open after 5s: true

=== 154.79.253.237:8000 — concurrent socket test ===
A: CONNECTED in 36ms
B (while A held): CONNECTED in 38ms
C (while A+B held): ECONNREFUSED in 2177ms
A still open after 5s: true
```

Both addresses: **two sockets accepted, the third refused after ~2.2
seconds**, held sockets never closed by the peer, and not one byte ever
sent unprompted.

That is the signature of a listener whose **accept queue fills and is
never drained** — the kernel or a NAT completes handshakes up to a
backlog of two, nothing ever picks them up, and the third connect is
reset. It explains every symptom seen across both phases in one stroke:

| Symptom | Explanation |
|---|---|
| TCP connects fine | the handshake is completed by the kernel/NAT, not by an application |
| `Missing first ping answer` (Code 31) | nothing ever reads the socket, so the opening ping is never answered |
| `FP has open socket` (Code 19) | queued, unserviced connections are still open, so the next attempt is refused |
| `ECONNREFUSED` after ~2.2s | the backlog is full, and the RST arrives after a SYN retransmit |
| `Socket connect FAILED` (Code 30) with the server stuck in `SynSent` | same full backlog, SYNs silently dropped instead of reset |

**This corrects a phase-97 loose end.** Appendix C item 2 there recorded
the single `SynSent` / Code 30 observation as "an observed intermittency,
not a diagnosis", because 15 direct probes had all succeeded. It now has
an explanation: whether a given connect succeeds, hangs, or is refused
depends only on how full the backlog happens to be at that instant. The
intermittency was real and it was never random.

It also explains the oddity captured live during this phase — the fiscal
server stuck in `SynSent` to `.236`:

```
20:44:41.227  8529->154.79.253.236  SynSent  ZFPLabServer
20:44:49.605  16948->154.79.253.236 SynSent  ZFPLabServer
20:44:57.541  51066->154.79.253.236 SynSent  ZFPLabServer
```

while plain Node connected to the same address on the same machine ten
times in a row, seconds apart. Not a firewall rule against ZFPLabServer
(phase-97 §3.11 ruled that out) and not a per-process block: just the
backlog, full at the moments the server tried.

---

## 5. Are `.236` and `.237` the same box?

Cannot be proven from here, but they are indistinguishable in every test
run:

```
              :80    :443   :4444  :8000            :8001  :8080  :9100
154.79.253.236 RST   drop   drop   RST (queue full) drop   drop   drop
154.79.253.237 RST   drop   drop   open (38ms)      drop   drop   drop
```

Both refuse `:80` outright — an active reset, so a live IP stack is
answering at both addresses, not a black hole. Everything except `:8000`
is silently dropped. Neither answers ICMP. The `:8000` difference in this
one run is timing, not configuration: `.236`'s backlog was still full
from the socket test immediately before it.

Same behaviour, same latencies, same refusal, same two-socket backlog on
both. Whether that is one device on two forwards or two identically
broken forwards, neither is usable.

---

## 6. The two flags

Unchanged from phase-97:

| Flag | Value | Raw attribute returned |
|---|---|---|
| **CU fiscalized** | **UNKNOWN** | none, on either address |
| **Paired with TIMS** | **UNKNOWN** | none, on either address |

Total across both phases: **19 `ReadStatus` attempts, zero Code 0.**

---

## 7. Verdict, sharpened

Phase-97 concluded: *"Something accepts TCP on `154.79.253.237:8000` but
does not answer the ZFP protocol's first ping."* That stands, and now has
a mechanism and a second address:

> **Both `154.79.253.236:8000` and `154.79.253.237:8000` complete the TCP
> handshake but never service the connection.** Sockets queue up
> unanswered until the backlog fills, after which further attempts are
> refused or dropped. No ZFP session can open, so no status bit can be
> read. This is an endpoint condition at the device end. It is not the
> password, not the address, and not this integration's wire handling.

The most likely cause moves up the phase-97 list: a **port-forward that
no longer lands on a running Control Unit**. The router completes the
handshake on the CU's behalf, or forwards to an address where nothing is
listening, and the connection dies there. A powered-on CU with its ZFP
service running would answer the first ping in milliseconds.

---

## 8. For the supplier

1. Neither public address works. Trying `.236` instead of `.237` is not
   a fix, and it has already been tested.
2. Ask them to confirm, at the device end, that `:8000` forwards to a
   **powered-on Control Unit with its ZFP service running** — not merely
   that the forward exists. The forward demonstrably exists; something
   answers. What is missing is the application behind it.
3. The useful diagnostic on their side: watch whether the CU registers an
   incoming session while we connect. We can connect on demand. If the CU
   sees nothing while our connect succeeds, the forward is landing
   somewhere else.
4. Confirm the CU's actual ZFP TCP port, and whether it restricts
   sessions by source IP.

Once any `ReadStatus` returns Code 0, re-read the two flags. That is
still the only thing that settles the original question.

---

## Appendix — Harness scripts

Session scratchpad, never in the repo. All read-only.

| Script | What it does |
|---|---|
| `tcp236.cjs` | bare TCP connects to both addresses, no bytes sent |
| `readstatus-236.cjs` | `settings()` + `ReadStatus` rounds against an IP given on the command line |
| `quiet-probe.cjs` | waits 120s in total silence, then sends exactly one `settings()` + one `ReadStatus` |
| `onesocket.cjs` | opens sockets A, B, C in sequence while holding the earlier ones |
| `concurrent.cjs` | raw connects on a timer, to run alongside a server-mediated attempt |
| `portscan236.cjs` | port fingerprint of both addresses, spaced to avoid filling the backlog |

The Electron ones run as:

```
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron <script>.cjs <ip>
```

and must call `app.setPath('userData', …)` **before** `whenReady`, or
`safeStorage` cannot decrypt the vault (Chromium reads its key from
`<userData>/Local State`).
