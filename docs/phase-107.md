# Phase 107 — Re-test of 197.254.24.244:8000, and a correction to phase-106

The config from [phase-106.md](phase-106.md) is still in place and was not
re-entered. This is a second run of the same read-only probes ~17 minutes
later, because `0x60` is a *time-varying* state and one reading is not a
result.

**Verdict: unchanged — busy-with-another-connection.**

But one of phase-106's supporting claims did not survive the re-run, and
that matters more than the verdict.

---

## 1. Config, re-verified before probing

```
{"baseUrl":"http://localhost:4444/","deviceIp":"197.254.24.244","devicePort":"8000"}
password key present (must be false): false
```

Unchanged from phase-106. Nothing re-entered, nothing re-saved.

---

## 2. The correction: the old address is alive, and it is also `0x60`

Phase-106 §3 recorded the old address as answering nothing on either probe,
and concluded from that:

> *"The new address is a genuinely different, live endpoint. The old one now
> answers nothing on either probe… This is not the same box responding on a
> new route."*

**That conclusion is withdrawn.** On the re-run the old address answered, in
264 ms, with the same byte:

```
=== SINGLE-BYTE STATUS PROBE (PDF §1.3) 2026-09-08T17:20:24.588Z ===

--- NEW address: 197.254.24.244:8000 ---
[17:20:30.676Z] send 0x04 -> NO PONG within read window in 6085ms | pong: (none)
[17:20:30.918Z] send 0x09 -> PONG in 242ms                        | pong: 0x60

--- OLD address: 154.79.253.237:8000 ---
[17:20:37.020Z] send 0x04 -> NO PONG within read window in 6101ms | pong: (none)
[17:20:37.292Z] send 0x09 -> PONG in 264ms                        | pong: 0x60
```

Side by side with the first run:

| Target | 17:05 run | 17:20 run |
|---|---|---|
| NEW `197.254.24.244` `0x09` | `0x60` (1073 ms) | `0x60` (242 ms) |
| NEW `197.254.24.244` `0x04` | no pong | no pong |
| OLD `154.79.253.237` `0x09` | **timeout, 8004 ms** | **`0x60` (264 ms)** |
| OLD `154.79.253.237` `0x04` | timeout, 8002 ms | no pong |

The old address's silence at 17:05 was **transient**, not a decommissioned
endpoint. So the evidence no longer supports "these are demonstrably
different boxes" — both addresses are reachable and both report the same
single-session contention. Whether they are two units in the same state or
one unit on two routes is **not settled by this data**, and phase-106 should
not have claimed it was.

What does still hold from phase-106: the byte is `0x60`, it is not `0x70`
(so not a wrong password), and it is not `0x40` (so not ready).

The `0x04` probe again drew no pong from either address while `0x09`
answered promptly on both — the same asymmetry as before, and consistent
with a device that will state connection-ownership to a stranger but will
not report status to one.

---

## 3. The HTTP two-call probe, re-run

```
=== PROBE START 2026-09-08T17:21:12.273Z ===
config: baseUrl=http://localhost:4444/ deviceIp=197.254.24.244 devicePort=8000
password from vault: present (8 chars) <redacted>

[17:21:12.292Z] GET /settings(ip=197.254.24.244,port=8000,password=<redacted>,tcp=1)
  HTTP 200 in 28ms
<Res Code="0">
  <settings>
    <com></com>
    <baud>0</baud>
    <keepPortOpen>1</keepPortOpen>
    <tcp>1</tcp>
    <ip>197.254.24.244</ip>
    <port>8000</port>
    <password>&lt;REDACTED&gt;</password>
    <defVer>2509041522</defVer>
    <servVer>1.9.6</servVer>
    <clientID>Localhost</clientID>
  </settings>
</Res>

[17:21:12.321Z] POST / body: <Command Name="ReadStatus"/>
  HTTP 200 in 273ms
<Res Code="19">
  <Err Source="Server" Type="ServUndefined">
    <Message>The Fiscal Printer has open socket. FP refuses new socket connection.
Internal error</Message>
  </Err>
  <Stacktrace>0</Stacktrace>
</Res>

=== PROBE END 2026-09-08T17:21:12.594Z ===
```

Identical to phase-106: `settings()` Code 0 (28 ms — parameter storage, not
a device round trip), `ReadStatus` Code 19 in 273 ms. The app's three-hop
result is therefore unchanged and is not re-derived here — see
[phase-106.md](phase-106.md) §4: server **PASS**, device **FAIL**, ready
**not attempted**. `CU_fiscalized` and `Paired_with_TIMS` still unread.

Sockets from this machine to port 8000: **still none** (142 connections
enumerated overall, so the query is live). The session holder remains
somewhere other than this till.

---

## 4. A finding that surfaced from the redaction

This run redacted by replacing every occurrence of the password string in
the output. It replaced the `<password>` **element name** as well — which
can only happen if the stored device password *is* the literal 8-character
string `password`.

That is a default, not a per-unit credential. It has two consequences:

- It is almost certainly not this unit's real TCP password, so a `0x70`
  (wrong password) is a likely **second** failure waiting behind the current
  `0x60` — the exchange never reaches password validation today, so it is
  untested either way.
- It should be treated as a credential to replace, not to keep. Related to
  phase-90's blocker 2 (`DEFAULT_DEVICE_PASSWORD = 'Password'`), though what
  is actually stored here is lowercase.

**Ask the supplier for this unit's TCP password at the same time as asking
about the session** — otherwise clearing `0x60` just exposes `0x70` and
costs another round trip.

---

## 5. Verdict

> **Busy with another connection — confirmed twice, 17 minutes apart.** The
> device at 197.254.24.244:8000 answers and reports `0x60`: its single
> session is held elsewhere, not by this till. The previous address behaves
> identically now, so nothing distinguishes the two endpoints in the
> evidence.

Nothing about this is fixed, and nothing here is a breakthrough. No sale
should be attempted against this address.

## 6. What to take to the supplier

1. What holds the session on **197.254.24.244:8000** — quote protocol PDF
   §1.3 and the `0x60` pong, captured twice with timestamps.
2. Whether 154.79.253.237 and 197.254.24.244 are the **same physical unit**.
   Both now answer `0x60`; we cannot tell them apart from outside.
3. **This unit's real TCP password** (see §4).

## 7. What was and wasn't touched

- **Changed:** nothing. The config was already set in phase-106 and was only
  read back.
- **Not changed:** wire, provider, fiscalization code, the vault password,
  any fixture, any test. Probe scripts ran from the scratchpad and were
  removed.
- ZFP server logging is still enabled from phase-106; turn it off with
  `GET http://localhost:4444/log(on=0)`.

**Stopping for review.**
