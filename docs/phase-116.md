# Phase 116 — AUDIT: verifying our old-defs transport against the old SDK's Java/C#/VB clients

Read-only. **Nothing was changed** — no source, test, fixture or config,
and no request was sent to the server or the device.

The gap being closed: our wire code was built against the **new** SDK's JS
client (`Libs/JS/fp_core.js`, defVer 2509041522). The **old** SDK has no JS
client, so old-defs *transport* behaviour had been assumed rather than
verified. This audit reads the old SDK's other clients instead.

## Verdict, up front

> **Our transport matches the old client on every load-bearing detail.**
> The one genuine divergence is `Content-Type` — and the two old clients
> **disagree with each other** about it, which is itself the proof that it
> is not load-bearing. The missing-JS gap is closed on paper; only
> live-device verification remains.

---

## 0. Where the old transport actually lives

`FP.java`, `FP.cs` and `FP.vb` are **generated command wrappers only** —
each one inherits the transport:

```java
public class FP extends FPcore          // Java Lib/TremolZFP/FP.java:13
public class FP : FPcore                // C# Lib/FP.cs:15
    Inherits FPcore                     // VB/FP.vb:13
```

`FPcore` is shipped **compiled**, so this audit had to go into the
binaries:

| Client | Artefact | How it was read |
|---|---|---|
| Java | `Java Lib/FPcore.jar` | unzipped, `javap -p -c -constants TremolZFP.FPcore` |
| C# / VB | `*/FPcore.dll` | .NET `#US` heap decoded as UTF-16LE |

**Independence check, which matters for how much weight to give agreement:**

```
7bda5918…  C# Lib/FPcore.dll
7bda5918…  VB/FPcore.dll              ← byte-identical to C# Lib
db9b5119…  C#_x86 Lib/FPcore.dll
66b9a53b…  C#_NET_Standart_2.0/FPcore.dll
```

VB is not an independent implementation — it ships the *same binary* as
C#. The x86 and .NET-Standard builds are different compilations of the
same source. So there are **two** independent old implementations, not
three: **Java** and **.NET**. Where those two agree, that is strong
evidence. Where they disagree — §3 — that is the interesting part.

---

## 1–8. The cross-check table

| # | Item | Verdict | Old client's actual behaviour |
|---|---|---|---|
| 1 | `settings()` string | **DIFFERS (immaterial)** | Same params, same order; both old clients send `,password=` **unconditionally** |
| 2 | Method + URL shape | **MATCH** | GET for `settings()`, POST to the **bare** server address |
| 3 | **Content-Type** | **DIFFERS — and the old clients differ from each other** | Java `application/xml; charset='UTF-8'`; .NET `text/xml; encoding='utf-8'` |
| 4 | **Headers** | **DIFFERS (superset on their side)** | Java adds `Accept` + `Content-Length`; .NET adds none beyond ContentType/ContentLength |
| 5 | Command envelope | **MATCH** | `Command/@Name` → `Args` → `Arg/@Name/@Value` |
| 6 | Response parsing | **MATCH (identical codes)** | `Code`=="0" success; `STE1`/`STE2`/`FPLibErrorCode` base-16, gated on `FPException`=40 |
| 7 | `clientremove` | **MATCH** | `clientremove(who=me)` |
| 8 | Everything else | **DIFFERS (deliberate)** | `checkVersion` **throws** on defVer mismatch; 3 s connect timeout; no defs push |

---

### 1. The `settings()` string — same shape, one conditional difference

**Old Java** (`FPcore.ServerSetDeviceTcpSettings`, bytecode):

```
ldc "settings(ip="   append(ip)
ldc ",port="         append(port)
ldc ",password="     append(password)     ← no conditional branch
ldc ",tcp=1)"
→ ServerSendGETRequest(...)
```

**Old .NET** — a single format literal, same conclusion:

```
'settings(ip={0},port={1},password={2},tcp=1)'
```

**Ours** ([http-client.ts:257-266](../src/main/services/integrations/http-client.ts#L257)):

```ts
const passwordSegment = password ? `,password=${password}` : ''
return `settings(ip=${deviceIp},port=${devicePort}${passwordSegment},tcp=1…)`
```

Parameter **names, order and the literal `tcp=1` are identical**, and
neither side URL-encodes. The one difference: both old clients emit
`,password=` even when the password is blank; we omit the segment
entirely, following the new JS (`fp_core.js:410`'s
`(password ? (",password=" + password) : "")`).

**Immaterial in practice.** `RealFiscalizationProvider.isConfigured()`
refuses to call at all without a password, so the blank branch is
unreachable from the app — it only affects a caller reaching `getSettings`
directly. Worth knowing, not worth changing.

### 2. Method and URL shape — MATCH

From `FPcore.Do()`'s bytecode, the POST target is the raw field, with no
path appended:

```
88: getfield  ServerAddress:Ljava/lang/String;
94: invokespecial toString(Document)            ← the XML body
97: invokespecial serverSendPOSTRequest(String, String)
```

`serverSendPOSTRequest` then does `new URL(...)` →
`setRequestMethod("POST")`, and `ServerSendGETRequest` does
`setRequestMethod("GET")`. Exactly our split: GET for `settings()` /
`clientremove()`, POST to the bare base URL for commands, with routing on
the body's `Command/@Name`. Our `endpoints` map being all `''` is correct
for the old client too.

### 3. Content-Type — the high-value check, and the headline finding

**Three official clients, three different values:**

| Client | Content-Type |
|---|---|
| Old **Java** (`FPcore.jar`) | `application/xml; charset='UTF-8'` |
| Old **.NET** (`FPcore.dll`) | `text/xml; encoding='utf-8'` |
| New **JS** (`fp_core.js:32`) | `text/plain` |
| **Ours** | `text/plain` |

The Java value is visible directly in the bytecode of both send methods:

```
43: ldc "Content-Type"
45: ldc "application/xml; charset='UTF-8'"
47: invokevirtual HttpURLConnection.setRequestProperty
```

The .NET value is in its user-string heap (`text/xml; encoding='utf-8'`,
alongside `application/text`), with `HttpWebRequest`/`ContentType`/
`ContentLength` in the metadata confirming it is set as a property rather
than a header literal.

**This is the finding, and it cuts the opposite way to the brief's
worry.** The concern was that the old client might need something other
than `text/plain`. What the evidence actually shows is that **the vendor's
own two old clients do not agree with each other** — one sends
`application/xml; charset='UTF-8'`, the other `text/xml; encoding='utf-8'`
— and the new client sends a third value entirely. A server that accepts
all three from its own official clients is not parsing on Content-Type.

There is also **direct empirical proof against the old server**, from
[phase-115.md](phase-115.md): our `text/plain` POST of
`<Command Name="ReadStatus"/>` to `servVer 1.8.2` returned

```
<Res Code="31"> … Missing password authentication answer
```

— a *routed, device-level* answer. A Content-Type the server refused would
have produced `Code 63` (`ClientInvalidPostFormat`, §6), which is exactly
the failure mode this check exists to catch. It did not occur.

> Historical note this settles: `http-client.ts`'s own comment says an
> earlier revision used `application/xml; charset='UTF-8'` "inferred from
> decompiling an older compiled `FPcore.jar` — wrong, corrected here
> against the shipping source." That inference was **not** wrong about the
> old client — it read the old Java client correctly, as this audit
> confirms. It was simply superseded by the new client's value. Both work.

### 4. Headers — the old clients send a superset

| Header | Old Java | Old .NET | New JS | **Ours** |
|---|---|---|---|---|
| `Content-Type` | ✓ (POST **and** GET) | ✓ | ✓ | ✓ |
| `Accept` | ✓ `application/xml` (POST only) | ✗ | ✗ | ✗ |
| `Content-Length` | ✓ explicit | ✓ (property) | implicit | implicit (axios) |

The old Java client sets `Accept: application/xml` on POSTs; the old .NET
client does not (`Accept` appears nowhere in its metadata). **The two old
clients disagree here too**, which again marks it as incidental. The new
JS sets no `Accept` at all — its only other header line, an
`Accept-Charset`, is commented out in the shipped source — and we match
that.

`Content-Length` is not a real difference: axios sets it automatically for
a string body in Node, so it goes on the wire either way.

Note also that old Java sets `Content-Type` on the **GET** as well as the
POST. We do too, via the axios instance default — incidentally matching
the old client more closely than the new JS does.

### 5. The command envelope — MATCH

`fillXmlWithParamVals` builds, in order: `Command` with attribute `Name`,
then `Args`, then each `Arg` with attributes `Name` and `Value`. Identical
to `serializeToXml`'s output, and no XML prolog on either side:

```xml
<Command Name="SellPLUfromExtDB"><Args><Arg Name="NamePLU" Value="Bread"/>…</Args></Command>
```

### 6. Response parsing — MATCH, and stronger than expected

`ThrowOnServerError` reads `Code`, compares against `"0"`, and on a
non-zero code reads `Err` for `STE1`, `STE2`, `FPLibErrorCode` and
`Message`. All three STE fields are parsed with `bipush 16` — **base 16**,
matching our `parseInt(hex, 16)`.

The STE read is gated on the error type resolving to `FPException`, not on
a literal `40` — but the old client's own enum pins the numbers, and they
are **identical to the ones our code handles**:

```
ServUndefined                 = 19      ServSockConnectionFailed = 30
ServTCPAuth                   = 31      FPException              = 40
ClientSettingsNotInitialized  = 53      ClientInvalidPostFormat  = 63
```

Those are exactly `mapFiscalServerError`'s cases (19/30/31/53/63) and our
`RES_CODE_COMMAND_ERROR = '40'` / `RES_CODE_SETTINGS_MISSING = '53'`. The
old client's Code-40 STE gate is semantically the same as ours. No
structural difference `parseXmlResponse` would miss.

### 7. `clientremove` — MATCH

```
ServerCloseDeviceConnection:  ldc "clientremove(who=me)"  →  ServerSendGETRequest
```

Byte-identical to ours ([http-client.ts:300](../src/main/services/integrations/http-client.ts#L300)).
The old client also exposes `clientremove(who=all)`, `restart()`,
`log(on=…)`, `clients()`, `exit()` — we use only `clientremove(who=me)`,
which is the correct per-client release.

### 8. Everything else around a request

- **`checkVersion` throws — we only warn.** The old client compares the
  settings response's `defVer` against its own `VersionDef` and raises
  *"Server definitions are older than yours"* / *"newer than yours"* /
  *"Unable to get version of server definitions"*. Ours returns a
  three-state from `checkDefVersion` and **never blocks a sale**. This is
  a deliberate, documented divergence (`docs/KNOWN_GAPS.md`), not an
  oversight — and it is the more forgiving behaviour, which is what makes
  [phase-111.md](phase-111.md)'s both-versions support possible at all.
  An old client pointed at our current server would simply **refuse to
  run**.
- **Connect timeout 3000 ms** (`sipush 3000`, both send methods) vs our
  `ETIMS_REQUEST_TIMEOUT_MS = 5000`. Ours is more generous; no
  correctness impact.
- **No defs push.** `FPcore` has no `ServerSendDefs` — it loads command
  XML *locally* (`loadXmlData`/`loadXmlFile`). The new JS *does* have
  `ServerSendDefs`. **We never call it either**, so we match the old
  client here and the difference from the new JS is moot.
- **`XMode` lets the old client send commands as a GET function-call
  string** (`useGetRequest`) instead of an XML POST. We always POST, which
  is one of the modes the old client supports — allowed, not required.
- **No retries, no pre-flight handshake** beyond `settings()` in either
  client. Matches ours.

---

## Old vs new transport — was the gap ever real?

Comparing the two old clients against the new JS directly:

| Detail | Old Java | Old .NET | New JS | Same? |
|---|---|---|---|---|
| settings() params/order | ip,port,password,tcp=1 | same | same | **yes** |
| blank password omitted | no | no | **yes** | no |
| GET settings / POST bare | yes | yes | yes | **yes** |
| Command envelope | same | same | same | **yes** |
| Error codes 19/30/31/40/53/63 | same | same | same | **yes** |
| `clientremove(who=me)` | same | same | same | **yes** |
| Content-Type | `application/xml; charset='UTF-8'` | `text/xml; encoding='utf-8'` | `text/plain` | **no — all three differ** |
| `Accept` | `application/xml` | none | none | no |

**The gap was smaller than feared.** Every structural element of the
transport — URL shape, method split, envelope, error-code vocabulary,
release call — is identical across old and new. The *only* things that
moved between SDK generations are the two details that the old clients
cannot even agree on among themselves: `Content-Type` and `Accept`.

---

## Conclusion

**Our transport matches the old client — the missing-JS gap is closed on
paper; only live-device verification remains.**

No old-defs transport branch is needed. Concretely:

- Items 2, 5, 6, 7 are exact matches, verified from the old client's own
  compiled send code.
- Item 1's difference is unreachable from the app.
- Items 3 and 4 — the two the brief singled out as most likely to break a
  request — are the two where **the vendor's own old clients contradict
  each other**, which is the strongest available evidence that the server
  ignores them. Backed by live proof: our `text/plain` POST to
  `servVer 1.8.2` got a routed `Code 31`, not the `Code 63` a rejected
  format produces.
- Item 8's `checkVersion` divergence is deliberate and in our favour.

**VERIFY-AGAINST-REAL-OLD-DEVICE still stands** ([phase-111.md](phase-111.md)):
this confirms the *transport* is right for old defs. It says nothing about
the old-defs *sale sequence* against a real device, which remains
unproven because no old-defs device has been reachable
([phase-109.md](phase-109.md)).

---

## What was changed

Nothing. `FPcore.jar` was unzipped into the scratchpad and disassembled
there; the DLLs were read in place, byte-wise, never executed or modified.
