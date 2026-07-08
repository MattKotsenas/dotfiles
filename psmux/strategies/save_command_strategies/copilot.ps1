#!/usr/bin/env pwsh
# =============================================================================
# @resurrect-save-command-strategy: 'copilot'
#
# Global save-command strategy (see psmux-resurrect/scripts/save_strategy.ps1).
# For a pane running the Copilot CLI, emit `clod --resume=<session-id>` so
# restore brings the actual session back instead of launching a fresh `clod`.
# Every other pane -- and any copilot pane we cannot map -- passes through
# unchanged.
#
# Mapping source: the psmux-session-map Copilot hook writes
#   ~/.copilot/psmux-sessions/<copilot-pid> = <session-id>
# at session start. Here we walk the pane's process descendants to find a pid
# that has such a file. No psmux inuse.lock, no events.jsonl -- the hook's
# pid->id file is the only input.
#
# Contract: print exactly one line to stdout = the command to persist.
# =============================================================================
param(
    [Parameter(Position = 0)] [AllowEmptyString()] [string] $Command,
    [Parameter(Position = 1)] [AllowEmptyString()] [string] $PanePid,
    [Parameter(Position = 2)] [AllowEmptyString()] [string] $Directory
)

$ErrorActionPreference = 'SilentlyContinue'

# Cheap guard: only copilot-looking panes are worth a process-tree walk.
# psmux reports copilot as the typed alias `clod`, or `copilot`/`node`.
$first = (($Command -split '\s+', 2)[0] -split '[\\/]' | Select-Object -Last 1) -replace '\.exe$', ''
if ($first -notin @('clod', 'copilot', 'node')) { Write-Output $Command; return }

$sessionsDir = Join-Path $env:USERPROFILE '.copilot\psmux-sessions'
if (-not (Test-Path $sessionsDir)) { Write-Output $Command; return }

$panePidInt = 0
if (-not [int]::TryParse($PanePid, [ref]$panePidInt) -or $panePidInt -le 0) { Write-Output $Command; return }

# Build a parent -> children index once, then breadth-first walk the pane's
# descendants looking for a pid that the hook recorded a session for.
$byParent = @{}
$nameByPid = @{}
foreach ($p in (Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
    $procId = [int]$p.ProcessId
    $ppid   = [int]$p.ParentProcessId
    $nameByPid[$procId] = [string]$p.Name
    if (-not $byParent.ContainsKey($ppid)) { $byParent[$ppid] = [System.Collections.Generic.List[int]]::new() }
    $byParent[$ppid].Add($procId)
}

$sessionId = $null
$seen = @{}
$queue = [System.Collections.Queue]::new()
$queue.Enqueue($panePidInt)
while ($queue.Count -gt 0) {
    $cur = [int]$queue.Dequeue()
    if ($seen.ContainsKey($cur)) { continue }
    $seen[$cur] = $true

    # Only trust a mapping that still belongs to a copilot process. Guards the
    # PID-reuse window: a dead copilot's pid (and its lingering map file) could
    # be reclaimed by an unrelated live process before pruning catches it.
    if (([string]$nameByPid[$cur]) -match 'copilot') {
        $mapFile = Join-Path $sessionsDir "$cur"
        if (Test-Path $mapFile) {
            $id = (Get-Content $mapFile -Raw -ErrorAction SilentlyContinue)
            if (-not [string]::IsNullOrWhiteSpace($id)) {
                $id = $id.Trim()
                $parsed = [guid]::Empty
                if ([guid]::TryParse($id, [ref]$parsed)) { $sessionId = $id; break }
            }
        }
    }

    if ($byParent.ContainsKey($cur)) {
        foreach ($child in $byParent[$cur]) { $queue.Enqueue($child) }
    }
}

if ($sessionId) { Write-Output "clod --resume=$sessionId" } else { Write-Output $Command }
