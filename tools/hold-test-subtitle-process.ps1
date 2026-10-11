param(
    [Parameter(Mandatory = $true)][int]$NativePid,
    [Parameter(Mandatory = $true)][string]$ControlDirectory
)
$ErrorActionPreference = 'Stop'
# Test-only barrier: hold a real subtitle child of this isolated native host.
# Query ownership on the opened handle before suspending; never control other FFmpeg instances.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SubtitleBarrier {
    [StructLayout(LayoutKind.Sequential)]
    public struct BasicInfo {
        public IntPtr ExitStatus, Peb, Affinity, Priority, ProcessId, ParentId;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr process);
    [DllImport("kernel32.dll")]
    public static extern uint WaitForSingleObject(IntPtr process, uint milliseconds);
    [DllImport("kernel32.dll")]
    public static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("ntdll.dll")]
    public static extern int NtQueryInformationProcess(IntPtr process, int kind, out BasicInfo info, int size, out int length);
    [DllImport("ntdll.dll")]
    public static extern int NtSuspendProcess(IntPtr process);
    [DllImport("ntdll.dll")]
    public static extern int NtResumeProcess(IntPtr process);
    public static IntPtr OpenOwned(int pid, int parent) {
        IntPtr handle = OpenProcess(0x00100C01, false, pid);
        if (handle == IntPtr.Zero) return handle;
        BasicInfo info;
        int length;
        if (NtQueryInformationProcess(handle, 0, out info, Marshal.SizeOf(typeof(BasicInfo)), out length) != 0 ||
            info.ParentId.ToInt64() != parent || info.ProcessId.ToInt64() != pid) {
            CloseHandle(handle);
            return IntPtr.Zero;
        }
        return handle;
    }
}
'@
$seen = [System.Collections.Generic.HashSet[int]]::new()
$deadline = [DateTime]::UtcNow.AddSeconds(30)
$stopFile = Join-Path $ControlDirectory 'stop'
[IO.File]::WriteAllText((Join-Path $ControlDirectory 'ready'), 'ready')
try {
    while ([DateTime]::UtcNow -lt $deadline -and -not (Test-Path -LiteralPath $stopFile)) {
        foreach ($candidate in [Diagnostics.Process]::GetProcessesByName('ffmpeg')) {
            $handle = [IntPtr]::Zero
            $suspended = $false
            try {
                $candidateId = $candidate.Id
                if ($seen.Contains($candidateId)) { continue }
                $handle = [SubtitleBarrier]::OpenOwned($candidateId, $NativePid)
                if ($handle -eq [IntPtr]::Zero) { continue }
                if ([SubtitleBarrier]::NtSuspendProcess($handle) -ne 0) { continue }
                $suspended = $true
                $null = $seen.Add($candidateId)
                $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$candidateId" -OperationTimeoutSec 5
                if ($processInfo.CommandLine -notmatch 'subtitle-publish-\d+\.vtt') { continue }
                $marker = @{ pid = $candidateId; parent = $NativePid; commandLine = $processInfo.CommandLine } | ConvertTo-Json -Compress
                [IO.File]::WriteAllText((Join-Path $ControlDirectory 'held.json'), $marker)
                while ([DateTime]::UtcNow -lt $deadline -and -not (Test-Path -LiteralPath $stopFile) -and
                    [SubtitleBarrier]::WaitForSingleObject($handle, 0) -eq 258) {
                    Start-Sleep -Milliseconds 10
                }
                if ((Test-Path -LiteralPath $stopFile) -and [SubtitleBarrier]::WaitForSingleObject($handle, 0) -eq 258) {
                    if (-not [SubtitleBarrier]::TerminateProcess($handle, 1)) { throw 'Owned subtitle process cleanup failed' }
                }
                return
            } finally {
                if ($handle -ne [IntPtr]::Zero) {
                    if ($suspended) { $null = [SubtitleBarrier]::NtResumeProcess($handle) }
                    $null = [SubtitleBarrier]::CloseHandle($handle)
                }
                $candidate.Dispose()
            }
        }
        Start-Sleep -Milliseconds 1
    }
    if (-not (Test-Path -LiteralPath $stopFile)) { throw 'No owned subtitle process reached the barrier' }
} catch {
    [IO.File]::WriteAllText((Join-Path $ControlDirectory 'error'), $_.ToString())
    throw
}
