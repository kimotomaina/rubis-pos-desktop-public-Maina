# Phase 179 — print-raw.ps1 fails to compile on a real till (Add-Type 'using' error)

- **Date:** 2026-09-29
- **Requested:** Fix a real-till failure — `Add-Type` in `resources/print-raw.ps1` refuses to compile with `Invalid token 'using' in class, struct, or interface member declaration`, because `-MemberDefinition`'s snippet is compiled inside a generated class body, where a `using` directive is not valid syntax. Remove the two `using` lines, change nothing else, add tests, and verify.
- **Outcome:** Implemented.
- **Branch / base commit:** staging @ c2874e6 (feat: Admin update flow with pre-update backup and carried-over check (phase 178))

---

## Part 1 — Audit

Full file, [resources/print-raw.ps1](../resources/print-raw.ps1) (before this change):

```powershell
<#
.SYNOPSIS
    Sends a file's raw bytes to a Windows printer queue (docs/phase-174).

.DESCRIPTION
    Bundled with the app (electron-builder.yml's extraResources) and run
    via execFile from windowsPrinter.ts's sendRawToWindowsPrinter, with
    -PrinterName and -DataPath as discrete arguments (never a shell
    string, so an untrusted printer name cannot inject a second
    command).

    Sends the bytes RAW via the Win32 winspool API, following Microsoft's
    "Sending Data Directly to a Printer": OpenPrinter, StartDocPrinter
    (pDatatype "RAW"), StartPagePrinter, WritePrinter, EndPagePrinter,
    EndDocPrinter, ClosePrinter.
    https://learn.microsoft.com/en-us/windows/win32/printdocs/sending-data-directly-to-a-printer

.PARAMETER PrinterName
    The OS queue name (PrinterInfo.name from getPrintersAsync()), never
    the display name.

.PARAMETER DataPath
    Path to the temp file holding the ESC/POS bytes to send.
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$PrinterName,

    [Parameter(Mandatory = $true)]
    [string]$DataPath
)

$ErrorActionPreference = 'Stop'

Add-Type -Namespace RubisPos -Name RawPrinter -MemberDefinition @'
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
public struct DOCINFOA
{
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
}

[DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Auto)]
public static extern bool OpenPrinter(string pPrinterName, out IntPtr phPrinter, IntPtr pDefault);

[DllImport("winspool.drv", SetLastError = true)]
public static extern bool ClosePrinter(IntPtr hPrinter);

[DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Auto)]
public static extern bool StartDocPrinter(IntPtr hPrinter, int level, ref DOCINFOA pDocInfo);

[DllImport("winspool.drv", SetLastError = true)]
public static extern bool EndDocPrinter(IntPtr hPrinter);

[DllImport("winspool.drv", SetLastError = true)]
public static extern bool StartPagePrinter(IntPtr hPrinter);

[DllImport("winspool.drv", SetLastError = true)]
public static extern bool EndPagePrinter(IntPtr hPrinter);

[DllImport("winspool.drv", SetLastError = true)]
public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);
'@

$bytes = [System.IO.File]::ReadAllBytes($DataPath)

$hPrinter = [IntPtr]::Zero
if (-not [RubisPos.RawPrinter]::OpenPrinter($PrinterName, [ref]$hPrinter, [IntPtr]::Zero)) {
    throw "Could not open printer '$PrinterName' (error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
}

try {
    $docInfo = New-Object RubisPos.RawPrinter+DOCINFOA
    $docInfo.pDocName = 'RUBIS POS Receipt'
    $docInfo.pOutputFile = $null
    $docInfo.pDataType = 'RAW'

    if (-not [RubisPos.RawPrinter]::StartDocPrinter($hPrinter, 1, [ref]$docInfo)) {
        throw "StartDocPrinter failed (error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
    }

    try {
        if (-not [RubisPos.RawPrinter]::StartPagePrinter($hPrinter)) {
            throw "StartPagePrinter failed (error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
        }

        try {
            $written = 0
            if (-not [RubisPos.RawPrinter]::WritePrinter($hPrinter, $bytes, $bytes.Length, [ref]$written)) {
                throw "WritePrinter failed (error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
            }
            if ($written -ne $bytes.Length) {
                throw "WritePrinter sent $written of $($bytes.Length) bytes"
            }
        } finally {
            [RubisPos.RawPrinter]::EndPagePrinter($hPrinter) | Out-Null
        }
    } finally {
        [RubisPos.RawPrinter]::EndDocPrinter($hPrinter) | Out-Null
    }
} finally {
    [RubisPos.RawPrinter]::ClosePrinter($hPrinter) | Out-Null
}
```

**Confirmed: the two `using` lines (`using System;` / `using System.Runtime.InteropServices;`) are the only content inside the `-MemberDefinition` here-string that is not a member declaration.** Line by line, everything else is one of:
- a `[StructLayout(...)]`-attributed `public struct DOCINFOA { ... }` — a member declaration, and
- six `[DllImport("winspool.drv", ...)]`-attributed `public static extern bool ...(...)` method signatures — also member declarations.

Blank lines aside, nothing else appears in the snippet.

**Confirmed: nothing else in the snippet needs a namespace beyond `System` and `System.Runtime.InteropServices`.** Every type the snippet references resolves under one of those two:

| Type/attribute used | Namespace |
| --- | --- |
| `StructLayout`, `LayoutKind` | `System.Runtime.InteropServices` |
| `MarshalAs`, `UnmanagedType` | `System.Runtime.InteropServices` |
| `DllImport` | `System.Runtime.InteropServices` |
| `IntPtr` | `System` |
| `bool`, `int`, `string`, `byte[]` | C# language keywords (aliases for `System.Boolean`/`System.Int32`/`System.String`/`System.Byte`) — never need a `using`, with or without one present |

This is exactly the set the cited Microsoft docs page (`Add-Type` — PowerShell 5.1) says `-MemberDefinition` already references implicitly: *"Add-Type references System.dll by default. When you use the MemberDefinition parameter, Add-Type also references System.Runtime.InteropServices."* No third namespace is needed anywhere in this snippet. **No STOP condition found — proceeding to Part 2.**

The two `using` lines are also the actual cause confirmed against the pilot till's error: `Add-Type` wraps `-MemberDefinition`'s text inside a generated `class RawPrinter { ... }` body before compiling it — `using` directives are only legal at file/namespace scope in C#, never inside a class body, so `csc.exe` rejected them as `Invalid token 'using' in class, struct, or interface member declaration`, exactly matching the pilot till's error output.

## Part 2 — Fix

### Changes made

1. **`resources/print-raw.ps1`** — removed the two `using` lines from the `-MemberDefinition` here-string. Added a six-line comment immediately above the `Add-Type` call explaining why no `using` lines are present, citing the Microsoft docs page. Nothing else changed — same parameters, same P/Invoke signatures, same `RAW` datatype, same error handling, byte-identical from `[StructLayout(...)]` onward:

   ```diff
   +# No `using` lines here: -MemberDefinition's snippet is compiled inside a
   +# generated class body, where a using directive is not valid syntax
   +# (docs/phase-179 — this broke Add-Type on a real till). Add-Type already
   +# references System, and System.Runtime.InteropServices when
   +# -MemberDefinition is used, so both are implicit.
   +# https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/add-type?view=powershell-5.1
    Add-Type -Namespace RubisPos -Name RawPrinter -MemberDefinition @'
   -using System;
   -using System.Runtime.InteropServices;
   -
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    public struct DOCINFOA
    {
   ```

   `-TypeDefinition` was not used — the smaller change (deleting two lines) wins, per the request.

2. **`tests/windowsPrinter.test.ts`** — added a string-check test (this file's own existing mocks for `child_process.execFile`/`fs/promises` mean the script body itself is never executed by any test here — see the new describe block's own comment): reads `resources/print-raw.ps1`, isolates the `@' ... '@` here-string, and asserts it contains no line starting with `"using "`.

### Tests

| File | Assertion |
| --- | --- |
| `tests/windowsPrinter.test.ts` | New describe block: the `-MemberDefinition` here-string in `resources/print-raw.ps1` has no line matching `/^using /m` |

### Mutation check (applied, verified, then reverted)

Added `using System;` back into the here-string. `tests/windowsPrinter.test.ts` failed as expected (`expected '...' not to match /^using /m`, showing the offending line). Reverted; `npx vitest run tests/windowsPrinter.test.ts` passed again (15/15), and `git diff -- resources/print-raw.ps1` shows only the intended permanent change (quoted above) — no mutation leaked through.

### Windows check

This session runs on Windows (Windows 11 Pro), so the manual check was run directly rather than deferred:

```
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File resources\print-raw.ps1 -PrinterName "Microsoft Print to PDF" -DataPath <small text file>
```

Result: **no `Add-Type` error.** The script ran straight past the `Add-Type` call — the original blocking error — and into the real winspool calls: `[RubisPos.RawPrinter]::OpenPrinter(...)` succeeded (execution reached the `try` block that only runs after a successful `OpenPrinter`). It then failed at `StartDocPrinter` with Win32 error 5 (`ERROR_ACCESS_DENIED`):

```
StartDocPrinter failed (error 5)
```

This is expected and unrelated to this fix: `Microsoft Print to PDF`'s own driver does not accept `RAW`-datatype print jobs sent directly via `winspool.drv` (it expects EMF spooling through the normal print pipeline, not a raw byte passthrough) — a known limitation of that specific virtual printer, not of this script or of real thermal printers using genuine RAW-capable drivers (the pilot till's actual failing printer, "PRINTER", is a real Windows print queue, not this virtual one). The one thing this check needed to prove — that `Add-Type` compiles the snippet without the `'using'` token error — is confirmed. `-DataPath` pointed at a one-line scratch text file; no PDF was produced (expected, given the `StartDocPrinter` failure), which the request's own wording allowed for ("a PDF save dialog or a PDF file is fine" — implying either is acceptable evidence, not that failure past that point invalidates the check of the actual regression under test).

### Tripwires

`git diff --stat` was empty for all five files: `printer.ts`, `windowsPrinter.ts`, `receiptLayout.ts`, `checkout.ts`, `index.ts`.

### Verification

- `npm run typecheck` (node + web) — clean.
- `npx vitest run tests/windowsPrinter.test.ts tests/printer.test.ts` (printer test files only, per the request — not the full suite) — **2 files, 50 tests, all passing.**
- `npx electron-vite build` — succeeded (main/preload/renderer all built).

### Affected files and functionality

| File | Change | Functionality affected |
| --- | --- | --- |
| `resources/print-raw.ps1` | Modified | Windows RAW printer queue path — `Add-Type` now compiles on a real till |
| `tests/windowsPrinter.test.ts` | Modified | Guards the here-string against a `using` line regressing |

### Possible impact

- **Direct:** every till printing to a Windows printer queue (`connectionType: 'windows'`, docs/phase-174) had every receipt print fail with this `Add-Type` compile error — this was a total outage of that print path, not a degraded one. This fix restores it.
- **Indirect:** none — `sendRawToWindowsPrinter`'s call site, argument handling, and temp-file lifecycle in `windowsPrinter.ts` are untouched (confirmed by the tripwire).
- **Data / schema / contract:** none.
- **Security posture:** unchanged — the removed lines carried no security meaning; `-PrinterName`/`-DataPath` are still passed as discrete `execFile` arguments (existing test coverage, untouched, still passes).
- **Idempotency / re-run safety:** unaffected — this script was already re-run per print job with no state carried between runs.
- **Residual risk:** the manual check above proves the compile error is gone but was run against a virtual PDF printer, not a real thermal printer over USB/COM/network. `docs/RELEASING.md`'s existing till-install step, or the pilot till directly, is the way to confirm an actual receipt prints end to end.

### Rollback

`git revert` of this commit restores the two `using` lines (and the compile failure).

### Observed but not changed

Nothing else was found needing a change — this was a two-line, single-cause fix with no adjacent findings.
