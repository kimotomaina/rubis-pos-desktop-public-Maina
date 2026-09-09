# Phase 106 — New device address 197.254.24.244:8000, connected and tested

**Verdict: busy-with-another-connection.** The new address is live and the
device answers, but it reports its session is held by another connection.
Not fixed. No code changed.

> **Correction — see [phase-107.md](phase-107.md) §2.** §3's claim that the
> old address "answers nothing" and is therefore a demonstrably different
> box is **withdrawn**. On a re-run 17 minutes later the old address
> answered `0x60` in 264 ms; its silence here was transient. The `0x60`
> verdict itself is unchanged and was confirmed twice.

---

## 1. The config change

One row, through the app's own `integrations` config — no source edit, no
hardcoded address anywhere.

| Field | Before | After |
|---|---|---|
| `deviceIp` | `154.79.253.237` | **`197.254.24.244`** |
| `devicePort` | `8000` | `8000` (unchanged) |
| `baseUrl` | `http://localhost:4444/` | unchanged |
| password | vault (`RUBIS POS` / `etims-device-password`) | **not touched** |

Verified after writing: `baseUrl` identical, and the row still carries no
`password` key — the secret stayed in the vault where phase-89 put it.

### It applies without a rebuild, and without a restart

`integrations:set-config` calls `applyEtimsConfigToProvider()`
(`main/index.ts:669-687`), which re-reads the row and calls
`provider.reconfigure(...)`. That setter clears both cached sessions:

```ts
this.settingsPromise = null
this.cuNumbersPromise = null
```
— `real-etims-provider.ts:652-653`

So saving from Admin re-points the live provider and drops any handshake
held against the old address. **No restart needed.** (The app happened to
be closed for this test, so it will read the new row at startup anyway.)

---

## 2. What the new address actually does

### 2.1 TCP reachability — both endpoints, before anything else

```
197.254.24.244:8000   TcpTestSucceeded = True    PingSucceeded = False (ICMP blocked, normal)
localhost:4444        TcpTestSucceeded = True    (ZFPLabServer running, PID 6012)
```

### 2.2 The two-call probe, production's exact wire shape

Replayed with production's own request shape — `Content-Type: text/plain`,
no `Accept` header, 5000 ms timeout (`http-client.ts:48,59`), body
`<Command Name="ReadStatus"/>` (`xml-utils.ts:79`). Read-only: no receipt
opened, nothing written.

```
=== PROBE START 2026-09-08T17:03:38.756Z ===
config: baseUrl=http://localhost:4444/ deviceIp=197.254.24.244 devicePort=8000
safeStorage available: true
password from vault: present (8 chars) <redacted>

[17:03:38.795Z] GET /log(on=1) -> HTTP 200: <Res Code="0" />

[17:03:38.795Z] GET /settings(ip=197.254.24.244,port=8000,password=<redacted>,tcp=1)
  HTTP 200 in 2ms
  RESPONSE (verbatim):
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

[17:03:38.797Z] POST / body: <Command Name="ReadStatus"/>
  HTTP 200 in 261ms
  RESPONSE (verbatim):
<Res Code="19">
  <Err Source="Server" Type="ServUndefined">
    <Message>The Fiscal Printer has open socket. FP refuses new socket connection.
Internal error</Message>
  </Err>
  <Stacktrace>0</Stacktrace>
</Res>

=== PROBE END 2026-09-08T17:03:39.058Z ===
```

**`settings()` Code 0 proves nothing**, exactly as the brief warned — it
returned in **2 ms**, which is the server storing parameters, not reaching
Nairobi. It does confirm the server took the new IP: the echo reads back
`197.254.24.244`. `defVer` `2509041522` still matches
`EXPECTED_DEF_VERSION`, and `servVer` is `1.9.6`.

`ReadStatus` came back in **261 ms** — a fast refusal, not a timeout. The
device is there and answering.

> **The server echoes the device password in clear text** in its
> `settings()` response. Redacted above. Anything pasted into a supplier
> ticket or a log must have that element stripped first. (What is actually
> stored is the literal default `password` — see phase-107 §4.)

---

## 3. The decisive evidence: the ping byte itself

**The ZFPLabServer keeps no log file.** `log(on=1)` was accepted
(`<Res Code="0" />`), but nothing appears on disk — not under the install
directory, not in `%LOCALAPPDATA%\ZFPLabServer` (empty), not anywhere
written in the last two hours. Its log is the GUI tab only, which cannot be
read programmatically. *(Logging was left enabled; turn it off with
`GET http://localhost:4444/log(on=0)`.)*

So the byte was read **from the device directly**, using the protocol's own
read-only status probes — protocol PDF §1.3, the table confirmed in
[phase-104.md](phase-104.md). These send no command and open no receipt.

```
=== SINGLE-BYTE STATUS PROBE (PDF §1.3) 2026-09-08T17:05:13.328Z ===

--- NEW address: 197.254.24.244:8000 ---
[17:05:20.349Z] send 0x04 -> NO PONG within read window in 7019ms | pong: (none)
[17:05:21.423Z] send 0x09 -> PONG in 1073ms                       | pong: 0x60

--- OLD address: 154.79.253.237:8000 ---
[17:05:29.426Z] send 0x04 -> TIMEOUT (no pong) in 8002ms | pong: (none)
[17:05:37.431Z] send 0x09 -> TIMEOUT (no pong) in 8004ms | pong: (none)
```

**`0x60`, straight from the device.** Per §1.3:

> `60   CU is already busy with another connection (LAN or WiFi connection only)`

What this settles:

1. **It is not `0x70`**, so this is not a wrong password for the new unit.
2. **It is not `0x40`**, so the device is not ready either.

> The third conclusion originally recorded here — that the old address's
> silence proved the two endpoints are different boxes — is **withdrawn**;
> see phase-107 §2. The old address answers `0x60` too.

The `0x04` probe getting no pong while `0x09` answers is consistent rather
than contradictory: the device will state its connection-ownership to a
stranger, but will not report its status to one.

### Who holds the session — not this till

```
Get-NetTCPConnection -RemotePort 8000   ->  (no rows)
```

The query is sound: it returns 152 connections overall and does show the
`:4444` listener. **There is no socket from this machine to any device on
port 8000** — ZFPLabServer included. Whatever owns the device's session is
somewhere else: another till, the supplier's own system, or a session the
device has not released.

---

## 4. The app's three-hop result

Produced by running the real mapping code
(`fiscal-connection-test.ts`) against the captured Code 19, rather than
paraphrasing it:

```
ok       : false
failedAt : device
message  : The fiscal device did not answer because it still has a session open
           from an earlier connection. Wait a minute and try again, and if it
           keeps happening switch the device off and on.

  - Fiscal server on this till : PASS
  - Fiscal device answering    : FAIL
  - Device ready to file       : not attempted
```

Hop 3 is correctly left unattempted — `CU_fiscalized` and
`Paired_with_TIMS` were **never read**, so this phase reports no value for
either. The device never got far enough to say.

---

## 5. Verdict

> **Busy with another connection.** The device at 197.254.24.244:8000 is
> reachable and answering, and it reports — in its own status byte, `0x60` —
> that its single session is held by another connection. It is not a wrong
> password, not an unreachable address, and not a dead unit. Nothing on this
> till holds that session.

**What the password is for this unit remains unknown.** `0x60` means the
exchange never reached password validation — `0x50` (awaiting password) and
`0x70` (wrong password) are the states that would tell us. It cannot be
confirmed until the device is free.

---

## 6. Two follow-ups, deliberately not acted on

1. **The Code-19 message is misleading in this case.** It says *"it still
   has a session open from an earlier connection"* and advises waiting and
   power-cycling — wording that points at our own leftover socket. The
   evidence says the holder is not on this machine, so that advice sends a
   branch manager to power-cycle a device that is busy with someone else.
   Changing it is a code change and out of scope here.
2. **`keepPortOpen` is `1`** in the settings echo. Not implicated — there is
   no socket from this machine at all — but it is the setting that would
   make this till the culprit if one ever appeared.

---

## 7. What was and wasn't touched

- **Changed:** the `etims` integrations row — `deviceIp` only.
- **Changed on the server:** logging enabled (`log(on=1)`).
- **Not changed:** wire code, provider code, fiscalization code, the vault
  password, `baseUrl`, any fixture, any test. Both probe scripts ran from
  the scratchpad and were removed; the only source diff from this session is
  phase-105's version bump.

**Stopping for review.** The next action is external: ask the supplier what
holds the session on 197.254.24.244:8000, quoting §1.3 and the `0x60` pong
above.
