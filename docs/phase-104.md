# Phase 104 — What the ping byte `0x60` means (documentation lookup)

Read-only. Nothing in the SDK or the app was changed.

**The log being explained:**

```
Socket connecting to 154.79.253.237:8000
Send ping 1. Waiting pong 1...
Pong 1: 0x60 0x00
RETRY connect2...1
Send ping 1. Waiting pong 1...
Pong 1: 0x60 0x00
E: The Fiscal Printer has open socket. FP refuses new socket connection.
```

---

## 1. The vendor's table — `protocol_description_KE_CU_2509041522.pdf` §1.3, page 8

Section title: **"SHORT MESSAGES FOR TESTING THE STATUS OF THE CU"**, verbatim:

> The exchange protocol includes two unpacked single-byte codes for testing the status of
> the CU, which can quickly determine the status of the device. The two codes and their
> meaning are shown in the table below:
>
> ```
> Query SA  Response CU                          Meaning
>
> 04            04               CU is on
>
>           40                   CU is READY
>
>                         Bit.0
>
>           41                   CU is busy
>
> 09        50 CU is waiting for password (LAN or WiFi connection only)
>
>           60 CU is already busy with another connection (LAN or WiFi connection only)
>
>           70 Wrong password (LAN or WiFi connection only)
> ```

**The row asked for, on its own:**

> `60   CU is already busy with another connection (LAN or WiFi connection only)`

Your reading was right, and so were all four neighbours. Two details the table adds:

- **`60` answers query `09`, not query `04`.** `04` is the "are you alive" probe and
  answers `04`/`40`/`41`; `09` is the LAN/WiFi connection probe and answers
  `50`/`60`/`70`. The three `09` answers are the connection-ownership states:
  needs password, taken by someone else, wrong password.
- **`(LAN or WiFi connection only)`** — `60` is only ever emitted over a network
  transport. The capture is TCP to `154.79.253.237:8000`, so this is the applicable
  branch.

Note that `60` and `70` are distinct rows: **a wrong password is `70`, not `60`.**
Getting `60` positively rules the password out.

## 2. `fp_core.js` — the requested code path is not there, and cannot be

The brief expected the `0x60` → Code-19 mapping to live in `Libs/JS/fp_core.js`. It does
not, in any shipped copy. The vendor JS client is a **pure HTTP client to ZFPLabServer**:

- `fp_core.js:21` — `var url = "http://localhost:4444/";`
- `fp_core.js:26` — `XMLHttpRequest` / `Microsoft.XMLHTTP`, and nothing else
- zero occurrences of `ETX`, `checksum`, `ACK`, socket or serial framing in the file

The ping/pong is the **server's** side of the wire, below the HTTP layer the client
speaks. Consistent with `tracker/SDK_RECON.md` §6.1: *"Neither is reachable through the
ZFPLab HTTP layer — the server owns the serial/TCP framing."*

**The exact log text is not quotable from this SDK package.** `Send ping`,
`Waiting pong`, `open socket`, `refuses new` and `Fiscal Printer has` return **zero**
matches across every file in `ZFP_SDK_KE_2509041522_ControlUnit`, including all three
Linux server binaries (`zfplabserver`, `zfplabserver_x86`, `zfplabserver_arm`). The
Windows build ships only as `ZFPLabServerSetup.exe`, compressed. So the refusal sentence
is the server's own, and the vendor did not document it here.

**But it is quotable from our own wire** — captured verbatim in
[phase-97.md](phase-97.md) §3.2, and again in [phase-99.md](phase-99.md) and
[phase-60.md](phase-60.md):

> ```xml
> <Res Code="19">
>   <Err Source="Server" Type="ServUndefined">
>     <Message>The Fiscal Printer has open socket. FP refuses new socket connection.
> Internal error</Message>
>   </Err>
>   <Stacktrace>0</Stacktrace>
> </Res>
> ```

Two things this adds. The real message carries a trailing **`Internal error`** that the
connect-log line drops — so anything matching on that string must not anchor to the end.
And phase-97 saw this **fourteen times with zero Code-0 replies**, six of them
consecutive on `ReadStatus` alone, so it is a stable state rather than a blip.

Note the pairing is always `settings` **Code=0** followed by `ReadStatus` **Code=19**:
the HTTP session with ZFPLabServer is fine, and the refusal is about the server's own
socket to the device.

**What can be cited about Code 19** — `fp_core.js:536`:

> ```js
> ServUndefined: 19,
> ```

It is the client's catch-all: an *undefined* server error, carrying no meaning of its
own. Whatever this code means here comes entirely from the `<Message>` string beside it,
not from the number. That is the same trap already documented for Code 31 in
`SDK_RECON.md` §6.3 and hit live in [phase-97.md](phase-97.md) §5, where `31` with
`Missing first ping answer` was misread as a wrong password.

So the chain `0x60` → *"already busy with another connection"* → *"FP refuses new socket
connection"* is **sound on the PDF's side and on the server's observed behaviour, but the
mapping itself is only inferred from the two appearing together in the capture** — the
vendor documents the byte, not the sentence. Worth saying plainly to the supplier rather
than presenting it as their documented mapping.

## 2a. What this settles about phase-97 §5

[phase-97.md](phase-97.md) §5 read codes 31, 19 and 30 as **one** failure seen at
different moments, and explained Code 19 as *our own* leftover socket:

> the server connects, sends its first ping, gets nothing (**31**), and leaves a socket
> the far end still considers open, so the next attempt is refused (**19**) until it ages
> out — then **31** again.

The `0x60` capture shows that is not what Code 19 is. **The device did answer the ping.**
`0x60` is a reply, not silence — and §1.3 gives it a specific meaning that is not "your
previous socket has not aged out" but **another connection owns the session**. So 31 and
19 are two different device behaviours, not one failure at two moments:

| Pong | Server outcome | What the device is saying |
|---|---|---|
| *(nothing)* | `31 ServTCPAuth` — `Missing first ping answer` | it did not answer at all |
| `0x60` | `19 ServUndefined` — `refuses new socket connection` | it answered, and said it is held by someone else |

That is a better lead than phase-97's, because it points outward. Waiting for our own
socket to age out is a thing that fixes itself; a session held by another client does
not. It also explains why phase-97's fourteen attempts never once succeeded, and why
[phase-99.md](phase-99.md) saw the same thing later.

**This does not overturn phase-97's headline** — its conclusion that the problem is not
our password still stands, and `0x60` strengthens it (wrong password is `70`).

## 3. The second byte, `0x00`

§1.3 calls these **"unpacked single-byte codes"** — one byte, and the table's Meaning
column is indexed by that one byte. **The docs describe no second byte, no terminator,
and no framing** for short messages; they are explicitly outside the packed message
format (which is the one with `ETX = 0Ah`, §1.1).

`00h` appears nowhere in §1.3. Its only occurrence in the framing sections is inside the
checksum range description (*"XOR on NBL STE and STE = 00h .. FFh"*), which is unrelated.

**Therefore: `0x60` is the status byte; the trailing `0x00` is undocumented.** It is not
a documented terminator and not a documented second status value. Anyone reading it as
either is going beyond the source. The likeliest explanation is a fixed-size read buffer
printed whole, but the docs do not say so and this note does not claim it.

---

## Conclusion

**`0x60` means the CU is already busy with another connection.** The device answered the
LAN/WiFi connection probe (`09`) by saying its session is held by someone else; the
server retried once, got `0x60` again, and refused. So the Code-19 refusal here is
**"the device is busy with another client's session"** — not a fault on our side, not a
wrong password (that is `70`), and not a device that is down (it answered, twice).

The action it points to is finding what holds the open socket on
`154.79.253.237:8000` — another till, a stale session, or a previous connection the
device has not released.

## Sources

| Claim | Source |
|---|---|
| `60` = already busy with another connection | `protocol_description_KE_CU_2509041522.pdf` §1.3, p.8 (extracted lines 490–511) |
| `70` = wrong password, a different code | same table |
| Short messages are single-byte, unpacked | same section, opening sentence |
| Client is HTTP-only, owns no ping | `Libs/JS/fp_core.js:21,26`; `tracker/SDK_RECON.md` §6.1 |
| `19` = `ServUndefined`, a catch-all | `Libs/JS/fp_core.js:536` |
| Refusal text absent from the package | grep over `ZFP_SDK_KE_2509041522_ControlUnit`, incl. all three Linux server binaries |
| Refusal text as the server actually sends it | [phase-97.md](phase-97.md) §3.2 (verbatim `<Res Code="19">`); also §3.13, [phase-99.md](phase-99.md), [phase-60.md](phase-60.md) |
| 14 `ReadStatus` attempts, zero Code-0 | [phase-97.md](phase-97.md) §3.13 |
| Code + message must be read together | `tracker/SDK_RECON.md` §6.3; [phase-97.md](phase-97.md) §5 |
