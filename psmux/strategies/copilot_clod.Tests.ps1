#!/usr/bin/env pwsh
# Uses the real resurrect hooks with fake psmux options and process metadata.
param([Parameter(Mandatory)][string]$PluginDir)
$ErrorActionPreference = 'Stop'
$pass = 0; $fail = 0
function Check($name, $condition, $actual) {
    if ($condition) { Write-Host "  PASS: $name"; $script:pass++ }
    else { Write-Host "  FAIL: $name >> $actual"; $script:fail++ }
}
$restoreStrategy = Join-Path $PSScriptRoot 'copilot_clod.ps1'
$id = [guid]::NewGuid().ToString()
foreach ($case in @(
    @('copilot', 'clod'),
    @("copilot --resume=$id", "clod --resume=$id"),
    @('copilot.exe --resume=abc', 'clod --resume=abc'),
    @('copilot  --resume=abc --model "a b"', 'clod  --resume=abc --model "a b"'),
    @('copilotapp --resume=abc', 'copilotapp --resume=abc'),
    @('clod --resume=abc', 'clod --resume=abc'),
    @('vim copilot', 'vim copilot'),
    @('', '')
)) {
    $actual = & $restoreStrategy $case[0] 'C:\directory with spaces'
    Check "launcher conversion preserves arguments: [$($case[0])]" ($actual -ceq $case[1]) $actual
}

$root = Join-Path $env:TEMP ('copilot-launch-' + [guid]::NewGuid().ToString('N'))
$oldProfile = $env:USERPROFILE
$psmuxRoot = Split-Path $PSScriptRoot -Parent
try {
    $saveStrategies = Join-Path $root 'save-strategies'
    $maps = Join-Path $root '.copilot\psmux-sessions'
    New-Item -ItemType Directory $saveStrategies, $maps -Force | Out-Null
    $env:USERPROFILE = $root
    Set-Content (Join-Path $maps '101') $id
    $options = @{}
    foreach ($match in [regex]::Matches((Get-Content (Join-Path $psmuxRoot '.psmux.conf') -Raw), "(?m)^set -g (@resurrect-\S+) '([^']*)'\r?$")) {
        $options[$match.Groups[1].Value] = $match.Groups[2].Value
    }
    $optionsPath = Join-Path $root 'options.json'
    $options | ConvertTo-Json | Set-Content $optionsPath
    $quotedOptions = [Management.Automation.Language.CodeGeneration]::EscapeSingleQuotedStringContent($optionsPath)
    $fakePsmux = Join-Path $root 'psmux.ps1'
    @"
`$options = Get-Content '$quotedOptions' -Raw | ConvertFrom-Json -AsHashtable
if (`$args[0] -eq 'show-options' -and `$options.ContainsKey(`$args[-1])) {
    `$options[`$args[-1]]
    exit 0
}
exit 1
"@ | Set-Content $fakePsmux
    $saveSource = Join-Path $PSScriptRoot 'save_command_strategies\copilot.ps1'
    $quotedSave = [Management.Automation.Language.CodeGeneration]::EscapeSingleQuotedStringContent($saveSource)
    @"
param(`$Command, `$PanePid, `$Directory)
function Get-CimInstance {
    param(`$ClassName, `$ErrorAction)
    [pscustomobject]@{ ProcessId=101; ParentProcessId=100; Name='copilot.exe'; CommandLine='copilot'; CreationDate=(Get-Date).AddMinutes(-5) }
}
& '$quotedSave' `$Command `$PanePid `$Directory
"@ | Set-Content (Join-Path $saveStrategies 'copilot.ps1')
    . (Join-Path $PluginDir 'scripts\save_strategy.ps1')
    . (Join-Path $PluginDir 'scripts\strategy.ps1')
    foreach ($inputCommand in 'copilot', 'clod') {
        $saved = Get-SaveCommand -PaneCommand $inputCommand -PanePid '100' -Directory $root -PsmuxBin $fakePsmux -PluginDir $PluginDir -UserStrategiesDir $saveStrategies
        Check "$inputCommand input saves canonical Copilot command through the configured hook" ($saved -ceq "copilot --resume=$id") $saved
        $restored = Get-StrategyCommand -OriginalCommand $saved -Directory $root -PsmuxBin $fakePsmux -PluginDir $PluginDir -UserStrategiesDir $PSScriptRoot
        Check "$inputCommand input restores through clod with the same session id" ($restored -ceq "clod --resume=$id") $restored
    }
    Check 'restore allowlist accepts canonical and older personal commands' ($options['@resurrect-processes'] -ceq '~copilot ~clod') $options['@resurrect-processes']
    $legacy = "clod --resume=$id"
    $actual = Get-StrategyCommand -OriginalCommand $legacy -Directory $root -PsmuxBin $fakePsmux -PluginDir $PluginDir -UserStrategiesDir $PSScriptRoot
    Check 'older clod snapshots retain their launcher and session' ($actual -ceq $legacy) $actual

    $snapshots = Join-Path $root 'snapshots'
    $sessionState = Join-Path $root 'session-state'
    New-Item -ItemType Directory $snapshots, (Join-Path $sessionState $id) -Force | Out-Null
    $older = Join-Path $snapshots 'psmux_resurrect_20000101_000000.json'
    $newest = Join-Path $snapshots 'psmux_resurrect_20000101_000001.json'
    '{"sessions":[]}' | Set-Content $newest
    $relaunch = Join-Path $psmuxRoot 'scripts\relaunch.ps1'
    foreach ($command in "copilot --resume=$id", "clod --resume=$id") {
        @{sessions=@(@{windows=@(@{name='closed';panes=@(@{directory=$root;command=$command})})})} | ConvertTo-Json -Depth 8 | Set-Content $older
        $before = Get-Content $older -Raw
        $menu = & $relaunch -ResurrectDir $snapshots -SessionStateDir $sessionState -DryRun
        Check "relaunch converts [$command] to the personal launcher" ($menu -match [regex]::Escape("'clod --resume=$id'")) $menu
        Check 'relaunch conversion leaves the saved snapshot unchanged' ((Get-Content $older -Raw) -ceq $before)
    }
} finally {
    $env:USERPROFILE = $oldProfile
    Remove-Item $root -Recurse -Force
}
Write-Host "Results: $pass passed, $fail failed"
exit $(if ($fail) { 1 } else { 0 })
