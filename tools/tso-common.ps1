<#
tso-common.ps1 - helpers shared by tso-monitor.ps1 and tso-autostart.ps1.
Dot-source it; it only defines functions.
#>

$inv = [Globalization.CultureInfo]::InvariantCulture

function Stamp([datetime]$t) { return $t.ToString('yyyy-MM-dd HH:mm:ss', $inv) }

# Every process started from $Root whose exe matches $NameLike, plus their
# children unless -RootsOnly. CommandLine is deliberately not queried: the game
# process gets the auth token on its command line, and that must never be logged.
function Find-TsoProcesses([string]$Root, [string]$NameLike = '*', [switch]$RootsOnly) {
    $prefix = $Root.TrimEnd('\') + '\'
    $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, ExecutablePath, CreationDate)
    $roots = @($all | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -and
        $_.Name -like $NameLike })
    if ($RootsOnly) { return $roots }
    $ids = @{}
    foreach ($r in $roots) { $ids[[int]$r.ProcessId] = $r }
    # Children (and grandchildren) of matched processes, e.g. helpers spawned by AIR.
    $added = $true
    while ($added) {
        $added = $false
        foreach ($p in $all) {
            $pp = [int]$p.ParentProcessId
            if (-not $ids.ContainsKey([int]$p.ProcessId) -and $ids.ContainsKey($pp) -and $p.CreationDate -ge $ids[$pp].CreationDate) {
                $ids[[int]$p.ProcessId] = $p; $added = $true
            }
        }
    }
    return $ids.Values
}

function Format-ExitCode($code) {
    if ($null -eq $code) { return 'unknown' }
    # X8 on an Int32 prints the two's complement, i.e. the NTSTATUS as Windows shows it.
    $hex = ([int32]$code).ToString('X8', $inv)
    $hint = ''
    switch ($hex) {
        '00000000' { $hint = ' (normal exit)' }
        '00000001' { $hint = ' (killed/terminated, e.g. Task Manager)' }
        'FFFFFFFF' { $hint = ' (terminated by another process, e.g. Stop-Process)' }
        'C0000005' { $hint = ' (ACCESS_VIOLATION)' }
        'C00000FD' { $hint = ' (STACK_OVERFLOW)' }
        'C0000409' { $hint = ' (STACK_BUFFER_OVERRUN / fail-fast)' }
        'C0000017' { $hint = ' (NO_MEMORY)' }
        'C0000374' { $hint = ' (HEAP_CORRUPTION)' }
        'C000041D' { $hint = ' (FATAL_USER_CALLBACK_EXCEPTION)' }
        'E0434352' { $hint = ' (.NET exception)' }
        '80000003' { $hint = ' (BREAKPOINT)' }
        'C000013A' { $hint = ' (CTRL_C / console closed)' }
    }
    return ('{0} (0x{1}){2}' -f $code, $hex, $hint)
}
