#!/usr/bin/env pwsh
# =============================================================================
# copilot save-command strategy tests
#
# Exercises copilot.ps1 (the @resurrect-save-command-strategy 'copilot') against
# real, spawned stand-in processes: a cmd.exe copy named copilot.exe stands in
# for the copilot process, held alive under a parent that plays the pane. The
# pid->session map lives under an isolated temp HOME. No psmux needed.
#
#   pwsh -File psmux/strategies/save_command_strategies/copilot.Tests.ps1
# =============================================================================
$ErrorActionPreference = 'Continue'

$script:pass = 0; $script:fail = 0
function Check($name, $cond, $detail = '') {
    if ($cond) { Write-Host "  PASS: $name" -ForegroundColor Green; $script:pass++ }
    else { Write-Host "  FAIL: $name  $detail" -ForegroundColor Red; $script:fail++ }
}

$strategy = Join-Path $PSScriptRoot 'copilot.ps1'
Check "strategy script exists" (Test-Path $strategy) $strategy

$cmdExe = Join-Path $env:WINDIR 'System32\cmd.exe'
$tmp    = Join-Path $env:TEMP "copilot_strategy_test_$([guid]::NewGuid().ToString('N'))"
$binDir = Join-Path $tmp 'bin'
$sess   = Join-Path $tmp '.copilot\psmux-sessions'
New-Item -ItemType Directory -Force -Path $binDir,$sess | Out-Null
$env:USERPROFILE = $tmp                    # strategy reads $USERPROFILE\.copilot\psmux-sessions

# Stand-ins: copilot.exe (name matches the guard) and notcop.exe (does NOT
# contain "copilot", to prove the descendant name-validation).
$copilotExe = Join-Path $binDir 'copilot.exe'; Copy-Item $cmdExe $copilotExe
$notcopExe  = Join-Path $binDir 'notcop.exe';  Copy-Item $cmdExe $notcopExe

$spawned = [System.Collections.Generic.List[int]]::new()

function Spawn-Under-Pane($childExe, $childArgs = '') {
    # A "pane" process (cmd) that runs $childExe, which blocks on pause; returns
    # @{ Pane = <pid>; Child = <pid> }. The child is a descendant of the pane.
    # $childArgs is appended to the child's command line -- used to plant a
    # --resume=<id> argument for the command-line fallback tests.
    $inner = "`"$childExe`" /d /c pause"
    if ($childArgs) { $inner = "$inner $childArgs" }
    $pane = Start-Process $cmdExe -ArgumentList '/d','/c',$inner -PassThru -WindowStyle Hidden
    $script:spawned.Add($pane.Id)
    $child = 0
    for ($i = 0; $i -lt 20 -and $child -eq 0; $i++) {
        Start-Sleep -Milliseconds 200
        $c = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($pane.Id)" -EA SilentlyContinue |
             Where-Object { $_.ExecutablePath -eq $childExe } | Select-Object -First 1
        if ($c) { $child = [int]$c.ProcessId; $script:spawned.Add($child) }
    }
    return @{ Pane = $pane.Id; Child = $child }
}
function Seed($seedPid, $content) { Set-Content (Join-Path $sess "$seedPid") $content -NoNewline }
function Run-Strategy($command, $panePid) {
    (& (Get-Command pwsh).Source -NoProfile -ExecutionPolicy Bypass -File $strategy $command "$panePid" $tmp 2>&1 |
        Where-Object { $_ } | Select-Object -Last 1).ToString().Trim()
}
function Kill-Tree($info) {
    foreach ($p in @($info.Child, $info.Pane)) { if ($p) { Stop-Process -Id $p -Force -EA SilentlyContinue } }
}

$guid = [guid]::NewGuid().ToString()
try {
    # 1. copilot descendant + valid mapping -> clod --resume=<id>
    $i = Spawn-Under-Pane $copilotExe
    Check "spawned copilot stand-in under a pane process (pane=$($i.Pane) copilot=$($i.Child))" ($i.Child -gt 0)
    Seed $i.Child $guid
    Check "copilot pane with a mapping -> 'clod --resume=<id>'" `
        ((Run-Strategy 'clod' $i.Pane) -eq "clod --resume=$guid") "got: [$(Run-Strategy 'clod' $i.Pane)]"
    Kill-Tree $i

    # 2. non-copilot command -> passes through untouched (cheap guard, no walk)
    Check "non-copilot command passes through bare" ((Run-Strategy 'vim' $PID) -eq 'vim') "got: [$(Run-Strategy 'vim' $PID)]"

    # 3. copilot descendant but NO mapping -> bare
    $i = Spawn-Under-Pane $copilotExe
    Check "copilot pane with no mapping -> bare 'clod'" ((Run-Strategy 'clod' $i.Pane) -eq 'clod') "got: [$(Run-Strategy 'clod' $i.Pane)]"
    Kill-Tree $i

    # 4. mapping keyed to a NON-copilot descendant -> ignored (pid-reuse guard)
    $i = Spawn-Under-Pane $notcopExe
    Check "spawned non-copilot stand-in (notcop=$($i.Child))" ($i.Child -gt 0)
    Seed $i.Child $guid
    Check "mapping on a non-copilot process is ignored (name-validated) -> bare" `
        ((Run-Strategy 'clod' $i.Pane) -eq 'clod') "got: [$(Run-Strategy 'clod' $i.Pane)]"
    Kill-Tree $i

    # 5. copilot descendant but mapping is not a guid -> bare
    $i = Spawn-Under-Pane $copilotExe
    Seed $i.Child 'not-a-valid-guid'
    Check "non-guid mapping is rejected -> bare 'clod'" ((Run-Strategy 'clod' $i.Pane) -eq 'clod') "got: [$(Run-Strategy 'clod' $i.Pane)]"
    Kill-Tree $i

    # 6. copilot descendant, NO mapping, but --resume=<id> on its command line ->
    #    fallback reads the argument (covers a just-restored pane before its
    #    sessionStart hook has fired).
    $fg = [guid]::NewGuid().ToString()
    $i = Spawn-Under-Pane $copilotExe "--resume=$fg"
    Check "copilot pane, no mapping, --resume arg -> fallback 'clod --resume=<id>'" `
        ((Run-Strategy 'clod' $i.Pane) -eq "clod --resume=$fg") "got: [$(Run-Strategy 'clod' $i.Pane)]"
    Kill-Tree $i

    # 7. mapping (current) beats a stale --resume argument.
    $current = [guid]::NewGuid().ToString(); $stale = [guid]::NewGuid().ToString()
    $i = Spawn-Under-Pane $copilotExe "--resume=$stale"
    Seed $i.Child $current
    Check "mapping (current) wins over a stale --resume arg" `
        ((Run-Strategy 'clod' $i.Pane) -eq "clod --resume=$current") "got: [$(Run-Strategy 'clod' $i.Pane)]"
    Kill-Tree $i

    # 8. a mapping written before the copilot process started (a stale file left
    #    on a reused pid) is ignored; the --resume argument wins.
    $staleMap = [guid]::NewGuid().ToString(); $freshArg = [guid]::NewGuid().ToString()
    $i = Spawn-Under-Pane $copilotExe "--resume=$freshArg"
    Seed $i.Child $staleMap
    $created = (Get-CimInstance Win32_Process -Filter "ProcessId=$($i.Child)" -EA SilentlyContinue).CreationDate
    (Get-Item (Join-Path $sess "$($i.Child)")).LastWriteTime = $created.AddMinutes(-5)
    Check "mapping older than the process is ignored -> --resume fallback wins" `
        ((Run-Strategy 'clod' $i.Pane) -eq "clod --resume=$freshArg") "got: [$(Run-Strategy 'clod' $i.Pane)]"
    Kill-Tree $i

    # 9. no psmux-sessions directory at all -> the command-line fallback still works.
    Remove-Item $sess -Recurse -Force -ErrorAction SilentlyContinue
    $noDirArg = [guid]::NewGuid().ToString()
    $i = Spawn-Under-Pane $copilotExe "--resume=$noDirArg"
    Check "no psmux-sessions dir -> --resume fallback still works" `
        ((Run-Strategy 'clod' $i.Pane) -eq "clod --resume=$noDirArg") "got: [$(Run-Strategy 'clod' $i.Pane)]"
    Kill-Tree $i
    New-Item -ItemType Directory -Force -Path $sess | Out-Null
}
finally {
    foreach ($p in $script:spawned) { Stop-Process -Id $p -Force -EA SilentlyContinue }
    Get-CimInstance Win32_Process -EA SilentlyContinue |
        Where-Object { $_.ExecutablePath -like "$binDir*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }
    Remove-Item $tmp -Recurse -Force -EA SilentlyContinue
}

Write-Host "`n=== copilot save strategy: $script:pass passed, $script:fail failed ===" -ForegroundColor $(if($script:fail -eq 0){'Green'}else{'Red'})
exit $(if($script:fail -eq 0){0}else{1})
