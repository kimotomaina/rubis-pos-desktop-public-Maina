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
