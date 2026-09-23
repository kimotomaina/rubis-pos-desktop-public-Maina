# Phase 109 — Does the OLD ZFPLabServer connect where the new one can't?

[phase-104.md](phase-104.md) §2a and the audit preceding this phase both
*inferred*, from error codes alone, that the old server's "Missing password
authentication answer" and the new server's Code 19 are the same held-session
condition wearing two different sentences. Inference is not measurement. This
phase installs the old server, runs it against the device, and settles it.

**Result: the old server does not connect either.** Five runs across eight
minutes, both addresses: it never once read device status. The inference
holds, and two controls now make it a measurement rather than a reading of
tea leaves.

Date: 2026-09-12, 20:26–20:34 (+03:00). Device password redacted as `***`
throughout. No app code changed.

---

## 0. Two version facts that invalidate earlier claims

**Package version is not binary version.** The installer filename and its
Add/Remove Programs entry describe the *package*; the server inside reports
something else entirely.

| Installer | ProductVersion | Installs `ZFPLabServer.exe` | Reports `servVer` | Ships defs |
|---|---|---|---|---|
| `API Files/…/ZFPLabServerSetup.exe` | 1.7.7 | **1.8.2.0** | `1.8.2` | **2204120945** |
| `ZFP_SDK_KE_2509041522_ControlUnit/…/ZFPLabServerSetup.exe` | 1.8.8 | **1.9.6.0** | `1.9.6` | **2509041522** |

Two consequences:

- The install on this machine registers as *"ZFPLabServer version 1.8.8"* and
  its binary is 1.9.6.0. **It came from the new SDK bundle.** The preceding
  audit's claim that it "came from neither folder" was wrong.
- The 1.7.7 package shipping defs `2204120945` was previously an inference
  from the bundle it sits in. It is now **read directly** from the installed
  `XML\_ServerStartupSettings.xml`, and confirmed on the wire.

That second point closes out the correction this phase's predecessor opened:
`defVer` is the **server's** definitions stamp. Running the old server makes
`settings()` report `defVer=2204120945` against the same device that reports
`2509041522` under the new one. The device has no say in it and never did.

---

## 1. Running the old server without disturbing the installed one

Both installers carry `requestedExecutionLevel level="asInvoker"` (Inno Setup
5.5.6), so neither needs elevation and neither has to land in Program Files:

```
ZFPLabServerSetup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /NOICONS /DIR="<target>"
```

Only one server can hold port 4444, so the two are swapped by stopping one
process and starting the other. **Which one is live is readable without the
GUI** — `GET http://localhost:4444/clients` returns both stamps:

```
<defVer>2204120945</defVer>
<servVer>1.8.2</servVer>
```

That is the check to use. The GUI Control tab says the same thing but cannot
be read programmatically.

> **The ZFPLabServer keeps no log file in either version.** Re-verified for
> 1.8.2: nothing appeared in its install directory, `%LOCALAPPDATA%` or
> `%APPDATA%` during any run. The Log tab is GUI-only, as
> [phase-106.md](phase-106.md) §3 found for 1.9.6. So the ping/pong sequence
> is not obtainable from the server — it is read from the device instead,
> with the §1.3 byte probe, which is better evidence anyway.

---

## 2. The measurement

`settings()` then a real command, exactly the two hops the app makes.

### New server (1.9.6 / 2509041522) — control, same session

```
>>> GET settings(ip=154.79.253.237,port=8000,password=***,tcp=1)
<<< [94 ms] <Res Code="0"> … <defVer>2509041522</defVer><servVer>1.9.6</servVer>
>>> POST <Command Name="ReadStatus" />
<<< [459 ms] <Res Code="19">
  <Err Source="Server" Type="ServUndefined">
    <Message>The Fiscal Printer has open socket. FP refuses new socket connection.
Internal error</Message>
```

Identical on `197.254.24.244`, and for `ReadVersion`.

### Old server (1.8.2 / 2204120945)

```
>>> GET settings(ip=154.79.253.237,port=8000,password=***,tcp=1)
<<< [101 ms] <Res Code="0"> … <defVer>2204120945</defVer><servVer>1.8.2</servVer>
>>> POST <Command Name="ReadStatus" />
<<< [4450 ms] <Res Code="31">
  <Err Source="Server" Type="ServTCPAuth">
    <Message>Missing password authentication answer </Message>
```

Five runs, 20:26:46 → 20:33:43, both addresses, `ReadStatus` and `ReadVersion`
— **every one identical**, always ~4.3 s, always Code 31. **No status field
was returned at any point.**

`settings()` returning `Code 0` in under 100 ms proves nothing: it only stores
parameters. That is why the pairing matters, and it is the same `Code 0` /
failure pairing [phase-104.md](phase-104.md) §2 recorded.

### The `0x09` probe, interleaved with those runs

```
20:27:29  154.79.253.237 -> 0x60     197.254.24.244 -> 0x60
20:29:40  154.79.253.237 -> 0x60     197.254.24.244 -> 0x60
20:31:04  154.79.253.237 -> 0x60     197.254.24.244 -> 0x60
20:32:28  154.79.253.237 -> 0x60     197.254.24.244 -> 0x60
20:33:52  154.79.253.237 -> 0x60     197.254.24.244 -> 0x60
```

Busy throughout, in the same minutes the old server was blaming the password.

---

## 3. Control 1 — the message is indifferent to the password

The single most useful result here. Same server, same address, three
passwords:

| Password sent | Response | Time |
|---|---|---|
| correct (the vault's `password`) | Code 31 "Missing password authentication answer" | 4350 ms |
| garbage (`zzzWRONGzzz`) | Code 31 "Missing password authentication answer" | 4347 ms |
| **empty** | Code 31 "Missing password authentication answer" | 4360 ms |

Byte-identical text, same timing, whether the password is right, wrong, or
not sent at all. **That sentence carries no information about password
correctness.** It is a timeout at the auth step, nothing more.

Anyone reading "Missing password authentication answer" as *"the device
rejected your password"* — as [phase-97.md](phase-97.md) §5 did, and as the
brief for this phase reasonably did — is reading something the message does
not say.

## 4. Control 2 — the device *is* answering the ping

Three targets, same old server, to find out what each failure mode actually
looks like:

| Target | Verdict | Time |
|---|---|---|
| Closed port (`127.0.0.1:9998`) | Code **30** `ServSockConnectionFailed` — "Socket connect FAILED" | 2.06 s |
| Accepts TCP, never speaks (`127.0.0.1:9999`) | Code **31** — "**Missing first ping answer**" | 4.28 s |
| Real device (answering `0x60`) | Code **31** — "**Missing password authentication answer**" | 4.30 s |

The device does not behave like the silent peer. It answers the ping — with
`0x60` — the old server accepts that as an answer and advances to the password
step, and there the refusing device says nothing further.

So the old server *does* get one mechanical step further than the new one.
That step buys nothing: both end with no session and no status.

This also sharpens [phase-104.md](phase-104.md) §2a's table, which had only
two rows because only two behaviours had been seen. The third is now filled
in, and the distinguishing factor is the server version, not the device:

| Device behaviour | Old server (1.8.2) | New server (1.9.6) |
|---|---|---|
| No TCP listener | Code 30 `Socket connect FAILED` | Code 30 |
| Accepts, never speaks | Code 31 `Missing first ping answer` | — |
| Answers `0x09` with `0x60` | Code 31 `Missing password authentication answer` | Code 19 `FP refuses new socket connection` |

## 5. Still not this machine

No socket from this till to either address during the runs — only a
`TimeWait` remnant of our own probe. Consistent with
[phase-106.md](phase-106.md) §3.

---

## What this does and does not confirm

**Confirmed:**

- **The old server establishes no session with this device.** Five runs, two
  addresses, zero status reads.
- **The server version is not the fix.** Both versions fail; only the wording
  differs, and the old version's wording is the misleading one.
- The old server's Code 31 is password-independent — proven by the empty and
  garbage password controls, not inferred.
- `defVer` is the server's definitions stamp, demonstrated by swapping servers
  against one unchanged device.

**Not settled, and not settled here:**

- **Who holds the session.** Unchanged, and still the only question that
  matters.
- Whether Ezra supplied the older SDK for a reason. Nothing here suggests the
  device needs it — but nothing here rules out some other reason either.
- Whether the two addresses are one physical unit.

---

## Verdict

> The old ZFPLabServer does not connect where the new one cannot. It reaches
> one step further into the handshake and then times out, and the sentence it
> prints on the way out names the password while being provably indifferent
> to it. Both servers are looking at the same device, refusing the same
> socket, for the same reason. The supplier question is unchanged: **what
> holds the open socket on these units?**

---

## Post-connection caveats — moot, but recorded

None of this applies, since the old server never connected. Had it worked,
from its own installed defs (91 commands against the new set's 122):

- **`ReadCUinvoiceNumber` does not exist in 2204120945.** The duplicate
  `TraderSystemInvNum` recovery in `real-etims-provider.ts:843-850` would
  break, weakening retry dedupe — Rule 1, never file twice
  ([phase-75.md](phase-75.md)).
- Narrower decimals: `Price` 10 vs 15, `ReadCurrentReceiptInfo` VAT subtotals
  11 vs 13, `Subtotal`'s `SubtotalValue` 10 vs 13.
- `SellPLUfromExtDB` accepts VAT classes A–E where the new defs accept only A.
  `resolveSellCommand`'s A/non-A routing is stricter than the old protocol
  requires, so it is safe either way.
- **`ReadStatus` bit positions are identical** in both — `CU_fiscalized`
  byte 3 bit 5, `Paired_with_TIMS` byte 4 bit 0. Our parsing needs no change
  for either server.

---

## One operational hazard worth knowing

**The two installers share an Inno Setup AppId** (`{CB9F1586-F565-4F69-BD99-8F7CE733FB9A}_is1`).
Installing the old one — even to a different directory — rewrites the
machine-wide `Run` key and the Add/Remove Programs entry to point at the new
location, and uninstalling it then **deletes both**, leaving the untouched
Program Files install with no autostart entry and no Add/Remove Programs
record. The files themselves are not harmed.

That happened here. Restoring both needs an **elevated** shell; the cleanest
fix is to re-run the good installer:

```
"…\ZFP_SDK_KE_2509041522_ControlUnit\ZFPLabServerWindows\ZFPLabServerSetup.exe"
```

or, for the autostart alone:

```powershell
Set-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run' `
  -Name ZFPLabServer -Value '"C:\Program Files (x86)\ZFPLabServer\ZFPLabServer.exe"'
```

**Anyone repeating this experiment should expect it.** Run the old server on a
spare machine, or accept the registry repair afterwards.

---

## What was changed

**App:** nothing. No source edit, no config row, no fixture, no test. The
provider was never involved — every request in this phase went to
`localhost:4444` from a scratchpad script, which is also the point: the app's
code path is identical regardless of which server is installed.

**Machine:**

- Old server installed to the scratchpad, run, then uninstalled. Gone.
- Program Files install verified intact afterwards — 253 files (matching the
  pre-test backup), `ZFPLabServer.exe 1.9.6.0`, defs `2509041522`, running and
  answering on 4444.
- **Not restored:** the `Run` autostart value and the Add/Remove Programs
  entry, per the hazard above. Both need elevation.
- Backup of the original install and a registry snapshot were taken to the
  scratchpad before any of it.

**Note for any capture shared onward:** the `settings()` response echoes the
device password in cleartext inside `<password>`. Strip it before it reaches
a ticket or a supplier — the same warning [phase-106.md](phase-106.md) §2
gives.
