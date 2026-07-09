#!/usr/bin/env pwsh
# =============================================================================
# psmux-session-map hook tests
#
# Exercises scripts/psmux-session-map.ps1 against an isolated temp HOME so the
# real ~/.copilot/psmux-sessions is never touched. Covers guid validation,
# write/prune/delete, the pid-reuse guard, and the stdin-JSON session-id path.
#
# Pid seam: COPILOT_LOADER_PID names the copilot pid when set to a live process
# (empty in real hooks, where the nearest 'copilot' ancestor is used instead).
# The tests set it to a live pid so the file logic is exercised hermetically;
# the ancestry derivation is covered by live end-to-end verification.
#
#   Run directly (manual):
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
    # --- start: valid guid -> writes mapping keyed by the (live) copilot pid ---
    $env:COPILOT_LOADER_PID = "$livePid"; $env:COPILOT_AGENT_SESSION_ID = $g1
    & $hook start
    Check "start writes <copilot-pid> = <session-id> for a valid guid" `
        ((Test-Path $own) -and ((Get-Content $own -Raw).Trim() -eq $g1)) "content: '$(if(Test-Path $own){(Get-Content $own -Raw).Trim()})'"

    # --- start: non-guid session id -> no write (clear first so we detect it) ---
    Remove-Item $own -Force -ErrorAction SilentlyContinue
    $env:COPILOT_AGENT_SESSION_ID = 'not-a-guid'
    & $hook start
    Check "start rejects a non-guid session id (no file written)" (-not (Test-Path $own))

    # --- prune: dead-pid file removed, live-pid file kept ---
    Set-Content (Join-Path $dir '999999') $g2   # 999999 is not a live pid
    $env:COPILOT_AGENT_SESSION_ID = $g1
    & $hook start
    Check "start prunes a dead-pid mapping (crash self-heal)" (-not (Test-Path (Join-Path $dir '999999')))
    Check "start keeps a live-pid mapping while pruning" (Test-Path $own)

    # --- end: matching session id -> deletes own ---
    $env:COPILOT_AGENT_SESSION_ID = $g1
    & $hook end
    Check "end deletes our own mapping when the session id matches" (-not (Test-Path $own))

    # --- end: mismatched session id (pid reused by newer session) -> keeps ---
    $env:COPILOT_AGENT_SESSION_ID = $g1; & $hook start        # our session writes g1
    $env:COPILOT_AGENT_SESSION_ID = $g2; & $hook end          # a late end for a DIFFERENT session
    Check "end keeps a reused pid's mapping when the session id differs" `
        ((Test-Path $own) -and ((Get-Content $own -Raw).Trim() -eq $g1)) "content: '$(if(Test-Path $own){(Get-Content $own -Raw).Trim()})'"

    # --- stdin JSON path: session id comes from the piped payload, not env ---
    # A child pwsh sets COPILOT_LOADER_PID to its own live pid and clears the env
    # session id, so the only source is the JSON on its stdin. Mirrors how Copilot
    # actually delivers the payload.
    $g3 = [guid]::NewGuid().ToString()
    $home2 = Join-Path $env:TEMP "psmux_session_map_stdin_$([guid]::NewGuid().ToString('N'))"
    $dir2 = Join-Path $home2 '.copilot\psmux-sessions'
    $json = "{`"sessionId`":`"$g3`",`"source`":`"new`",`"cwd`":`"D:\\x`"}"
    $childCmd = "`$env:USERPROFILE='$home2'; `$env:COPILOT_LOADER_PID=`"`$PID`"; `$env:COPILOT_AGENT_SESSION_ID=''; & '$hook' start"
    $json | pwsh -NoProfile -Command $childCmd
    $stdinFiles = @(Get-ChildItem $dir2 -File -ErrorAction SilentlyContinue)
    Check "stdin JSON session id is parsed and written" `
        ($stdinFiles.Count -eq 1 -and (Get-Content $stdinFiles[0].FullName -Raw).Trim() -eq $g3) `
        "files: $($stdinFiles.Count), content: '$(if($stdinFiles.Count -eq 1){(Get-Content $stdinFiles[0].FullName -Raw).Trim()})'"
    Remove-Item $home2 -Recurse -Force -ErrorAction SilentlyContinue

    # --- ancestry keying (the real production path: env empty, id from stdin) ---
    # A cmd.exe copy named copilot.exe stands in for the loader; the hook runs
    # beneath it with COPILOT_LOADER_PID unset, so it must key the mapping by that
    # ancestor's pid, taking the session id from the piped JSON.
    $g4 = [guid]::NewGuid().ToString()
    $home3 = Join-Path $env:TEMP "psmux_session_map_anc_$([guid]::NewGuid().ToString('N'))"
    $ancBin = Join-Path $home3 'bin'
    New-Item -ItemType Directory -Force -Path $ancBin | Out-Null
    $fakeCopilot = Join-Path $ancBin 'copilot.exe'
    Copy-Item (Join-Path $env:WINDIR 'System32\cmd.exe') $fakeCopilot
    $pwshExe = (Get-Command pwsh).Source
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $fakeCopilot
    $psi.Arguments = "/d /c `"`"$pwshExe`" -NoProfile -File `"$hook`" start`""   # cmd /c strips one quote pair
    $psi.RedirectStandardInput = $true
    $psi.UseShellExecute = $false
    $psi.EnvironmentVariables['USERPROFILE'] = $home3
    $psi.EnvironmentVariables['COPILOT_LOADER_PID'] = ''
    $psi.EnvironmentVariables['COPILOT_AGENT_SESSION_ID'] = ''
    $proc = [System.Diagnostics.Process]::Start($psi)
    $proc.StandardInput.Write("{`"sessionId`":`"$g4`",`"source`":`"new`"}")
    $proc.StandardInput.Close()
    $proc.WaitForExit(15000) | Out-Null
    $ancFiles = @(Get-ChildItem (Join-Path $home3 '.copilot\psmux-sessions') -File -ErrorAction SilentlyContinue)
    Check "ancestry: hook under a copilot parent keys by that pid, id from stdin" `
        ($ancFiles.Count -eq 1 -and $ancFiles[0].Name -eq "$($proc.Id)" -and (Get-Content $ancFiles[0].FullName -Raw).Trim() -eq $g4) `
        "files: $($ancFiles.Count), name: $(if($ancFiles.Count -ge 1){$ancFiles[0].Name}) want $($proc.Id)"
    Remove-Item $home3 -Recurse -Force -ErrorAction SilentlyContinue
}
finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "`n=== psmux-session-map: $script:pass passed, $script:fail failed ===" -ForegroundColor $(if($script:fail -eq 0){'Green'}else{'Red'})
exit $(if($script:fail -eq 0){0}else{1})
