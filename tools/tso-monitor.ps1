<#
tso-monitor.ps1 - standalone crash/resource monitor for the TSO AIR client.

Runs outside the client and samples every process started from the client
folder (client.exe / client64.exe and any child processes) so that after a
crash we can tell from the trend whether steward (memory/GDI growth, log
spam) or something else (WER fault, system memory pressure) was involved.

Usage (Windows PowerShell 5.1):
  powershell -ExecutionPolicy Bypass -File tools\tso-monitor.ps1
  powershell -ExecutionPolicy Bypass -File tools\tso-monitor.ps1 -IntervalSec 30 -LogDir D:\tso-mon

Output in -LogDir (default <client>\steward\monitor\):
  samples-YYYY-MM-DD.csv   one row per process per sample (daily rotation)
  events-YYYY-MM-DD.log    start/exit, exit codes, warnings, crash summaries
  crash-*.txt              per-exit snapshot: last samples, console.log tail,
                           Application event log entries, WER reports, dumps
Stop with Ctrl+C. Only one instance runs at a time (named mutex).
#>
[CmdletBinding()]
param(
    [int]$IntervalSec = 15,
    [string]$ClientRoot = 'C:\Users\Roland\AppData\Local\tso_portable',
    [string]$LogDir = '',
    # Wildcard on the exe name, e.g. 'client64.exe'. Children are always included.
    [string]$ProcessName = '*',
    [int]$WarnPrivateMB = 3000,
    [int]$WarnGuiObjects = 8000,
    [double]$LeakMBPerHour = 150,
    [int]$LeakWindowMin = 30,
    [int]$ConsoleTailLines = 200,
    [int]$SnapshotSamples = 20,
    # Seconds to wait after an exit before querying the event log / WER (WER writes late).
    [int]$CrashQueryDelaySec = 45,
    # Stop after this many sample rounds (0 = run forever); for testing.
    [int]$MaxSamples = 0
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'tso-common.ps1')
$utf8 = New-Object Text.UTF8Encoding($true)   # BOM so PS 5.1 / Excel read umlauts from the event log

if (-not $LogDir) { $LogDir = Join-Path $ClientRoot 'steward\monitor' }
$ClientRoot = $ClientRoot.TrimEnd('\')
$consoleLog = Join-Path $ClientRoot 'steward\logs\console.log'
$crashDumpDir = Join-Path $env:LOCALAPPDATA 'CrashDumps'
$werDirs = @(
    (Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\WER\ReportArchive'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\WER\ReportQueue'),
    (Join-Path $env:ProgramData 'Microsoft\Windows\WER\ReportArchive'),
    (Join-Path $env:ProgramData 'Microsoft\Windows\WER\ReportQueue')
)
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TsoMonNative {
    [DllImport("user32.dll")] public static extern uint GetGuiResources(IntPtr hProcess, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool IsWow64Process(IntPtr hProcess, out bool wow64);
    [StructLayout(LayoutKind.Sequential)]
    public struct PERFINFO {
        public uint cb; public UIntPtr CommitTotal, CommitLimit, CommitPeak, PhysicalTotal, PhysicalAvailable,
            SystemCache, KernelTotal, KernelPaged, KernelNonpaged, PageSize;
        public uint HandleCount, ProcessCount, ThreadCount;
    }
    [DllImport("psapi.dll", SetLastError = true)] public static extern bool GetPerformanceInfo(out PERFINFO pi, uint cb);
    public static double[] SysMemMB() {
        PERFINFO pi; uint cb = (uint)Marshal.SizeOf(typeof(PERFINFO));
        if (!GetPerformanceInfo(out pi, cb)) return null;
        double pg = (double)pi.PageSize.ToUInt64() / 1048576.0;
        return new double[] { pi.PhysicalAvailable.ToUInt64() * pg, pi.PhysicalTotal.ToUInt64() * pg,
                              pi.CommitTotal.ToUInt64() * pg, pi.CommitLimit.ToUInt64() * pg };
    }
}
'@

function Fmt([double]$v, [string]$f = '0.0') { return $v.ToString($f, $inv) }

function Write-Event([string]$msg, [string]$level = 'INFO') {
    $line = '{0} [{1}] {2}' -f (Stamp (Get-Date)), $level, $msg
    Write-Host $line
    $f = Join-Path $LogDir ('events-{0}.log' -f (Get-Date).ToString('yyyy-MM-dd'))
    [IO.File]::AppendAllText($f, $line + "`r`n", $utf8)
}

$csvHeader = 'Timestamp,PID,Name,UptimeSec,WorkingSetMB,PrivateMB,VirtualMB,PeakWorkingSetMB,Handles,Threads,CpuPct,GdiObjects,UserObjects,Responding,SysFreePhysMB,SysCommitMB,SysCommitLimitMB,ConsoleLogKB,ConsoleLogDeltaKB'

function Write-Sample([string]$line) {
    $f = Join-Path $LogDir ('samples-{0}.csv' -f (Get-Date).ToString('yyyy-MM-dd'))
    if (-not (Test-Path $f)) { [IO.File]::AppendAllText($f, $csvHeader + "`r`n", $utf8) }
    [IO.File]::AppendAllText($f, $line + "`r`n", $utf8)
}

# Reads the tail of a file even while another process holds it open.
function Get-Tail([string]$path, [int]$n) {
    if (-not (Test-Path $path)) { return @("(missing: $path)") }
    $fs = New-Object IO.FileStream($path, 'Open', 'Read', 'ReadWrite, Delete')
    try {
        $want = [Math]::Min($fs.Length, [long]($n * 400))
        $fs.Seek(-$want, 'End') | Out-Null
        $buf = New-Object byte[] $want
        $read = $fs.Read($buf, 0, $want)
        $lines = [Text.Encoding]::UTF8.GetString($buf, 0, $read) -split "`r?`n"
        if ($want -lt $fs.Length) { $lines = $lines | Select-Object -Skip 1 }
        return @($lines | Select-Object -Last $n)
    } finally { $fs.Dispose() }
}

$tracked = @{}     # key "pid@starttime" -> state
$pending = New-Object System.Collections.ArrayList
$sampleNo = 0
$waitingLogged = $false
$lastConsoleBytes = -1
$sysWarn = @{ Name = 'system'; Pid = '-'; Warned = @{} }

function Start-Tracking($cim) {
    $p = Get-Process -Id $cim.ProcessId -ErrorAction SilentlyContinue
    if (-not $p) { return }
    $h = [IntPtr]::Zero
    try { $h = $p.Handle } catch { }   # held open so ExitCode survives the exit
    $bits = '?'
    if ($h -ne [IntPtr]::Zero -and [Environment]::Is64BitOperatingSystem) {
        $wow = $false
        if ([TsoMonNative]::IsWow64Process($h, [ref]$wow)) { if ($wow) { $bits = '32' } else { $bits = '64' } }
    }
    $start = $p.StartTime
    $key = '{0}@{1}' -f $p.Id, $start.Ticks
    if ($tracked.ContainsKey($key)) { return }
    $tracked[$key] = @{
        Proc = $p; Handle = $h; Name = $cim.Name; Path = $cim.ExecutablePath; Pid = $p.Id; Start = $start
        Bits = $bits; LastCpu = $p.TotalProcessorTime; LastTime = Get-Date
        Ring = New-Object System.Collections.ArrayList; Warned = @{}
    }
    Write-Event ('START {0} pid={1} bits={2} started={3} parent={4} path={5}' -f $cim.Name, $p.Id, $bits, (Stamp $start), $cim.ParentProcessId, $cim.ExecutablePath)
    if ($bits -eq '32') {
        Write-Event ('{0} pid={1} is a 32-bit process: user address space is ~2 GB (4 GB if large-address-aware); out-of-memory crashes show up as VirtualMB near that limit.' -f $cim.Name, $p.Id) 'NOTE'
    }
}

function Warn-Once($st, [string]$kind, [string]$msg, [int]$everyMin = 30) {
    $now = Get-Date
    if ($st.Warned.ContainsKey($kind) -and ($now - $st.Warned[$kind]).TotalMinutes -lt $everyMin) { return }
    $st.Warned[$kind] = $now
    Write-Event ('{0} pid={1}: {2}' -f $st.Name, $st.Pid, $msg) 'WARN'
}

function Check-Warnings($st, $s) {
    if ($s.PrivateMB -ge $WarnPrivateMB) { Warn-Once $st 'private' ('private bytes {0} MB >= {1} MB' -f (Fmt $s.PrivateMB), $WarnPrivateMB) }
    if ($st.Bits -eq '32') {
        $pct = $s.VirtualMB / 2048 * 100
        if ($pct -ge 75) { Warn-Once $st 'va32' ('virtual size {0} MB = {1}% of the 2 GB 32-bit address space' -f (Fmt $s.VirtualMB), (Fmt $pct '0')) }
    }
    if ($s.Gdi -is [int] -and $s.Gdi -ge $WarnGuiObjects) { Warn-Once $st 'gdi' ('GDI objects {0} (per-process limit 10000)' -f $s.Gdi) }
    if ($s.User -is [int] -and $s.User -ge $WarnGuiObjects) { Warn-Once $st 'user' ('USER objects {0} (per-process limit 10000)' -f $s.User) }
    if (-not $s.Responding) { Warn-Once $st 'hang' 'main window not responding' 5 }
    # Leak indicator: least-squares slope of private bytes over the last LeakWindowMin minutes.
    $cut = (Get-Date).AddMinutes(-$LeakWindowMin)
    $win = @($st.Ring | Where-Object { $_.Time -ge $cut })
    if ($win.Count -lt 5) { return }
    $span = ($win[-1].Time - $win[0].Time).TotalMinutes
    if ($span -lt $LeakWindowMin * 0.9) { return }
    $t0 = $win[0].Time; $n = $win.Count; $sx = 0.0; $sy = 0.0; $sxx = 0.0; $sxy = 0.0
    foreach ($w in $win) { $x = ($w.Time - $t0).TotalHours; $y = $w.PrivateMB; $sx += $x; $sy += $y; $sxx += $x * $x; $sxy += $x * $y }
    $den = $n * $sxx - $sx * $sx
    if ($den -le 0) { return }
    $slope = ($n * $sxy - $sx * $sy) / $den
    if ($slope -ge $LeakMBPerHour -and $win[-1].PrivateMB -gt $win[0].PrivateMB) {
        Warn-Once $st 'leak' ('private bytes growing {0} MB/h over the last {1} min ({2} -> {3} MB): possible leak' -f (Fmt $slope '0'), $LeakWindowMin, (Fmt $win[0].PrivateMB '0'), (Fmt $win[-1].PrivateMB '0'))
    }
}

function Take-Sample($st, $sys, $consoleKB, $consoleDelta) {
    $p = $st.Proc
    $p.Refresh()
    $now = Get-Date
    $cpu = $p.TotalProcessorTime
    $dt = ($now - $st.LastTime).TotalSeconds
    $cpuPct = 0.0
    if ($dt -gt 0) { $cpuPct = ($cpu - $st.LastCpu).TotalSeconds / $dt / [Environment]::ProcessorCount * 100 }
    $st.LastCpu = $cpu; $st.LastTime = $now
    $gdi = ''; $user = ''
    if ($st.Handle -ne [IntPtr]::Zero) {
        $gdi = [int][TsoMonNative]::GetGuiResources($st.Handle, 0)
        $user = [int][TsoMonNative]::GetGuiResources($st.Handle, 1)
    }
    $responding = $true
    try { $responding = $p.Responding } catch { }
    $s = @{
        Time = $now; PrivateMB = $p.PrivateMemorySize64 / 1MB; VirtualMB = $p.VirtualMemorySize64 / 1MB
        Gdi = $gdi; User = $user; Responding = $responding; SysCommitMB = $sys[2]; SysCommitLimitMB = $sys[3]
    }
    $line = @(
        (Stamp $now), $st.Pid, $st.Name, (Fmt ($now - $st.Start).TotalSeconds '0'),
        (Fmt ($p.WorkingSet64 / 1MB)), (Fmt $s.PrivateMB), (Fmt $s.VirtualMB), (Fmt ($p.PeakWorkingSet64 / 1MB)),
        $p.HandleCount, $p.Threads.Count, (Fmt $cpuPct), $gdi, $user, $responding,
        (Fmt $sys[0] '0'), (Fmt $sys[2] '0'), (Fmt $sys[3] '0'), $consoleKB, $consoleDelta
    ) -join ','
    Write-Sample $line
    $s.Line = $line
    [void]$st.Ring.Add($s)
    $keep = [Math]::Max($SnapshotSamples, [int]($LeakWindowMin * 60 / $IntervalSec) + 2)
    while ($st.Ring.Count -gt $keep) { $st.Ring.RemoveAt(0) }
    Check-Warnings $st $s
}

function On-Exit($key, $st) {
    $p = $st.Proc
    $code = $null; $exitTime = Get-Date
    try { $code = $p.ExitCode } catch { }
    try { $exitTime = $p.ExitTime } catch { }
    $uptime = $exitTime - $st.Start
    Write-Event ('EXIT {0} pid={1} code={2} at={3} uptime={4:%d}d {4:hh\:mm\:ss}' -f $st.Name, $st.Pid, (Format-ExitCode $code), (Stamp $exitTime), $uptime) $(if ($code -eq 0) { 'INFO' } else { 'WARN' })
    $file = Join-Path $LogDir ('crash-{0}-{1}-{2}.txt' -f $exitTime.ToString('yyyyMMdd-HHmmss'), $st.Name, $st.Pid)
    $sb = New-Object Text.StringBuilder
    [void]$sb.AppendLine("Exit snapshot for $($st.Name) pid=$($st.Pid) ($($st.Bits)-bit) $($st.Path)")
    [void]$sb.AppendLine("Started $(Stamp $st.Start), exited $(Stamp $exitTime), exit code $(Format-ExitCode $code)")
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine("=== Last $SnapshotSamples samples ===")
    [void]$sb.AppendLine($csvHeader)
    foreach ($s in @($st.Ring | Select-Object -Last $SnapshotSamples)) { [void]$sb.AppendLine($s.Line) }
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine("=== Last $ConsoleTailLines lines of $consoleLog ===")
    try { foreach ($l in (Get-Tail $consoleLog $ConsoleTailLines)) { [void]$sb.AppendLine($l) } }
    catch { [void]$sb.AppendLine("(could not read: $($_.Exception.Message))") }
    [IO.File]::WriteAllText($file, $sb.ToString(), $utf8)
    Write-Event "snapshot written: $file (event log / WER details follow in ~$CrashQueryDelaySec s)"
    if ($st.Handle -ne [IntPtr]::Zero) { $p.Dispose() }
    [void]$pending.Add(@{ Due = (Get-Date).AddSeconds($CrashQueryDelaySec); ExitTime = $exitTime; Name = $st.Name; Pid = $st.Pid; File = $file; Code = $code })
}

function Complete-CrashReport($c) {
    $from = $c.ExitTime.AddMinutes(-3); $to = Get-Date
    $exe = $c.Name
    $sb = New-Object Text.StringBuilder
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine("=== Application event log $(Stamp $from) .. $(Stamp $to) ===")
    $hits = 0
    try {
        $evs = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $from; EndTime = $to } -ErrorAction SilentlyContinue)
        foreach ($e in $evs) {
            $prov = [string]$e.ProviderName
            $msg = [string]$e.Message
            $isFault = ($e.Id -in 1000, 1001, 1002, 1005) -and ($prov -match 'Application Error|Windows Error Reporting|Application Hang')
            $isRuntime = $prov -match '\.NET Runtime|Adobe|AIR|Flash|SideBySide'
            $mentions = $msg -match [regex]::Escape($exe) -or $msg -match ('\b' + $c.Pid + '\b') -or $msg -match 'Adobe AIR'
            if (($isFault -or $isRuntime) -and ($mentions -or $isRuntime)) {
                $hits++
                [void]$sb.AppendLine(('--- {0} [{1}] {2} id={3}' -f (Stamp $e.TimeCreated), $e.LevelDisplayName, $prov, $e.Id))
                [void]$sb.AppendLine($msg.Trim())
            }
        }
    } catch { [void]$sb.AppendLine("(event log query failed: $($_.Exception.Message))") }
    if ($hits -eq 0) { [void]$sb.AppendLine('(no matching Application Error / WER / runtime entries)') }

    [void]$sb.AppendLine('')
    [void]$sb.AppendLine("=== Crash dumps in $crashDumpDir since $(Stamp $from) ===")
    $dumps = @()
    if (Test-Path $crashDumpDir) { $dumps = @(Get-ChildItem $crashDumpDir -File | Where-Object { $_.LastWriteTime -ge $from }) }
    if ($dumps.Count) { foreach ($d in $dumps) { [void]$sb.AppendLine(('{0}  {1} KB  {2}' -f $d.FullName, [int]($d.Length / 1KB), (Stamp $d.LastWriteTime))) } }
    else { [void]$sb.AppendLine('(none; LocalDumps is probably not enabled, see tools/README.md)') }

    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('=== WER reports since exit ===')
    $reps = @()
    foreach ($w in $werDirs) {
        if (Test-Path $w) { $reps += @(Get-ChildItem $w -Directory -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -ge $from -and $_.Name -like "*$exe*" }) }
    }
    if ($reps.Count) { foreach ($r in $reps) { [void]$sb.AppendLine($r.FullName) } } else { [void]$sb.AppendLine('(none)') }
    [IO.File]::AppendAllText($c.File, $sb.ToString(), $utf8)
    Write-Event ('crash report for {0} pid={1}: {2} event log entries, {3} dumps, {4} WER reports -> {5}' -f $exe, $c.Pid, $hits, $dumps.Count, $reps.Count, $c.File) $(if ($hits + $dumps.Count + $reps.Count) { 'WARN' } else { 'INFO' })
}

$mutex = New-Object Threading.Mutex($false, 'Local\steward-tso-monitor')
if (-not $mutex.WaitOne(0)) { Write-Host 'tso-monitor is already running; exiting.'; exit 1 }
try {
    $sys = [TsoMonNative]::SysMemMB()
    Write-Event ('monitor started: interval={0}s root={1} logs={2} RAM={3} MB commit limit={4} MB, PowerShell {5}' -f $IntervalSec, $ClientRoot, $LogDir, (Fmt $sys[1] '0'), (Fmt $sys[3] '0'), $PSVersionTable.PSVersion)
    while ($true) {
        $loopStart = Get-Date
        $found = @()
        try { $found = @(Find-TsoProcesses $ClientRoot $ProcessName) } catch { Write-Event "process scan failed: $($_.Exception.Message)" 'WARN' }
        foreach ($cim in $found) {
            $known = $false
            foreach ($st in $tracked.Values) { if ($st.Pid -eq [int]$cim.ProcessId) { $known = $true } }
            if (-not $known) {
                try { Start-Tracking $cim } catch { Write-Event ('cannot track pid={0}: {1}' -f $cim.ProcessId, $_.Exception.Message) 'WARN' }
            }
        }
        foreach ($key in @($tracked.Keys)) {
            $st = $tracked[$key]
            $st.Proc.Refresh()
            if ($st.Proc.HasExited) {
                try { On-Exit $key $st } catch { Write-Event ('exit handling failed for pid={0}: {1}' -f $st.Pid, $_.Exception.Message) 'WARN' }
                $tracked.Remove($key)
            }
        }
        $consoleKB = ''; $consoleDelta = ''
        if (Test-Path $consoleLog) {
            $bytes = (Get-Item $consoleLog).Length
            $consoleKB = Fmt ($bytes / 1KB)
            if ($lastConsoleBytes -ge 0) { $consoleDelta = Fmt (($bytes - $lastConsoleBytes) / 1KB) }
            $lastConsoleBytes = $bytes
        }
        if ($tracked.Count) {
            $waitingLogged = $false
            $sys = [TsoMonNative]::SysMemMB()
            if ($sys[3] -gt 0 -and $sys[2] / $sys[3] -ge 0.9) {
                Warn-Once $sysWarn 'commit' ('commit charge {0}/{1} MB (>= 90%), free physical {2} MB' -f (Fmt $sys[2] '0'), (Fmt $sys[3] '0'), (Fmt $sys[0] '0'))
            }
            foreach ($st in @($tracked.Values)) {
                try { Take-Sample $st $sys $consoleKB $consoleDelta }
                catch { Write-Event ('sample failed for pid={0}: {1}' -f $st.Pid, $_.Exception.Message) 'WARN' }
            }
        } elseif (-not $waitingLogged) {
            Write-Event "waiting for a client process under $ClientRoot ..."
            $waitingLogged = $true
        }
        foreach ($c in @($pending)) {
            if ((Get-Date) -ge $c.Due) {
                try { Complete-CrashReport $c } catch { Write-Event "crash report failed: $($_.Exception.Message)" 'WARN' }
                $pending.Remove($c)
            }
        }
        $sampleNo++
        if ($MaxSamples -gt 0 -and $sampleNo -ge $MaxSamples -and $pending.Count -eq 0) { break }
        $sleep = $IntervalSec - ((Get-Date) - $loopStart).TotalSeconds
        if ($sleep -gt 0) { Start-Sleep -Milliseconds ([int]($sleep * 1000)) }
    }
} finally {
    Write-Event 'monitor stopped'
    $mutex.ReleaseMutex(); $mutex.Dispose()
}
