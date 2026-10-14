#!/usr/bin/env pwsh
# Hermetic session-resolution tests with an isolated profile and process snapshot.
$ErrorActionPreference = 'Stop'
$pass = 0; $fail = 0
function Check($name, $condition, $actual) {
    if ($condition) { Write-Host "  PASS: $name"; $script:pass++ }
    else { Write-Host "  FAIL: $name >> $actual"; $script:fail++ }
}
$strategy = Join-Path $PSScriptRoot 'copilot.ps1'
$root = Join-Path $env:TEMP ('copilot-resolution-' + [guid]::NewGuid().ToString('N'))
$maps = Join-Path $root '.copilot\psmux-sessions'
New-Item -ItemType Directory $maps -Force | Out-Null
$oldHome = $env:USERPROFILE
$created = (Get-Date).AddMinutes(-5)
$idA = [guid]::NewGuid().ToString(); $idB = [guid]::NewGuid().ToString()
function ProcessRow($id, $parent, $name, $command) {
    [pscustomobject]@{ProcessId=$id;ParentProcessId=$parent;Name=$name;CommandLine=$command;CreationDate=$created}
}
function Get-CimInstance { param($ClassName, $ErrorAction); $processes }
function Resolve { & $strategy 'copilot' '100' $root }
try {
    $env:USERPROFILE=$root
    $script:processes=@((ProcessRow 100 0 'pwsh.exe' 'pwsh'), (ProcessRow 101 100 'copilot.exe' "copilot --resume=$idA"))
    $actual=Resolve
    Check 'unambiguous process resume argument is accepted before its hook mapping exists' ($actual -ceq "copilot --resume=$idA") $actual
    Set-Content (Join-Path $maps '101') $idB
    $actual=Resolve
    Check 'current hook mapping overrides launch argument' ($actual -ceq "copilot --resume=$idB") $actual
    $actual = & $strategy 'clod --resume=old' '100' $root
    Check 'personal clod input saves the canonical Copilot launcher' ($actual -ceq "copilot --resume=$idB") $actual
    Set-Content (Join-Path $maps '101') 'unreadable-or-incomplete-id'
    $actual=Resolve
    Check 'unusable current mapping falls back to captured command, not stale launch argument' ($actual -ceq 'copilot') $actual
    Set-Content (Join-Path $maps '101') $idB
    (Get-Item (Join-Path $maps '101')).LastWriteTime=$created.AddMinutes(-1)
    $actual=Resolve
    Check 'mapping older than process permits its own launch argument' ($actual -ceq "copilot --resume=$idA") $actual
    Set-Content (Join-Path $maps '101') $idA
    Set-Content (Join-Path $maps '102') $idB
    $script:processes+=ProcessRow 102 100 'copilot.exe' "copilot --resume=$idB"
    $actual=Resolve
    Check 'two candidate Copilot processes do not choose an arbitrary session' ($actual -ceq 'copilot') $actual
    Remove-Item (Join-Path $maps '102')
    $script:processes[2]=ProcessRow 102 100 'copilot.exe' 'copilot'
    $actual=Resolve
    Check 'ambiguity still falls back when only one process has a resolvable session' ($actual -ceq 'copilot') $actual
    $script:processes=@((ProcessRow 100 0 'pwsh.exe' 'pwsh'),(ProcessRow 101 100 'notcopilot.exe' "notcopilot --resume=$idA"))
    $actual=Resolve
    Check 'unrelated process containing copilot in its name is rejected' ($actual -ceq 'copilot') $actual
    $script:processes=@((ProcessRow 100 0 'pwsh.exe' 'pwsh'),(ProcessRow 101 100 'copilot.exe' "copilot --resume=$idA"))
    Set-Content (Join-Path $maps '101') $idB
    $locked=[IO.File]::Open((Join-Path $maps '101'),[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    try {
        $actual=Resolve
        Check 'locked current mapping cannot fall through to a stale launch argument' ($actual -ceq 'copilot') $actual
    } finally { $locked.Dispose() }
    $script:processes[1]=ProcessRow 101 100 'copilotapp.exe' "copilotapp --resume=$idA"
    $actual=Resolve
    Check 'CopilotApp executable uses its current mapping' ($actual -ceq "copilot --resume=$idB") $actual
    $script:processes=@()
    $actual=Resolve
    Check 'missing process snapshot preserves captured command' ($actual -ceq 'copilot') $actual
} finally {
    $env:USERPROFILE=$oldHome
    Remove-Item $root -Recurse -Force
}
Write-Host "Results: $pass passed, $fail failed"
exit $(if ($fail) { 1 } else { 0 })
