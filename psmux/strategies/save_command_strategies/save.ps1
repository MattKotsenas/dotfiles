#!/usr/bin/env pwsh
# Global save-command dispatcher. Each program resolver echoes unknown panes unchanged.
param(
    [Parameter(Position = 0)] [AllowEmptyString()] [string] $Command,
    [Parameter(Position = 1)] [AllowEmptyString()] [string] $PanePid,
    [Parameter(Position = 2)] [AllowEmptyString()] [string] $Directory
)

$first = (($Command -split '\s+', 2)[0] -split '[\\/]' | Select-Object -Last 1) -replace '\.exe$', ''
if ($first -in @('clod', 'copilot', 'node')) {
    $resolved = & (Join-Path $PSScriptRoot 'copilot.ps1') $Command $PanePid $Directory
    if ($resolved -and $resolved -ne $Command) { Write-Output $resolved; return }
}

$resolved = & (Join-Path $PSScriptRoot 'pi.ps1') $Command $PanePid $Directory
if ($resolved -and $resolved -ne $Command) { Write-Output $resolved; return }

Write-Output $Command
