# Phase 108 — Control experiment: is the `0x60` reading real?

Phases 106 and 107 rest on one measurement — a `0x60` byte returned to a
`0x09` probe. This phase tries to break that measurement three ways before
anyone quotes it to a supplier. Read-only: one TCP connect and at most one
byte per target.

**Result: the reading survives all three controls.** `0x60` is a genuine,
specific response from the device at 197.254.24.244:8000.

---

## The three ways it could have been wrong

| # | Failure mode being tested for | How it was tested |
|---|---|---|
| A | `0x60` is an unsolicited **greeting** on connect, not an answer | connect and send **nothing** |
| B | The box answers **any** byte with `0x60` | send `0x04`, `0xAA`, `0x00`, `0x0E` |
| C | Something in the **network path** answers `0x60` for everything | wrong ports, subnet neighbours, unrelated public IPs |

---

## A. Not a greeting — nothing arrives unless asked

```
[02:22:59.305Z] new addr, send nothing   197.254.24.244:8000  connect 29ms  no data in window  got (none)
[02:23:03.348Z] old addr, send nothing   154.79.253.237:8000  connect 37ms  no data in window  got (none)
```

Both addresses accept the TCP connection and then stay **silent** for the
full 4-second window. So `0x60` is not something the device volunteers on
connect — it is emitted only in response to a query. The connection itself
is not what produces it.

## B. Specific to `0x09` — every other byte is ignored

```
[02:23:03.414Z] byte 0x09   197.254.24.244:8000   DATA                got 0x60
[02:23:07.440Z] byte 0x04   197.254.24.244:8000   no data in window   got (none)
[02:23:11.468Z] byte 0xaa   197.254.24.244:8000   no data in window   got (none)
[02:23:15.506Z] byte 0x00   197.254.24.244:8000   no data in window   got (none)
[02:23:19.534Z] byte 0x0e   197.254.24.244:8000   no data in window   got (none)
```

`0x09` is answered. `0xAA` and `0x00` — bytes with no meaning in this
protocol — are ignored, as is `0x0E` (the `RETRY` byte, which is a
CU→client message and correctly draws nothing in this direction).

This is the strongest single result here. The far end is not an echo
service, not a generic responder, and not noise: it selectively recognises
exactly one of the two query bytes defined in protocol PDF §1.3 and ignores
everything else. **That behaviour is itself evidence we are talking to a
real Tremol CU speaking the documented protocol.**

`0x04` drawing no answer is now confirmed across all three runs (phase-106,
107, and here). Per §1.3 a healthy CU answers `04` with `04`/`40`/`41`, so
its silence is consistent with the `0x60` state: the device will state its
connection ownership to a stranger, but will not report status to one.

## C. Specific to this host and port — the network is not answering

```
--- wrong port, same host ---
197.254.24.244:8001    CONNECT TIMEOUT
197.254.24.244:9100    CONNECT TIMEOUT

--- subnet neighbours ---
197.254.24.243:8000    CONNECT TIMEOUT
197.254.24.245:8000    CONNECT TIMEOUT

--- unrelated public IPs on :8000 (randomised control) ---
8.8.8.8:8000           CONNECT TIMEOUT
1.1.1.1:8000           CONNECT TIMEOUT
203.0.113.7:8000       CONNECT TIMEOUT
198.51.100.23:8000     CONNECT TIMEOUT
196.201.214.200:8000   CONNECT TIMEOUT
```

Nine controls, nine failures to even establish a connection — while
`197.254.24.244:8000` connects in **22–37 ms** every time.

This rules out the interception hypotheses: there is no captive portal, no
ISP middlebox and no NAT device answering `0x60` on behalf of whatever is
behind it. If something in the path were manufacturing the byte, the
neighbours and the random hosts would have produced it too. They produce
nothing at all.

---

## What this does and does not confirm

**Confirmed:**

- `0x60` is a real response, to a real query, from a real listener at
  `197.254.24.244:8000` that implements the §1.3 protocol.
- The phase-106/107 verdict — **busy with another connection** — stands, now
  on three independent readings plus this control set.

**Still not settled, and not settled by this experiment:**

- **Who holds the session.** Still not this machine (phase-106 §3).
- **Whether 154.79.253.237 and 197.254.24.244 are the same physical unit.**
  Control A shows both accept connections and both stay silent unprompted;
  phase-107 shows both answer `0x60`. Nothing here distinguishes them.
- **The device password.** `0x60` still means the exchange never reaches
  password validation, and what is stored on this till is the literal
  default `password` (phase-107 §4).

---

## Verdict

> The `0x60` measurement is sound. It is not a greeting, not a generic
> response to any byte, and not a network artifact — the device recognises
> the documented query byte specifically and answers it with the documented
> "already busy with another connection" code. The supplier question is
> unchanged and now better supported: **what holds the session on
> 197.254.24.244:8000?**

## Not touched

No config change, no code change, no fixture, no test. The control script
ran from the scratchpad. ZFP server logging is still enabled from phase-106
(`GET http://localhost:4444/log(on=0)` turns it off).
