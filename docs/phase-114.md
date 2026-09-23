# Phase 114 — Part 1 (AUDIT): is the serial-port parameter usable for our connection at all?

Read-only. **No code, test, fixture or config changed.** One `GET /clients`
was sent to read the server's current state; nothing was written.

Answering the brief's Part 1 before touching `buildSettingsCommand`.

---

## 1. `keepPortOpen` is serial-only in every vendor artefact — re-verified

Re-derived from source this phase, not cited from
[phase-112.md](phase-112.md):

**`Libs/JS/fp_core.js` — all four occurrences, complete:**

```
:336  portOpen = Boolean(Number(response.getElementsByTagName("keepPortOpen")…))   ← a READ
:341  var fps = { … keepPortOpen: portOpen };                                      ← a READ
:384   * @param {boolean} keepPortOpen Keeps serial port open. …
:386  this.ServerSetDeviceSerialSettings = function (serialPort, baudRate, keepPortOpen) {
:389      sendReq("GET", "settings(com=" + serialPort + ",baud=" + baudRate
                          + ",keepPortOpen=" + (keepPortOpen ? "1" : "0") + ",tcp=0)", null);
:746   * @property {boolean} keepPortOpen Keeps the port opened
```

Exactly **one** place writes it, and it is the `tcp=0` string. The TCP
setter, verbatim:

```
:407  this.ServerSetDeviceTcpSettings = function (ipaddress, tcpport, password) {
:410      sendReq("GET", "settings(ip=" + ipaddress + ",port=" + tcpport
                          + (password ? (",password=" + password) : "") + ",tcp=1)", null);
```

Three arguments. No `keepPortOpen` in the signature or the string.

**`Libs/FileServer/_Settings.xml`** — the server's own canonical `settings`
arg list — is six args: `com`, `baud`, `tcp`, `ip`, `port`, `password`.
`keepPortOpen` is absent.

**Manual §4 (p.29)** gives `Settings(tcp=1,ip=…,port=…,password=…)` and
`Settings(tcp=0,com=COM3,baud=115200)`; **§5.2.1 (p.31)** says *"Serial
port – complete `com` and `baud`. TCP/IP – complete `IP`, `port` and
`password`."* Neither mentions it.

**And in the old SDK — the build we are actually running — the string
`keepPortOpen` appears ZERO times anywhere in the tree.** Not in `FP.cs`,
`FP.java`, `FP.vb`, or any demo. The client library for the server on this
machine has no concept of it at all.

**Confirmed: `keepPortOpen` belongs to the serial string only.**

---

## 2. Can we use serial for this device? **No — it is physically impossible**

This is the question that settles it, and the answer is not a matter of
configuration.

**This machine has no serial ports whatsoever:**

```
[System.IO.Ports.SerialPort]::GetPortNames()  →  NONE
Get-CimInstance Win32_SerialPort              →  (no rows)
```

**And the device is not local hardware — it is across a WAN:**

```
Device                : 154.79.253.237:8000   (public IP, not RFC1918)
This machine's IPv4   : 192.168.8.52, 192.168.56.1, 172.30.144.1, 169.254.x.x, 127.0.0.1
```

The device is on a **routable public address**, on none of this machine's
local networks. A COM port is a cable to a device in the same room. There
is no cable, no port to plug it into, and the device is not in the room —
it is somewhere on the internet.

So `tcp=0` is not an option to be weighed. Choosing it would mean telling
the server to look for the device on a serial port that does not exist,
which would simply fail to connect at all. **Serial is not a path to
anything here.**

**Therefore `keepPortOpen` has no documented, legitimate home for this
connection.** Its only sanctioned home is the serial string, and the serial
string is unusable for a network device.

---

## 3. Is there ANY legitimate way `keepPortOpen=0` takes effect for us?

**No documented one. But the picture is not as clean as "it will be
ignored", and the brief's premise needs correcting before Part 2 runs.**

Three distinct questions, which must not be collapsed:

| Question | Answer | Basis |
|---|---|---|
| Is it a documented TCP parameter? | **No** | §1 — every vendor artefact |
| Does the server *accept and store* it on a `tcp=1` string? | **Yes** | **Measured**, [phase-113.md](phase-113.md) §3 |
| Does the stored value *change TCP session behaviour*? | **Unknown** | No vendor definition; never tested against a live device |

### 3a. The brief's false-positive warning is inverted

The brief says:

> *"The audit predicts the likely outcome is the server SILENTLY IGNORING
> an unknown keepPortOpen parameter on a TCP string and still echoing
> keepPortOpen=1."*

**That prediction has already been tested and it is wrong.**
[phase-113.md](phase-113.md) sent precisely this call from a scratchpad
script against this same old server:

```
GET /settings(ip=154.79.253.237,port=8000,password=***,tcp=1,keepPortOpen=0)
→ <Res Code="0"> … <keepPortOpen>0</keepPortOpen> …        ← was 1
GET /clients  →  <keepPortOpen>true</keepPortOpen> → false  ← confirmed independently
```

The server honoured it. That also corrected
[phase-112.md](phase-112.md), which had made the same prediction from the
documentation alone. The server is more permissive than its own documented
surface.

**So the failure mode to guard against has flipped.** The risk is no
longer "the echo says 1 and we misread it as success". It is:

> **the echo says `0`, and we read that as "it worked".**

It does not mean that. It means the server wrote a field into its settings
record. `settings()` never contacts the device — it returned in 4 ms and
`PortIsOpen` stayed `false` throughout. A changed echo is proof of
**storage**, not of **effect**.

Part 3's verdict line must therefore say `HONOURED` in the narrow sense of
*"the server stored what we asked"* — and the report must not let that
stand in for *"the TCP connection now behaves differently"*, which remains
unmeasured and, per §1, undefined by the vendor.

### 3b. A real hazard for Part 2: the parameter is STICKY

[phase-113.md](phase-113.md) §3a found that **omitting the parameter does
not clear it.** After setting `0`, re-sending our normal settings string
(which has no `keepPortOpen`) left the stored value at `0`. Only an
explicit `keepPortOpen=1` restored it.

This matters for how Part 2 is built. A flag in `buildSettingsCommand` is
trivially reversible **in code**, but flipping it back to off will **not**
restore the server's state — the server keeps `0` until something
explicitly sets `1`. "Revert the flag" and "undo the experiment" are two
different actions, and the second one needs its own call.

I will build the flag so the off path stays byte-for-byte the current,
tested-safe string (as the brief requires), and document the explicit
one-line restore separately rather than pretending the flag covers it.

---

## 4. Starting state, for the record

Read immediately before this report, unchanged since
[phase-113.md](phase-113.md)'s restore:

```xml
<servVer>1.8.2</servVer>  <defVer>2204120945</defVer>   ← the OLD build, as the brief wants
<keepPortOpen>true</keepPortOpen>   <keepPortOpenAlways>false</keepPortOpenAlways>
<tcp>true</tcp>  <ip>154.79.253.237</ip>  <port>8000</port>
<PortIsOpen>false</PortIsOpen>
```

---

## 5. Answer to Part 1, in one paragraph

`keepPortOpen` is a **serial-only** parameter in every vendor artefact, and
it is absent entirely from the old SDK we are running. Serial is **not
available** for this device — this machine has no COM ports, and the device
sits on a public IP across a WAN, so a cable-based transport is physically
impossible, not merely unconfigured. There is therefore **no documented,
legitimate way for `keepPortOpen=0` to take effect on our TCP connection.**
The server will nonetheless accept and store it — that is measured, not
predicted — so the experiment will *look* like it worked. It will only
prove the server wrote a field.

---

## STOP — awaiting review

Part 1 says the parameter has no legitimate home for this connection, and
Part 2 will implement it anyway per Ezra's request, behind a clearly
labelled flag.

Given §3a, one thing is worth confirming before I write the code: the
outcome is already known from [phase-113.md](phase-113.md) — the server
will echo `0`. Part 2–4 will therefore prove *"our app can send it and we
logged the proof"*, not *"we discovered whether the server accepts it"*.
That is still worth doing if Ezra wants it demonstrated from the
application rather than a script — but if what he actually needs is
evidence the setting changes device behaviour, **no `settings()`-only test
can show that**, and the honest next step is `settings(…,keepPortOpen=0)`
followed by a real `ReadStatus` against the device.

Say which you want and I'll proceed.
