<#
tso-autostart.ps1 - keeps the TSO client running with the login the launcher stores.

Starts the community launcher (client.exe from fedorovvl/tso_client) with
--autologin, which reads the login from its own settings.dat, so this script
never sees a password. It waits while the game is in maintenance, restarts a
client that crashed or was dropped by the server, and backs off on failures.

  Game site 200            -> site up, try a login
  Game site 503 + marker   -> maintenance, keep waiting
  Anything else            -> unknown, keep waiting (no login attempts)

The site comes back well before the game (30+ minutes on 2026-10-30) and no
public endpoint tells the two apart, so only a login proves the game is up.
After maintenance the first login therefore waits -AfterMaintenanceSec, and a
login that brings up no game counts as a failure and is retried with back-off.

A client that exits with code 0 was closed by hand and stays closed, unless the
site is down at that moment. Use -RestartOnCleanExit to restart it regardless.
A CAPTCHA in the launcher is left open for the user; it is never answered here.

Usage (Windows PowerShell 5.1):
  powershell -ExecutionPolicy Bypass -File tools\tso-autostart.ps1
  powershell -ExecutionPolicy Bypass -File tools\tso-autostart.ps1 -CheckOnly

Log: <client>\steward\autostart\autostart-YYYY-MM-DD.log
Stop with Ctrl+C. Only one instance runs at a time (named mutex).
Exit codes: 0 stopped or -CheckOnly, 1 already running, 2 gave up after -MaxFailures.
#>
[CmdletBinding()]
param(
    [string]$ClientRoot = 'C:\Users\Roland\AppData\Local\tso_portable',
    # Holds one folder per launcher version; the newest with a settings.dat is used.
    [string]$LauncherRoot = 'C:\Users\Roland\TSOClient',
    [string]$StatusUrl = 'https://www.thesettlersonline.com/en/homepage',
    [string]$LogDir = '',
    # settings.json backup before each start, as SettlersOnline.ps1 does. Empty disables it.
    [string]$BackupDir = 'C:\Users\Roland\Desktop\Local\TSO_Backup',
    [int]$IntervalSec = 15,
    # Status poll while waiting for the game to come back, and while the client runs.
    [int]$StatusWaitSec = 120,
    [int]$StatusRunningSec = 300,
    # Restart delay and failure back-off: base, doubled per failure, capped at max.
    [int]$BackoffBaseSec = 120,
    [int]$BackoffMaxSec = 1800,
    # Wait after the site leaves maintenance, before the first login.
    [int]$AfterMaintenanceSec = 1800,
    # Consecutive failed starts before giving up (about 2.5 hours with the default
    # back-off). Each one is a real login attempt.
    [int]$MaxFailures = 8,
    # How long the launcher gets to bring up the game.
    [int]$LaunchTimeoutSec = 300,
    # A client that survives this long counts as a good start.
    [int]$StableSec = 600,
    [int]$CloseTimeoutSec = 60,
    # Consecutive maintenance answers before a running client is closed.
    [int]$CloseAfterHits = 2,
    [switch]$NoCloseOnMaintenance,
    [switch]$RestartOnCleanExit,
    # Print the status and what would be started, then exit.
    [switch]$CheckOnly,
    # Stop after this many loops (0 = run forever); for testing.
    [int]$MaxLoops = 0
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'tso-common.ps1')
$utf8 = New-Object Text.UTF8Encoding($true)

if (-not $LogDir) { $LogDir = Join-Path $ClientRoot 'steward\autostart' }
$ClientRoot = $ClientRoot.TrimEnd('\')
$gameName = 'client*.exe'
$captchaHost = 'msedgewebview2.exe'   # the launcher only uses WebView2 for its CAPTCHA window
$maintenanceMarker = '(?i)maintenance|gewartet'   # the English and German 503 pages
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Log([string]$msg, [string]$level = 'INFO') {
    $line = '{0} [{1}] {2}' -f (Stamp (Get-Date)), $level, $msg
    Write-Host $line
    $f = Join-Path $LogDir ('autostart-{0}.log' -f (Get-Date).ToString('yyyy-MM-dd'))
    [IO.File]::AppendAllText($f, $line + "`r`n", $utf8)
}

# One GET without following redirects, the same request a browser's first hit makes.
# State is 'up', 'maintenance' or 'unknown'; only 'up' ever leads to a login.
function Get-GameStatus {
    $resp = $null
    try {
        $req = [Net.HttpWebRequest]::Create($StatusUrl)
        $req.AllowAutoRedirect = $false
        $req.Timeout = 20000
        $req.ReadWriteTimeout = 20000
        $req.UserAgent = 'steward-tso-autostart'
        try { $resp = $req.GetResponse() }
        catch [Net.WebException] { $resp = $_.Exception.Response; if (-not $resp) { throw } }
        $code = [int]$resp.StatusCode
        if ($code -ge 200 -and $code -lt 300) { return @{ State = 'up'; Detail = "HTTP $code" } }
        if ($code -eq 503) {
            $body = (New-Object IO.StreamReader($resp.GetResponseStream())).ReadToEnd()
            if ($body -match $maintenanceMarker) { return @{ State = 'maintenance'; Detail = 'HTTP 503 maintenance page' } }
        }
        if ($code -ge 300 -and $code -lt 400) {
            $target = [string]$resp.Headers['Location']
            $sameHost = ($target -like '/*') -or ($target -like "https://$($req.RequestUri.Host)/*")
            if ($sameHost) { return @{ State = 'up'; Detail = "HTTP $code same-site redirect" } }
            return @{ State = 'unknown'; Detail = "HTTP $code redirect to another site" }
        }
        return @{ State = 'unknown'; Detail = "HTTP $code" }
    } catch {
        return @{ State = 'unknown'; Detail = $_.Exception.Message }
    } finally {
        if ($resp) { $resp.Close() }
    }
}

# Newest version folder that holds both the launcher and its stored login.
function Find-Launcher {
    $dirs = @(Get-ChildItem $LauncherRoot -Directory | Where-Object {
        (Test-Path (Join-Path $_.FullName 'client.exe')) -and (Test-Path (Join-Path $_.FullName 'settings.dat')) })
    $parsed = @($dirs | Where-Object { $_.Name -as [version] } | Sort-Object { [version]$_.Name } -Descending)
    if ($parsed.Count) { return $parsed[0].FullName }
    return $null
}

function Backup-Settings {
    $src = Join-Path $ClientRoot 'settings.json'
    if (-not $BackupDir -or -not (Test-Path $src)) { return }
    New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
    $backups = @(Get-ChildItem $BackupDir -Filter 'settings_*.json' | Sort-Object CreationTime -Descending)
    if ($backups.Count -and (Get-FileHash $src).Hash -eq (Get-FileHash $backups[0].FullName).Hash) { return }
    Copy-Item $src (Join-Path $BackupDir ('settings_{0}.json' -f (Get-Date).ToString('yyyyMMdd_HHmmss')))
    @($backups | Select-Object -Skip 9) | Remove-Item -Force
}

function Get-RetryDelay {
    $sec = [Math]::Min($BackoffMaxSec, $BackoffBaseSec * [Math]::Pow(2, [Math]::Max(0, $failures - 1)))
    return [int]($sec * (1 + (Get-Random -Minimum 0.0 -Maximum 0.15)))
}

function Add-Failure([string]$why) {
    $script:failures++
    $delay = Get-RetryDelay
    $script:nextTry = (Get-Date).AddSeconds($delay)
    Write-Log ('{0}; failure {1}/{2}, next try in {3} s' -f $why, $failures, $MaxFailures, $delay) 'WARN'
}

function Set-Status($s) {
    if ($s.State -ne $lastState) {
        Write-Log ('game status: {0} ({1})' -f $s.State, $s.Detail)
        if ($lastState -eq 'maintenance' -and $s.State -eq 'up') {
            $script:nextTry = (Get-Date).AddSeconds($AfterMaintenanceSec)
            Write-Log ('site is back; the game usually lags, first login at {0}' -f (Stamp $nextTry))
        }
        $script:lastState = $s.State
        $script:lastStateLog = Get-Date
    } elseif (((Get-Date) - $lastStateLog).TotalMinutes -ge 30) {
        Write-Log ('game status still {0} ({1})' -f $s.State, $s.Detail)
        $script:lastStateLog = Get-Date
    }
}

function Start-Launcher {
    $dir = Find-Launcher
    if (-not $dir) {
        Add-Failure "no launcher with a settings.dat under $LauncherRoot"
        return
    }
    try { Backup-Settings } catch { Write-Log "settings backup failed: $($_.Exception.Message)" 'WARN' }
    # settings.dat is opened relative to the working directory. --skip is left out
    # on purpose: maintenance is exactly when client.swf needs its update check.
    $p = Start-Process -FilePath (Join-Path $dir 'client.exe') -ArgumentList '--x64', '--autologin' -WorkingDirectory $dir -PassThru
    $script:launcher = @{ Proc = $p; Handle = $p.Handle; Deadline = (Get-Date).AddSeconds($LaunchTimeoutSec); Captcha = $false }
    Write-Log ('launcher started: pid={0} dir={1}' -f $p.Id, $dir)
}

function Watch-Launcher {
    $l = $launcher
    $l.Proc.Refresh()
    if ($l.Proc.HasExited) {
        # The launcher closes itself once it has started the game; allow a moment.
        if (-not $l.ContainsKey('GoneAt')) { $l.GoneAt = Get-Date; return }
        if (((Get-Date) - $l.GoneAt).TotalSeconds -lt 30) { return }
        $script:launcher = $null
        Add-Failure 'launcher exited without starting the game'
        return
    }
    if (@(Find-TsoProcesses $LauncherRoot | Where-Object { $_.Name -eq $captchaHost }).Count) {
        if (-not $l.Captcha) { Write-Log 'launcher shows a CAPTCHA: waiting for the user to solve it' 'WARN' }
        $l.Captcha = $true
        return
    }
    if ($l.Captcha) { $l.Captcha = $false; $l.Deadline = (Get-Date).AddSeconds($LaunchTimeoutSec) }
    if ((Get-Date) -lt $l.Deadline) { return }
    try { Stop-Process -Id $l.Proc.Id -Force } catch { }
    $script:launcher = $null
    Add-Failure "launcher stuck for $LaunchTimeoutSec s without a game client (login error or a dialog), closed it"
}

function Start-Tracking($cim) {
    $p = Get-Process -Id $cim.ProcessId -ErrorAction SilentlyContinue
    if (-not $p) { return }
    $h = [IntPtr]::Zero
    try { $h = $p.Handle } catch { }   # held open so ExitCode survives the exit
    $script:game = @{ Proc = $p; Handle = $h; Name = $cim.Name; Pid = $p.Id; Start = $p.StartTime }
    Write-Log ('client running: {0} pid={1} started={2}' -f $cim.Name, $p.Id, (Stamp $p.StartTime))
    if ($launcher) { $script:launcher = $null }
    $script:maintenanceHits = 0
    $script:nextRunCheck = (Get-Date).AddSeconds($StatusRunningSec)
    $script:manualClose = $false
}

function On-GameExit {
    $g = $game
    $script:game = $null
    $code = $null; $exitTime = Get-Date
    try { $code = $g.Proc.ExitCode } catch { }
    try { $exitTime = $g.Proc.ExitTime } catch { }
    $uptime = $exitTime - $g.Start
    Write-Log ('client exited: {0} pid={1} code={2} uptime={3:%d}d {3:hh\:mm\:ss}' -f $g.Name, $g.Pid, (Format-ExitCode $code), $uptime) $(if ($code -eq 0) { 'INFO' } else { 'WARN' })
    if ($closingForMaintenance) {
        $script:closingForMaintenance = $false
        $script:nextTry = Get-Date
        return
    }
    if ($code -eq 0 -and -not $RestartOnCleanExit) {
        $s = Get-GameStatus
        Set-Status $s
        if ($s.State -eq 'up') {
            $script:manualClose = $true
            Write-Log 'closed by hand while the game is up: not restarting until the client is started again'
            return
        }
    }
    if ($uptime.TotalSeconds -lt $StableSec) {
        Add-Failure ('client lasted only {0:0} s' -f $uptime.TotalSeconds)
    } else {
        $script:failures = 0
        $script:nextTry = (Get-Date).AddSeconds((Get-RetryDelay))
        Write-Log ('restart check at {0}' -f (Stamp $nextTry))
    }
}

# WM_CLOSE first, so the client can shut down the way the window's X button does.
function Close-Game {
    $script:closingForMaintenance = $true
    Write-Log ('maintenance confirmed {0} times: closing the client' -f $maintenanceHits) 'WARN'
    $targets = @(Find-TsoProcesses $ClientRoot $gameName -RootsOnly)
    foreach ($t in $targets) {
        $p = Get-Process -Id $t.ProcessId -ErrorAction SilentlyContinue
        if ($p) { [void]$p.CloseMainWindow() }
    }
    $deadline = (Get-Date).AddSeconds($CloseTimeoutSec)
    while ((Get-Date) -lt $deadline -and @(Find-TsoProcesses $ClientRoot $gameName -RootsOnly).Count) { Start-Sleep -Seconds 2 }
    foreach ($t in @(Find-TsoProcesses $ClientRoot $gameName -RootsOnly)) {
        Write-Log ('client pid={0} ignored the close request, stopping it' -f $t.ProcessId) 'WARN'
        Stop-Process -Id $t.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

if ($CheckOnly) {
    $s = Get-GameStatus
    Write-Host ('status:   {0} ({1}) from {2}' -f $s.State, $s.Detail, $StatusUrl)
    Write-Host ('launcher: {0}' -f (Find-Launcher))
    $running = @(Find-TsoProcesses $ClientRoot $gameName -RootsOnly)
    Write-Host ('client:   {0}' -f $(if ($running.Count) { 'running, pid ' + (($running | ForEach-Object { $_.ProcessId }) -join ', ') } else { 'not running' }))
    exit 0
}

$game = $null
$launcher = $null
$failures = 0
$nextTry = Get-Date
$nextRunCheck = Get-Date
$lastState = ''
$lastStateLog = Get-Date
$maintenanceHits = 0
$closingForMaintenance = $false
$manualClose = $false
$foreignLogged = $false
$loops = 0
$exitCode = 0

$mutex = New-Object Threading.Mutex($false, 'Local\steward-tso-autostart')
if (-not $mutex.WaitOne(0)) { Write-Host 'tso-autostart is already running; exiting.'; exit 1 }
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Write-Log ('autostart started: root={0} launchers={1} status={2}' -f $ClientRoot, $LauncherRoot, $StatusUrl)
    while ($true) {
        $loopStart = Get-Date
        try {
            if ($game) {
                $game.Proc.Refresh()
                if ($game.Proc.HasExited) { On-GameExit }
            }
            if (-not $game) {
                $found = @(Find-TsoProcesses $ClientRoot $gameName -RootsOnly | Sort-Object CreationDate)
                if ($found.Count) { Start-Tracking $found[0] }
            }
            if ($game) {
                if ($failures -and ((Get-Date) - $game.Start).TotalSeconds -ge $StableSec) { $failures = 0; Write-Log 'client stable: failure count reset' }
                if (-not $NoCloseOnMaintenance -and (Get-Date) -ge $nextRunCheck) {
                    $nextRunCheck = (Get-Date).AddSeconds($StatusRunningSec)
                    $s = Get-GameStatus
                    Set-Status $s
                    if ($s.State -eq 'maintenance') { $maintenanceHits++ } else { $maintenanceHits = 0 }
                    if ($maintenanceHits -ge $CloseAfterHits) { Close-Game }
                }
            } elseif ($launcher) {
                Watch-Launcher
            } elseif ($failures -ge $MaxFailures) {
                Write-Log "giving up after $failures failed starts; fix the login and start this script again" 'ERROR'
                $exitCode = 2
                break
            } elseif (-not $manualClose -and (Get-Date) -ge $nextTry) {
                # Never a second login next to a launcher someone has open: a new
                # login also ends any session started elsewhere.
                $open = @(Find-TsoProcesses $LauncherRoot 'client.exe' -RootsOnly)
                if ($open.Count) {
                    if (-not $foreignLogged) { Write-Log 'a launcher is already open: leaving it alone'; $foreignLogged = $true }
                } else {
                    $foreignLogged = $false
                    $s = Get-GameStatus
                    Set-Status $s
                    if ($s.State -eq 'up') { if ((Get-Date) -ge $nextTry) { Start-Launcher } }
                    else { $nextTry = (Get-Date).AddSeconds($StatusWaitSec * (1 + (Get-Random -Minimum 0.0 -Maximum 0.15))) }
                }
            }
        } catch {
            Write-Log "loop error: $($_.Exception.Message)" 'WARN'
        }
        $loops++
        if ($MaxLoops -gt 0 -and $loops -ge $MaxLoops) { break }
        $sleep = $IntervalSec - ((Get-Date) - $loopStart).TotalSeconds
        if ($sleep -gt 0) { Start-Sleep -Milliseconds ([int]($sleep * 1000)) }
    }
} finally {
    Write-Log 'autostart stopped'
    $mutex.ReleaseMutex(); $mutex.Dispose()
}
exit $exitCode
