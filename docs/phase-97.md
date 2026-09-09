# Phase 97 — Live device audit: why "Test Connection" fails hop 3

Full audit record. Read-only investigation against the real Tremol
Control Unit at `154.79.253.237:8000`, reached through the ZFPLabServer
running on this till at `http://localhost:4444/`.

**Scope and safety**

- **No code was changed.** Every harness lived in the session scratchpad,
  outside the repository.
- **No sale was filed.** Only `settings()` (stores parameters) and
  `ReadStatus` (read-only status query) were sent. No `OpenInvoice`, no
  `SellPLU`, no `CloseReceipt`.
- **The device password was never printed.** It was decrypted from the
  app's own `safeStorage` vault at run time and redacted as `***` in all
  output, including inside the server's echo of it.
- Audit date: 2026-09-07. Device: `154.79.253.237:8000`. Server:
  ZFPLabServer `1.9.6` (PID 6012). Till LAN address: `192.168.8.52`.

**Ground rule followed throughout:** every claim below is backed by the
command that produced it and its verbatim output. Where something could
only be reasoned about rather than observed, it says so.

---

## Headline

**`CU_fiscalized` and `Paired_with_TIMS` could not be read at all.** The
device never answered a single `ReadStatus` across 14 attempts. The TCP
layer is healthy (15/15 connects, median 83 ms), but nothing on the far
end answers the ZFP protocol's first ping.

So neither of the two cases in the brief is established:

- **not** proven that the device is unfiscalized/unpaired (it never
  reported any bit), and
- **not** the app misreading the bits (the reading logic is correct,
  proven offline).

The session dies before either question can arise. Separately, the audit
found a genuine reporting defect on our side that disguised this as a
device-provisioning problem.

---

## 1. Baseline facts established before touching the device

| Check | Command | Result |
|---|---|---|
| Fiscal server up? | `curl -s -o /dev/null -w "%{http_code}" http://localhost:4444/` | `HTTP 200` in `0.009 s` |
| Server process | `Get-CimInstance Win32_Process` | `ZFPLabServer.exe` PID **6012** |
| POS app running? | same | yes — Electron PID **29268** (the app was open during the audit) |
| Device details in DB | `SELECT config_json FROM integrations WHERE provider='etims'` | `{"baseUrl":"http://localhost:4444/","deviceIp":"154.79.253.237","devicePort":"8000"}` |
| Password present? | vault read | yes, `RUBIS POS<NUL>etims-device-password`, written **19:01:18** |

The exact status-flag names were taken from the project's contract
rather than guessed:

```
$ grep -n "CU_fiscalized\|Paired_with_TIMS" tests/fixtures/tremol-contract.json
3325:          "name": "CU_fiscalized",
3337:          "name": "Paired_with_TIMS",
```

`ReadStatus` is `cmdByte 0x20`, "Provides detailed 6-byte information
about the current status of the CU", with **22** named `Status` response
fields. `CU_fiscalized` is byte 3 bit 5; `Paired_with_TIMS` is byte 4
bit 0. Full table in Appendix B.

---

## 2. Method

The two commands the app itself uses, sent to the server exactly as the
vendor client sends them (`fp_core.js:410` and `:258`):

1. **`settings()`** — HTTP `GET` of a literal, unencoded string appended
   to the server URL:
   `GET /settings(ip=154.79.253.237,port=8000,password=***,tcp=1)`
2. **`ReadStatus`** — HTTP `POST` to the **bare** server URL,
   `Content-Type: text/plain`, body exactly
   `<Command Name="ReadStatus"/>`, with **no `Accept` header**.

Sent from a small Electron harness (Electron is required because the
password lives in `safeStorage`; the vault is keyed by Chromium's
OSCrypt `Local State` file, so `userData` had to be pointed at the real
app's directory before `whenReady`). Source in Appendix A.

---

## 3. Evidence log, in order

### 3.1 `settings()` — Code 0

```
=== STEP 1: settings() handshake (GET, literal unencoded string) ===
REQUEST : GET /settings(ip=154.79.253.237,port=8000,***=***,tcp=1)
HTTP    : 200
RESPONSE: <Res Code="0">
  <settings>
    <com></com>
    <baud>0</baud>
    <keepPortOpen>1</keepPortOpen>
    <tcp>1</tcp>
    <ip>154.79.253.237</ip>
    <port>8000</port>
    <***>***</***>
    <defVer>2509041522</defVer>
    <servVer>1.9.6</servVer>
    <clientID>Localhost</clientID>
  </settings>
</Res>
```

Two things to read carefully here.

**Code 0 does not mean the password was accepted.** It means the server
stored the parameters. The app's own source says exactly this
(`real-etims-provider.ts:1106-1108`: *"`settings()` only stores
parameters"*). The first genuine device contact is `ReadStatus`. This
matters because the brief assumed hop 2 had proven the password — it had
not, and cannot.

**`defVer` is populated: `2509041522`.** Every capture before today had
it blank, which is why `GO_LIVE_READINESS.md`'s VERIFY-ON-DEVICE item 6
recorded the version guard as inert. It is no longer inert, and the
value matches the SDK this integration was built against
(`ZFP_SDK_KE_2509041522_ControlUnit`). That closes item 6 favourably.
`servVer` is `1.9.6`.

### 3.2 `ReadStatus` — first attempt, Code 19

```
=== STEP 2: ReadStatus (POST to bare URL, Content-Type text/plain) ===
REQUEST : POST /  body: <Command Name="ReadStatus"/>
HTTP    : 200
RESPONSE (verbatim):
<Res Code="19">
  <Err Source="Server" Type="ServUndefined">
    <Message>The Fiscal Printer has open socket. FP refuses new socket connection.
Internal error</Message>
  </Err>
  <Stacktrace>0</Stacktrace>
</Res>
```

### 3.3 Six retries, ReadStatus only — Code 19 every time

Sent without re-running `settings()`, deliberately: re-running it would
ask the server to open another socket while one was allegedly open.

```
attempt 1: Res Code=19   attempt 4: Res Code=19
attempt 2: Res Code=19   attempt 5: Res Code=19
attempt 3: Res Code=19   attempt 6: Res Code=19
```

All six carried the identical `ServUndefined` "FP refuses new socket
connection" message. Not a momentary blip.

### 3.4 Is `keepPortOpen` releasable? No

`keepPortOpen` appears in the settings echo, so the obvious question was
whether the server could be asked to drop the socket. It cannot — the
vendor exposes it only for **serial** connections:

```
fp_core.js:386  this.ServerSetDeviceSerialSettings = function (serialPort, baudRate, keepPortOpen) {
fp_core.js:389      sendReq("GET", "settings(com=" + serialPort + ",baud=" + baudRate + ",keepPortOpen=" + ... + ",tcp=0)", null);
fp_core.js:410      sendReq("GET", "settings(ip=" + ipaddress + ",port=" + tcpport + (password ? (",password=" + password) : "") + ",tcp=1)", null);
```

The TCP form (`:410`) has no `keepPortOpen` parameter. There is no
server-side "release the socket" for TCP.

### 3.5 Who holds the socket? Nobody on this machine

```
=== Connections from this machine to the device 154.79.253.237 ===
NONE - this machine holds no TCP connection to the device

=== All connections owned by ZFPLabServer.exe (PID 6012) ===
none
```

So the "open socket" the device complains about was not one this till
was holding at that moment.

### 3.6 Can anything reach the device at TCP level? Yes, instantly

```
TCP CONNECT: SUCCESS in 70ms — device accepted a new TCP socket
socket closed
```

### 3.7 After that probe, the failure changed — Code 31

Re-running the full sequence produced a **different** error:

```
<Res Code="31">
  <Err Source="Server" Type="ServTCPAuth">
    <Message>Missing first ping answer </Message>
  </Err>
</Res>
```

### 3.8 Four rounds of `settings()` + `ReadStatus` — the pattern

```
round 1: settings Code=0 | ReadStatus Code=19 ServUndefined "The Fiscal Printer has open socket. FP refuses new socket connection. Internal error"
round 2: settings Code=0 | ReadStatus Code=31 ServTCPAuth  "Missing first ping answer"
round 3: settings Code=0 | ReadStatus Code=19 ServUndefined "The Fiscal Printer has open socket. FP refuses new socket connection. Internal error"
round 4: settings Code=0 | ReadStatus Code=19 ServUndefined "The Fiscal Printer has open socket. FP refuses new socket connection. Internal error"
```

`settings()` returns Code 0 every single time; `ReadStatus` never does.

### 3.9 Is `:8000` a real listener, or a box that accepts everything?

A middlebox that SYN-proxies every port would explain "TCP connects but
nothing speaks". Tested by probing ports that should be closed:

```
port 8000:  CONNECTED in 63ms
   port 8000 closed after 6068ms (peer sent data: no)
port 8001:  TIMEOUT after 8007ms
port 9100:  TIMEOUT after 8009ms
port 4444:  TIMEOUT after 8014ms
port 31337: TIMEOUT after 8002ms
```

**Only `:8000` accepts.** So there is a real, specific listener there —
not an indiscriminate accept-all device. Also note the peer sent **zero
bytes** unprompted across a 6-second held connection, which is normal
for a request/response protocol and not itself suspicious.

### 3.10 Does ZFPLabServer even open a socket when asked?

Sampled the server's own connections every 250 ms while a `ReadStatus`
was in flight:

```
t=0ms    192.168.8.52:58111 -> 154.79.253.237:8000 State=SynSent PID=6012 (ZFPLabServer)
t=250ms  192.168.8.52:58111 -> 154.79.253.237:8000 State=SynSent PID=6012 (ZFPLabServer)
...
t=1500ms 192.168.8.52:26762 -> 154.79.253.237:8000 State=SynSent PID=6012 (ZFPLabServer)
...
t=4250ms 192.168.8.52:26762 -> 154.79.253.237:8000 State=SynSent PID=6012 (ZFPLabServer)
--- ReadStatus result ---
<Res Code="30">
  <Err Source="Server" Type="ServSockConnectionFailed">
    <Message>Socket connect FAILED</Message>
  </Err>
</Res>
```

A **third** code, and the server visibly stuck in `SynSent` — SYN sent,
no SYN-ACK returned — across two source ports, for ~4 seconds. This is
the server genuinely trying and the far end not completing the
handshake.

### 3.11 Is the server being firewalled locally? No

```
=== Firewall rules mentioning ZFPLab ===
no application firewall rules reference ZFP*

=== Default outbound policy per profile ===
Name    Enabled DefaultOutboundAction DefaultInboundAction
----    ------- --------------------- --------------------
Domain     True         NotConfigured        NotConfigured
Private    True         NotConfigured        NotConfigured
Public     True         NotConfigured        NotConfigured
```

No rule targets the server binary, and outbound is allowed by default on
every profile. The `SynSent` episode was not a local block.

### 3.12 How reliable is the endpoint really? 15 probes

```
probe  1: CONNECTED 1390ms      probe  9: CONNECTED 392ms
probe  2: CONNECTED 356ms       probe 10: CONNECTED 560ms
probe  3: CONNECTED 420ms       probe 11: CONNECTED 391ms
probe  4: CONNECTED 378ms       probe 12: CONNECTED 783ms
probe  5: CONNECTED 353ms       probe 13: CONNECTED 358ms
probe  6: CONNECTED 442ms       probe 14: CONNECTED 2066ms
probe  7: CONNECTED 404ms       probe 15: CONNECTED 355ms
probe  8: CONNECTED 347ms

=== 15 raw TCP probes to 154.79.253.237:8000 ===
{"connected":15,"reset":0,"timeout":0,"refused":0,"other":0}
connect latency ms: min=39 median=83 max=1763
```

**15/15 succeeded.** An earlier, smaller run had also seen one
`ECONNRESET` immediately after a successful connect, and one slow
connect at 3123 ms — so the endpoint is not perfectly clean, but at TCP
level it is fundamentally available. The `SynSent` failure in §3.10 did
not reproduce.

### 3.13 Final confirmation round, with TCP demonstrably healthy

```
round 1: settings Code=0 | ReadStatus Code=31 ServTCPAuth  "Missing first ping answer"
round 2: settings Code=0 | ReadStatus Code=19 ServUndefined "The Fiscal Printer has open socket..."
round 3: settings Code=0 | ReadStatus Code=19 ServUndefined "The Fiscal Printer has open socket..."
round 4: settings Code=0 | ReadStatus Code=19 ServUndefined "The Fiscal Printer has open socket..."
```

Same result with a proven-good network path. **14 `ReadStatus` attempts
in total across the audit; zero Code-0 responses.**

---

## 4. The two flags — the actual deliverable

| Flag | Value | Raw attribute returned by the device |
|---|---|---|
| **CU fiscalized** | **UNKNOWN** | none — no `<Res Name="CU_fiscalized" …/>` was ever returned |
| **Paired with TIMS** | **UNKNOWN** | none — no `<Res Name="Paired_with_TIMS" …/>` was ever returned |

And every one of the other 20 status flags: also unknown, for the same
reason. There is no attribute to quote because the device never emitted
one. Reporting a value here would mean inventing data, which this audit
will not do.

---

## 5. What the three codes mean together

| Code | Type | Message | Reading |
|---|---|---|---|
| `31` | `ServTCPAuth` | `Missing first ping answer` | Socket opened; the server's **initial protocol ping** went unanswered. This is *before* the password stage. |
| `19` | `ServUndefined` | `The Fiscal Printer has open socket. FP refuses new socket connection.` | A socket the far end still counts as open is blocking a new session. |
| `30` | `ServSockConnectionFailed` | `Socket connect FAILED` | The TCP handshake itself did not complete (seen once, as `SynSent`). |

These are one failure observed at different moments, not three separate
problems: the server connects, sends its first ping, gets nothing
(**31**), and leaves a socket the far end still considers open, so the
next attempt is refused (**19**) until it ages out — then **31** again.
**30** is the same story when the handshake itself does not complete.

### Why this is not the password

The initial hypothesis in this audit was a wrong TCP password. **That
was wrong**, and it is recorded here rather than deleted (see Appendix C).
The device owner confirmed the password is correct, and the vendor's own
error strings independently corroborate it — the server emits **two
different Code-31 messages** for two different stages:

| Message | Stage | Seen in this audit? |
|---|---|---|
| `Missing password authentication answer` | the password step failed — the wrong-password signature, and exactly what `tests/fixtures/wire/readstatus-code31-authfail.xml` holds | **No, never** |
| `Missing first ping answer` | the **initial** ping went unanswered, which happens *before* the password is presented | **Yes, every time** |

Since only "first ping" ever appears, the session dies before
authentication is attempted. A wrong password cannot produce this
message.

What made this genuinely misleading: `SDK_RECON.md:1042` glosses Code 31
generically as *"Wrong device TCP password"*. The code is shared by both
stages, and **only the message text separates them** — a distinction
worth recording for whoever hits this next.

---

## 6. Cross-check: does our app misread the status bits?

**No.** Ran the app's own parser over the full 22-flag Code-0 fixture and
applied the app's exact hop-3 test (offline, no device needed):

```
=== parseXmlResponse output for a Code-0 ReadStatus ===
  CU_fiscalized = "1"  (typeof string)
  CU_produced = "1"  (typeof string)
  Paired_with_TIMS = "1"  (typeof string)
  [...19 more flags, all "0", all typeof string]

=== The app's exact hop-3 test (real-etims-provider.ts:1123-1140) ===
data.CU_fiscalized      = "1" (typeof string)
data.Paired_with_TIMS   = "1" (typeof string)
fiscalized !== "1"  -> false (true would WRONGLY fail hop 3)
paired     !== "1"  -> false (true would WRONGLY fail hop 3)

VERDICT: PASSES — the app would correctly report a fiscalized+paired device as ready
```

Chain verified end to end: the names match the contract, the parser
(`parseXmlResponse`, typed `Record<string, string>`) yields **strings**,
and `real-etims-provider.ts:1123-1140` compares against the string
`'1'`. There is no boolean/string mismatch, no name mismatch, no
case mismatch.

**Caveat, stated plainly:** this validates the logic against the
*expected* response shape. No real device has ever returned a Code-0
`ReadStatus` to this project, so the bit-reading remains unverified
against real hardware. It is not disproven — it is untested, and it
stays on the verify-on-device list.

---

## 7. Defect found on our side — misreporting, not misreading

The app **computes the right answer and then discards it.**

`testConnection()` routes *any* `readStatus()` failure to hop 3
(`real-etims-provider.ts:639-642`):

```ts
const status = await this.readStatus()
if (!status.success) {
  return connectionTestFailed('ready', describeNotReady(status.error))
}
```

`mapFiscalServerError()` (`real-etims-provider.ts:253-282`) has already
distinguished 19 / 30 / 31 / 53 / 63 with accurate, actionable text by
this point. Then `describeNotReady()`
(`fiscal-connection-test.ts:139-147`) throws all of it away, because it
only special-cases two substrings:

```ts
if (error?.includes('not fiscalized')) return '…has not been fiscalized…contact the device supplier.'
if (error?.includes('not paired'))     return '…not paired with KRA TIMS…contact the device supplier.'
return 'The fiscal device answered but is not ready to file sales. Contact the device supplier.'
```

Every failure this audit observed — 19, 30 and 31 alike — collapses into
that last sentence. Two distinct defects:

1. **Wrong cause reported.** Three faults needing three different
   remedies are indistinguishable on screen. Worse, the sentence asserts
   *"The fiscal device answered"*, which in all three cases is **false** —
   the device answered nothing at all. This is precisely what pointed the
   original investigation at KRA onboarding.
2. **Wrong hop labelled.** A connect/ping/auth failure is reported as
   hop 3 ("device ready to file") when it belongs to hop 2 ("device
   answering"). Hop 2 displays a pass it did not earn, because hop 2
   covers only `settings()`, which validates nothing.

**Not fixed here** — this task was read-only. Suggested fix when
scheduled: pass the specific cause through when it is a known server
code, and reserve the "contact the supplier" wording for the two cases
that genuinely mean it (`not fiscalized` / `not paired`).

> **Done in `docs/phase-98.md`.** Both sub-defects are fixed along those
> lines: server/connection codes now report hop 2 with their specific
> cause, hop 3 is reserved for a device that actually answered, and no
> message claims the device answered when nothing did.

---

## 8. What is proven, what is not

**Proven today**

- The fiscal server is up, healthy, and answers on `localhost:4444`.
- `settings()` succeeds and returns `defVer=2509041522` / `servVer=1.9.6`.
- TCP to `154.79.253.237:8000` is reliable: 15/15, median 83 ms.
- `:8000` is a specific listener; 8001/9100/4444/31337 are not open.
- ZFPLabServer is not blocked by any local firewall rule.
- `ReadStatus` never succeeds: 14 attempts, 0 successes, codes 19/30/31.
- The app's status-bit reading logic is correct against the expected shape.
- Our hop-3 reporting collapses three distinct causes into one wrong
  sentence.

**Not proven / still unknown**

- Whether the CU is fiscalized. **Unknown.**
- Whether the CU is paired with TIMS. **Unknown.**
- Any of the other 20 status flags. **Unknown.**
- Whether our bit-reading works against *real* hardware (untested, since
  no Code-0 has ever been received).
- What is actually listening on `:8000` — a CU that will not talk, a
  router/NAT in front of an absent CU, or something else entirely. This
  audit cannot see past the port from here.

**Cannot be determined from this till**

Anything requiring physical or network-side access at the device end:
whether the CU is powered on, whether the port-forward still targets it,
whether it restricts sessions by source IP, and whether it has been
fiscalized and TIMS-paired with KRA at all.

---

## 9. Verdict

> **Something accepts TCP on `154.79.253.237:8000` but does not answer
> the ZFP protocol's first ping.** The fiscal session therefore never
> establishes, no status bits are ever returned, and
> "CU fiscalized / Paired with TIMS" remains **unknown**. This is an
> endpoint condition at the device end, for the supplier or whoever owns
> that network. It is **not** a credential problem and **not** a fault in
> this integration's wire handling.

Most likely causes, in order, for the supplier conversation:

1. The public `IP:port` is a NAT/port-forward that no longer lands on the
   Control Unit — the router answers the handshake, but the CU is no
   longer behind it or its local address changed.
2. The CU is powered off or off the network while the forward in front of
   it still accepts connections.
3. The CU's ZFP TCP service is on a different port, and `:8000` is
   answered by something else at that address.
4. The CU restricts sessions to whitelisted source IPs and this till is
   not on the list.

---

## 10. Next steps

**At the device end (supplier / network owner)**

1. Confirm that `154.79.253.237:8000` currently forwards to a powered-on
   Control Unit — ideally while watching whether the CU registers an
   incoming session. We can connect on demand so they can watch it land.
2. Confirm the CU's actual ZFP TCP port, and whether it filters by source
   IP.
3. Confirm whether the unit has been fiscalized and TIMS-paired at all —
   still an open question that only the device can answer.

**On our side**

4. Once a Code-0 `ReadStatus` finally arrives, re-read the two flags.
   That is the only thing that settles the original question, and it
   doubles as the first real-hardware verification of §6's logic.
5. ~~Fix the hop-3 reporting defect in §7 so the next person is told which
   of 19/30/31 actually occurred, instead of a single sentence that also
   wrongly claims the device answered.~~ **Done — `docs/phase-98.md`.**
   Re-running Test Connection against this device now reports hop 2
   failed, "The fiscal device did not respond to the connection. Check
   the device is switched on and reachable at the IP address and port
   above." — which is what was actually true all along.

---

## Appendix A — Harness scripts (reproduction)

All lived in the session scratchpad, never in the repo.

**`readstatus-live.cjs`** — one full `settings()` + `ReadStatus`, run
under Electron so `safeStorage` can decrypt the vault. Key details:

```js
const USER_DATA = 'C:/Users/paulc/AppData/Roaming/rubis-pos-desktop'
app.setPath('userData', USER_DATA)   // BEFORE whenReady — OSCrypt reads
                                     // its key from <userData>/Local State
// ...
const vault = JSON.parse(readFileSync(join(USER_DATA, 'secret-vault.json'), 'utf8'))
const key = Object.keys(vault).find((k) => k.endsWith('etims-device-password'))
const password = safeStorage.decryptString(Buffer.from(vault[key], 'base64'))
const redact = (s) => s.split(password).join('***')

// GET, literal unencoded path via node:http (never URL-encoded)
`/settings(ip=${DEVICE_IP},port=${DEVICE_PORT},password=${password},tcp=1)`
// POST to '/' with Content-Type: text/plain, no Accept header
'<Command Name="ReadStatus"/>'
```

Run with:

```
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron <script>.cjs
```

(`ELECTRON_RUN_AS_NODE=1` is set in this shell and makes Electron start
as plain Node, so it must be unset.)

**`readstatus-retry.cjs`** — `ReadStatus` only, six attempts, five
seconds apart, no `settings()` in between.

**`readstatus-rounds.cjs`** — four rounds of `settings()` + `ReadStatus`,
tallying the response codes.

**`parsecheck.ts`** — offline: runs the app's `parseXmlResponse` over
`tests/fixtures/wire/readstatus-fiscalized-full.xml` and applies the
app's exact hop-3 comparison. Run with `npx vite-node`.

Ad-hoc probes used plain `node -e` (raw TCP) and PowerShell
(`Get-NetTCPConnection`, `Get-NetFirewallApplicationFilter`).

---

## Appendix B — The 22 `ReadStatus` flags

From `tests/fixtures/tremol-contract.json` (`ReadStatus`, `cmdByte 0x20`),
byte/bit per protocol PDF §2.2.1. The two that gate filing are in bold.

| # | Flag | Byte | Bit |
|---|---|---|---|
| 1 | `Power_down_in_opened_fiscal_receipt` | 0 | 1 |
| 2 | `DateTime_not_set` | 0 | 3 |
| 3 | `DateTime_wrong` | 0 | 4 |
| 4 | `RAM_reset` | 0 | 5 |
| 5 | `Hardware_clock_error` | 0 | 6 |
| 6 | `Reports_registers_Overflow` | 1 | 1 |
| 7 | `Opened_Fiscal_Receipt` | 2 | 1 |
| 8 | `Receipt_Invoice_Type` | 2 | 2 |
| 9 | `SD_card_near_full` | 2 | 5 |
| 10 | `SD_card_full` | 2 | 6 |
| 11 | **`CU_fiscalized`** | **3** | **5** |
| 12 | `CU_produced` | 3 | 6 |
| 13 | **`Paired_with_TIMS`** | **4** | **0** |
| 14 | `Unsent_receipts` | 4 | 1 |
| 15 | `Service_contract_nearly_expired` | 4 | 2 |
| 16 | `No_Sec_IC` | 5 | 0 |
| 17 | `No_certificates` | 5 | 1 |
| 18 | `Service_jumper` | 5 | 2 |
| 19 | `Expired_service_contract` | 5 | 3 |
| 20 | `Missing_SD_card` | 5 | 4 |
| 21 | `Wrong_SD_card` | 5 | 5 |
| 22 | `Update_is_available` | 5 | 6 |

Every one of these came back **unknown** in this audit.

### Server-level `<Res Code>` values the app maps

`real-etims-provider.ts:253-282`:

| Code | Meaning in app | Retryable |
|---|---|---|
| `19` | device has an open socket from another connection | yes |
| `30` | server cannot reach the device — check IP/port/power | yes |
| `31` | device did not answer, or rejected the TCP password | yes |
| `53` | session not initialized — reconnecting | yes |
| `63` | server rejected the request format | no |

**Fixed in phase-98.** When this audit was written, the app's text for
`31` asserted the wrong-password stage, though as §5 shows Code 31 also
carries the *"first ping"* variant, which is not a password problem. The
row above reflects the corrected wording: the sale-failure text now names
both possibilities, and the Test Connection screen — which does have the
raw `<Message>` available — tells the two stages apart outright. The
`SDK_RECON.md` gloss that started the confusion is annotated too. See
`docs/phase-98.md`.

---

## Appendix C — Corrections made during this audit

Recorded rather than quietly edited away, per this project's standing
practice.

1. **Wrong prime suspect (password).** An earlier revision of this
   document named the stored TCP password as the most likely cause,
   reasoning from Code 31 plus the fact that the stored secret is a
   dictionary word resembling the `'Password'` default removed in
   phase-92. The device owner corrected this: the password is right.
   The vendor's two distinct Code-31 messages then confirmed the failure
   occurs before the password stage. The lesson worth keeping is that
   `SDK_RECON.md:1042`'s one-line gloss of Code 31 is incomplete, and
   the message text — not the code — is what distinguishes the stages.
2. **`SynSent` over-read.** The single `Code 30` / `SynSent` observation
   in §3.10 initially looked like a process-specific block on
   ZFPLabServer. Checking the firewall (§3.11) and then running 15
   direct probes (§3.12) showed the path is fine and the episode did not
   reproduce. It is reported as an observed intermittency, not a
   diagnosis.

   **Explained in `docs/phase-99.md` §4.** The endpoint accepts two
   sockets and never services them; whether a given connect succeeds,
   hangs in `SynSent`, or is refused depends only on how full that
   backlog is at that instant. The intermittency was real, and it was
   never random. Caution was right, but the episode was a symptom of the
   main fault rather than a separate one.
