#!/usr/bin/env pwsh
# Resolve a Copilot pane to copilot --resume=<session-id>. Ambiguous or unavailable
# session state preserves the captured command.
param(
    [Parameter(Position = 0)] [AllowEmptyString()] [string] $Command,
    [Parameter(Position = 1)] [AllowEmptyString()] [string] $PanePid,
    [Parameter(Position = 2)] [AllowEmptyString()] [string] $Directory
)

$ErrorActionPreference = 'SilentlyContinue'
$first = (($Command -split '\s+', 2)[0] -split '[\\/]' | Select-Object -Last 1) -replace '\.exe$', ''
if ($first -notin @('copilot', 'node', 'clod')) { Write-Output $Command; return }
$panePidInt = 0
if (-not [int]::TryParse($PanePid, [ref]$panePidInt) -or $panePidInt -le 0) { Write-Output $Command; return }

$byParent = @{}
$byPid = @{}
foreach ($p in (Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
    $procId = [int]$p.ProcessId
    $parentId = [int]$p.ParentProcessId
    $byPid[$procId] = $p
    if (-not $byParent.ContainsKey($parentId)) { $byParent[$parentId] = [Collections.Generic.List[int]]::new() }
    $byParent[$parentId].Add($procId)
}

$copilotPids = @()
$seen = @{}
$queue = [Collections.Queue]::new()
$queue.Enqueue($panePidInt)
while ($queue.Count -gt 0) {
    $cur = [int]$queue.Dequeue()
    if ($seen.ContainsKey($cur)) { continue }
    $seen[$cur] = $true
    if ([string]$byPid[$cur].Name -match '^copilot(?:app)?(?:\.exe)?$') { $copilotPids += $cur }
    if ($byParent.ContainsKey($cur)) {
        foreach ($child in $byParent[$cur]) { $queue.Enqueue($child) }
    }
}
# A shell can have multiple Copilot children. Neither traversal order nor the
# presence of one mapping identifies which child owns the captured command.
if ($copilotPids.Count -ne 1) { Write-Output $Command; return }
$copilot = $byPid[$copilotPids[0]]
$mapFile = Join-Path $env:USERPROFILE ".copilot\psmux-sessions\$($copilot.ProcessId)"
if (Test-Path $mapFile) {
    try {
        $mapping = Get-Item $mapFile -ErrorAction Stop
        if (-not $copilot.CreationDate) { Write-Output $Command; return }
        if ($mapping.LastWriteTime -ge $copilot.CreationDate) {
            # A current mapping supersedes the launch argument. If it cannot be
            # read or validated, the launch session may already be obsolete.
            $id = (Get-Content $mapFile -Raw -ErrorAction Stop).Trim()
            $parsed = [guid]::Empty
            if ([guid]::TryParse($id, [ref]$parsed)) { Write-Output "copilot --resume=$id" }
            else { Write-Output $Command }
            return
        }
    } catch { Write-Output $Command; return }
}

# Before the first sessionStart hook, or with a mapping from an older process,
# the process's own resume argument is the available session identifier.
if ([string]$copilot.CommandLine -match '(?:--resume|(?:^|\s)-r)[=\s]+([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})') {
    Write-Output "copilot --resume=$($matches[1])"
} else { Write-Output $Command }
