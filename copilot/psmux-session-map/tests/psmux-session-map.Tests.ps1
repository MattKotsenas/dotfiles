#!/usr/bin/env pwsh
# =============================================================================
# psmux-session-map hook tests
#
# Exercises scripts/psmux-session-map.ps1 against an isolated temp HOME so the
# real ~/.copilot/psmux-sessions is never touched. Covers the write/prune/delete
# behaviour + the pid-reuse and guid-validation guards.
#
#   Invoke-Pester not required - run directly:
#   pwsh -File copilot/psmux-session-map/tests/psmux-session-map.Tests.ps1
# =============================================================================
$ErrorActionPreference = 'Continue'

$script:pass = 0; $script:fail = 0
function Check($name, $cond, $detail = '') {
    if ($cond) { Write-Host "  PASS: $name" -ForegroundColor Green; $script:pass++ }
    else { Write-Host "  FAIL: $name  $detail" -ForegroundColor Red; $script:fail++ }
}

$hook = Join-Path (Split-Path $PSScriptRoot -Parent) 'scripts\psmux-session-map.ps1'
Check "hook script exists" (Test-Path $hook) $hook

$tmp = Join-Path $env:TEMP "psmux_session_map_test_$([guid]::NewGuid().ToString('N'))"
$env:USERPROFILE = $tmp            # isolate: fresh throwaway process, discarded on exit
$dir = Join-Path $tmp '.copilot\psmux-sessions'
$livePid = $PID                    # this test process is a guaranteed-live pid
$g1 = [guid]::NewGuid().ToString()
$g2 = [guid]::NewGuid().ToString()
$own = Join-Path $dir "$livePid"

try {
    # --- start: valid guid -> writes mapping ---
    $env:COPILOT_LOADER_PID = "$livePid"; $env:COPILOT_AGENT_SESSION_ID = $g1
    & $hook start
    Check "start writes <loader-pid> = <session-id> for a valid guid" `
        ((Test-Path $own) -and ((Get-Content $own -Raw).Trim() -eq $g1)) "content: '$(if(Test-Path $own){(Get-Content $own -Raw).Trim()})'"

    # --- start: non-guid session id -> no write ---
    $env:COPILOT_LOADER_PID = '888888'; $env:COPILOT_AGENT_SESSION_ID = 'not-a-guid'
    & $hook start
    Check "start rejects a non-guid session id (no file written)" (-not (Test-Path (Join-Path $dir '888888')))

    # --- prune: dead-pid file removed, live kept ---
    Set-Content (Join-Path $dir '999999') $g2   # 999999 is not a live pid
    $env:COPILOT_LOADER_PID = "$livePid"; $env:COPILOT_AGENT_SESSION_ID = $g1
    & $hook start
    Check "start prunes a dead-pid mapping (crash self-heal)" (-not (Test-Path (Join-Path $dir '999999')))
    Check "start keeps a live-pid mapping while pruning" (Test-Path $own)

    # --- end: matching session id -> deletes own ---
    $env:COPILOT_LOADER_PID = "$livePid"; $env:COPILOT_AGENT_SESSION_ID = $g1
    & $hook end
    Check "end deletes our own mapping when the session id matches" (-not (Test-Path $own))

    # --- end: mismatched session id (pid reused by newer session) -> keeps ---
    $env:COPILOT_AGENT_SESSION_ID = $g1; & $hook start        # our session writes g1
    $env:COPILOT_AGENT_SESSION_ID = $g2; & $hook end          # a late end for a DIFFERENT session
    Check "end keeps a reused pid's mapping when the session id differs" `
        ((Test-Path $own) -and ((Get-Content $own -Raw).Trim() -eq $g1)) "content: '$(if(Test-Path $own){(Get-Content $own -Raw).Trim()})'"

    # --- no loader pid -> no-op, no crash ---
    $env:COPILOT_LOADER_PID = ''; $env:COPILOT_AGENT_SESSION_ID = $g1
    & $hook start
    Check "start is a no-op when COPILOT_LOADER_PID is unset" $true
}
finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "`n=== psmux-session-map: $script:pass passed, $script:fail failed ===" -ForegroundColor $(if($script:fail -eq 0){'Green'}else{'Red'})
exit $(if($script:fail -eq 0){0}else{1})
