# Phase 182 — print-raw.ps1: StartDocPrinter fails with error 1804 on a RAW-capable queue

- **Date:** 2026-09-29
- **Requested:** Part 1 (read-only): find why `StartDocPrinter` returns 1804 (`ERROR_INVALID_DATATYPE`) on the pilot till's queue, which accepts RAW (`POS`, driver "Generic / Text Only", port `USB001`, print processor `winprint`, datatype RAW). Then STOP.
- **Outcome:** Part 1 cause found and confirmed, then reviewed. Part 2 fixed, and proven byte for byte on a temporary Generic / Text Only queue on the development PC.
- **Branch / base commit:** staging @ 71a30f7 (fix: stop tills rejecting unsigned updates (phase 181))
- **Numbering:** the brief says `docs/phase-180.md`, but 180 (credentials out of the bundled `.env`) and 181 (2.1.0 build) already exist, so this is 182.

---

## The script

[resources/print-raw.ps1](../resources/print-raw.ps1), in full. It is unchanged since phase 179 (`git log`: 504fb5e, e1b7645).

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

# No `using` lines here: -MemberDefinition's snippet is compiled inside a
# generated class body, where a using directive is not valid syntax
# (docs/phase-179 — this broke Add-Type on a real till). Add-Type already
# references System, and System.Runtime.InteropServices when
# -MemberDefinition is used, so both are implicit.
# https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/add-type?view=powershell-5.1
Add-Type -Namespace RubisPos -Name RawPrinter -MemberDefinition @'
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

## 1. Each DllImport

None of them sets `EntryPoint` or `ExactSpelling`, so the runtime picks the exported name from `CharSet`.

| Function | Line | EntryPoint | CharSet | SetLastError | Export actually bound |
| --- | --- | --- | --- | --- | --- |
| `OpenPrinter` | 50-51 | none | `Auto` | true | `OpenPrinterW` (Unicode) |
| `ClosePrinter` | 53-54 | none | none (Ansi default) | true | `ClosePrinter` (no A/W variant; no strings) |
| `StartDocPrinter` | 56-57 | none | `Auto` | true | **`StartDocPrinterW`** (Unicode) |
| `EndDocPrinter` | 59-60 | none | none | true | `EndDocPrinter` (no strings) |
| `StartPagePrinter` | 62-63 | none | none | true | `StartPagePrinter` (no strings) |
| `EndPagePrinter` | 65-66 | none | none | true | `EndPagePrinter` (no strings) |
| `WritePrinter` | 68-69 | none | none | true | `WritePrinter` (`byte[]`, no strings) |

`CharSet.Auto` means Unicode on Windows: `Marshal.SystemDefaultCharSize` on this machine is `2`, and for a Unicode `CharSet` with `ExactSpelling` false the runtime binds the `W`-suffixed export first. So `OpenPrinter` and `StartDocPrinter` both call the wide-character (`W`) exports. `OpenPrinter` works because its only string, `pPrinterName`, is also marshalled as Unicode. That matches the till: `OpenPrinter` succeeded, and the script got as far as `StartDocPrinter`.

## 2. The DOC_INFO_1 struct

Lines 42-48:

- `[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]`, named `DOCINFOA`.
- Field order: `pDocName`, `pOutputFile`, `pDataType`, which matches Win32 `DOC_INFO_1` (`pDocName`, `pOutputFile`, `pDatatype`).
- **Every field carries `[MarshalAs(UnmanagedType.LPStr)]`**, meaning an ANSI, one-byte-per-character string. An explicit `MarshalAs` on a field overrides the struct's `CharSet`, so `CharSet.Auto` on the struct has no effect: all three strings are passed as ANSI.

## 3. Struct vs entry point: mismatched (this is the cause)

`StartDocPrinter` binds to **`StartDocPrinterW`**, which reads the struct as `DOC_INFO_1W` and expects each field to point at a UTF-16 string. The struct hands it pointers to **ANSI** strings (`LPStr`).

Confirmed on this machine by building the same struct in a throwaway PowerShell process and marshalling it exactly as the script does:

```
pDataType bytes as marshalled: 52 41 57 00 19 34
Read back as ANSI:    'RAW'
Read back as Unicode: '䅒W㐙觠껶䑁㥳耀' (chars: U+4152 U+0057 U+3419 U+89E0 ...)
Marshal.SystemDefaultCharSize (Auto -> 2 means Unicode): 2
```

`StartDocPrinterW` reads those bytes as UTF-16: `52 41` becomes `U+4152`, `57 00` becomes `U+0057`, then whatever memory follows until two zero bytes happen to appear. The spooler receives a datatype like `"䅒W㐙…"` instead of `"RAW"`, which no print processor (including `winprint`) supports, so it returns **1804 `ERROR_INVALID_DATATYPE`**. That matches the till exactly. The queue, driver and port are fine, as the brief's `Get-Printer` output already showed.

How it happened: the struct name `DOCINFOA` and the `LPStr` fields come from Microsoft's classic C# RAW-printing sample (KB322091). That sample pins the ANSI exports with `EntryPoint = "StartDocPrinterA"`, `CharSet = CharSet.Ansi` and `ExactSpelling = true`. Phase 174 kept the ANSI struct but replaced those three with `CharSet.Auto` and no entry point, which quietly switched the call to the wide export.

## 4. pOutputFile and pDatatype values

Correct. `pOutputFile = $null` (line 82) and `pDataType = 'RAW'` (line 83), exactly `"RAW"`. The value is right; its encoding is wrong (item 3).

## 5. How the struct is passed, and the level

Correct. It is passed `ref DOCINFOA pDocInfo` (line 57), which sends a pointer to the struct as `StartDocPrinter`'s `LPBYTE pDocInfo` expects, called as `StartDocPrinter($hPrinter, 1, [ref]$docInfo)` (line 85) with **level 1**. The level and the passing style are right; only the string encoding is wrong.

## Cause

One mismatch: `StartDocPrinter` is bound to the Unicode export (`CharSet.Auto`, no `EntryPoint`), but `DOC_INFO_1`'s strings are forced to ANSI (`MarshalAs(UnmanagedType.LPStr)` on each field). Windows reads a garbled `pDatatype` and returns 1804. Items 1, 4 and 5 are otherwise correct.

For Part 2, the brief's preferred shape (`CharSet.Unicode` on every string-bearing DllImport and on the struct, W entry points, `LPWStr`/no `LPStr` on the fields, level 1, `pOutputFile` null, `pDatatype` `"RAW"`) fixes exactly this. The fields' `MarshalAs(LPStr)` must go or become `LPWStr`; changing only the struct's `CharSet` would not work, because the field attributes override it.

## Correction to phase 179

`docs/phase-179.md` put the `StartDocPrinter` error 5 against "Microsoft Print to PDF" down to that driver not accepting RAW. That was an inference, and this audit weakens it: `Get-Printer` on this machine lists Microsoft Print to PDF with `Datatype RAW`. The error 5 more likely comes from its `PORTPROMPT:` port, which wants a save dialog the non-interactive run can't show, or from the same garbled datatype. Either way, that test never proved RAW printing works. Part 2's Windows check should not treat a Print to PDF failure as proof of anything.

## For Part 2: test queue on this machine

`Get-Printer` here shows only Fax, Microsoft Print to PDF, Microsoft XPS Document Writer and OneNote. There is **no Generic / Text Only queue**. A like-for-like check here would mean temporarily adding one (the built-in "Generic / Text Only" driver on a `FILE:` or local file port) and removing it afterwards. That changes this machine's printer setup, so it is your call. Otherwise the till is the real test.

**STOP — awaiting review before Part 2.**

---

## Part 2 — Fix

### Change

`resources/print-raw.ps1` only. Inside the `-MemberDefinition` here-string:

```diff
-[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
+// String fields must match the W entry points; a per-field LPStr overrides the struct's CharSet and caused error 1804 (docs/phase-182).
+[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
 public struct DOCINFOA
 {
-    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
-    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
-    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
+    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
+    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
+    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
 }

-[DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Auto)]
+[DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
 public static extern bool OpenPrinter(...);
 ...
-[DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Auto)]
+[DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
 public static extern bool StartDocPrinter(IntPtr hPrinter, int level, ref DOCINFOA pDocInfo);
```

Nothing else changed: the parameters, the other five DllImports, level 1, `pOutputFile = $null`, `pDataType = 'RAW'`, the write/verify loop and the error handling are identical. The comment is a C# `//` line, since the struct sits inside the here-string.

### Tests

`tests/windowsPrinter.test.ts`, new describe block `print-raw.ps1: DOC_INFO_1 strings match the Unicode entry point (docs/phase-182)`:

| Test | Asserts |
| --- | --- |
| marshals no string as LPStr (ANSI), only LPWStr | No non-comment line in the here-string matches `\bLPStr\b`, and exactly three lines use `UnmanagedType.LPWStr` |
| declares CharSet.Unicode on both DOC_INFO_1 and StartDocPrinter | The attribute line directly above `public struct DOCINFOA`, and the one above `extern bool StartDocPrinter(`, both contain `CharSet = CharSet.Unicode` |

One deviation from the brief's wording: "no line contains LPStr" is checked on non-comment lines only, because the required explanatory comment itself names `LPStr`. The `\bLPStr\b` pattern never matches `LPWStr`.

Mutation checks, each applied, run, then reverted by restoring the file:

| Mutation | Result |
| --- | --- |
| `pDataType` field back to `UnmanagedType.LPStr` | "marshals no string as LPStr" failed |
| Struct set to `CharSet = CharSet.Ansi` | "declares CharSet.Unicode on both" failed |
| After restoring | 17/17 pass; `git diff` shows only the intended change |

### Proof on a real RAW queue (development PC)

A temporary queue matching the till's (driver "Generic / Text Only", print processor `winprint`, datatype RAW), printing to a file so the output can be compared byte for byte. Scratch folder `C:\rubis-scratch`, outside the repo.

Setup:

```powershell
Add-PrinterPort -Name "C:\rubis-scratch\rawtest.prn"
Add-PrinterDriver -Name "Generic / Text Only"
Add-Printer -Name "RubisRawTest" -DriverName "Generic / Text Only" -PortName "C:\rubis-scratch\rawtest.prn"
```

`Get-Printer` confirmed: `DriverName Generic / Text Only`, `PrintProcessor winprint`, `Datatype RAW`.

Input: `C:\rubis-scratch\input.bin`, 35 bytes of ESC/POS-style data, including `ESC @`, text, `0x00`, `0x7F`, `0x80`, `0xFF`, `ESC a 1` and a `GS V 0` cut.

Run (each time):

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File resources\print-raw.ps1 -PrinterName RubisRawTest -DataPath C:\rubis-scratch\input.bin
```

| Script | Result |
| --- | --- |
| Before the fix | `StartDocPrinter failed (error 5)`, no output file. Same inside and outside the tool sandbox, so the sandbox was not the cause. |
| After the fix | Exit 0, print job completed, output file written |
| After the fix, rerun on the final file (post mutation reverts) | Exit 0, identical output again |

Hashes (`Get-FileHash`, SHA-256):

```
input.bin    E18EAB1C0B3BC7C61FC912CA8F58C2A297F543E4A19B1146A16DFB244755CA0C  35 bytes
rawtest.prn  E18EAB1C0B3BC7C61FC912CA8F58C2A297F543E4A19B1146A16DFB244755CA0C  35 bytes
```

Byte-identical: RAW passes through the spooler untouched, including the zero and high bytes.

On the error code: before the fix, the pilot till reported 1804 and this PC reported 5 on the same kind of queue. Why the codes differ is not established; this PC is Windows 11 build 26200, and the till's build is unknown. What is established is that this one change turned this PC's failure into a byte-identical print. Phase 179's error 5 against Microsoft Print to PDF was probably the same struct bug rather than that driver, but the fixed script was not re-run against Print to PDF, so that remains unproven.

Cleanup:

```powershell
Remove-Printer -Name RubisRawTest
Remove-PrinterPort -Name "C:\rubis-scratch\rawtest.prn"
```

Confirmed afterwards: printer gone, port gone, "Generic / Text Only" driver kept as instructed. `C:\rubis-scratch` still holds `input.bin` and `rawtest.prn`; they are harmless and can be deleted.

### Tripwires

`git diff --stat` empty for `src/main/services/printer.ts`, `src/main/services/windowsPrinter.ts`, `src/main/lib/receiptLayout.ts` (the file lives under `lib/`, not `services/`) and `src/main/services/checkout.ts`.

### Verification

- `npm run typecheck`: clean.
- `npx vitest run tests/windowsPrinter.test.ts tests/printer.test.ts`: 2 files, 52 tests, all passing. The printer test files only, per the brief.
- `npx electron-vite build`: succeeded.

The phase-174 tests mock `execFile`, so the script body only runs on Windows. The queue test above is the proof on this PC; on the till, the final check is the test slip from Admin > Peripherals > Printer.

### Observed but not changed

- The struct is still named `DOCINFOA`, and the trailing "A" (ANSI) is now misleading. Renaming it would also touch `New-Object RubisPos.RawPrinter+DOCINFOA` further down, which the brief ruled out ("change nothing else").

### Rollback

`git revert` this commit restores the ANSI fields and `CharSet.Auto`, and with them error 1804 on the till.
