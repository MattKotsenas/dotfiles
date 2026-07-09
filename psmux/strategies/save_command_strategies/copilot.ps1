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
# Here we walk the pane's process descendants to find the copilot process and
# resolve its session id from two sources: the hook's mapping file, then the
# process's own `--resume=<id>` argument. The walk below explains which wins and
# why. No psmux inuse.lock, no events.jsonl.
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

$panePidInt = 0
if (-not [int]::TryParse($PanePid, [ref]$panePidInt) -or $panePidInt -le 0) { Write-Output $Command; return }

# Build a parent -> children index once, then breadth-first walk the pane's
# descendants looking for the copilot process. Capture each pid's command line
# (for the --resume fallback) and creation time (to reject a stale mapping left
# on a reused pid).
$byParent = @{}
$nameByPid = @{}
$cmdlineByPid = @{}
$creationByPid = @{}
foreach ($p in (Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
    $procId = [int]$p.ProcessId
    $ppid   = [int]$p.ParentProcessId
    $nameByPid[$procId] = [string]$p.Name
    $cmdlineByPid[$procId] = [string]$p.CommandLine
    $creationByPid[$procId] = $p.CreationDate
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

    # Only trust a mapping/argument that belongs to a copilot process. Guards
    # the PID-reuse window: a dead copilot's pid could be reclaimed by an
    # unrelated live process before pruning catches it.
    if (([string]$nameByPid[$cur]) -match 'copilot') {
        # 1. PRIMARY: the hook's pid->id mapping. sessionStart rewrites it on
        #    every session transition, so it names the current session rather than
        #    the id the pane launched with. Trust it only if it was written during
        #    this process's life -- a mapping older than the process is a stale
        #    file left on a reused pid, so fall through to the argument instead.
        $mapFile = Join-Path $sessionsDir "$cur"
        $created = $creationByPid[$cur]
        if ((Test-Path $mapFile) -and $created -and ((Get-Item $mapFile).LastWriteTime -ge $created)) {
            $id = (Get-Content $mapFile -Raw -ErrorAction SilentlyContinue)
            if (-not [string]::IsNullOrWhiteSpace($id)) {
                $id = $id.Trim()
                $parsed = [guid]::Empty
                if ([guid]::TryParse($id, [ref]$parsed)) { $sessionId = $id; break }
            }
        }
        # 2. FALLBACK: the process's own --resume=<id> argument, for a
        #    just-restored pane whose sessionStart has not fired yet (it fires
        #    lazily, on the first prompt). Accurate in that window -- a switch
        #    would have written the mapping above, so this is never the stale
        #    launch id.
        $cl = [string]$cmdlineByPid[$cur]
        if ($cl -match '(?:--resume|(?:^|\s)-r)[=\s]+([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})') {
            $cand = $matches[1]
            $parsed = [guid]::Empty
            if ([guid]::TryParse($cand, [ref]$parsed)) { $sessionId = $cand; break }
        }
    }

    if ($byParent.ContainsKey($cur)) {
        foreach ($child in $byParent[$cur]) { $queue.Enqueue($child) }
    }
}

if ($sessionId) { Write-Output "clod --resume=$sessionId" } else { Write-Output $Command }
