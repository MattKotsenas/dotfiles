<#
.SYNOPSIS
Reopen a recently-closed Copilot pane as a psmux window.

.DESCRIPTION
psmux-continuum snapshots (~/.psmux/resurrect/psmux_resurrect_<ts>.json) already
record every Copilot pane as `clod --resume=<session-id>`, tagged with the window
name you gave it and its directory. Those snapshots are the raw log; a task is
"closed" when its session id is in an older snapshot but not the newest (the current
open set).

relaunch dedupes by session id (most recent state wins), drops sessions whose on-disk
state is gone or that a live Copilot still holds open, and lists the rest in a psmux
display-menu. Picking one reopens it as `clod --resume=<id>` in a new window named as
it was, so the pane you closed comes back where you left it.

Retention: -RetentionDays bounds how far back the list reaches; the real run also
deletes snapshots past that cutoff.

Invoked from inside psmux via the `relaunch` command-alias (see .psmux.conf), which
runs it under `pwsh -NoProfile -File`. -List (JSON) and -DryRun (print the menu argv)
neither prune nor open a window, so they are safe to call from tests.

.PARAMETER RetentionDays
Prune resurrect snapshots older than this many days. Default 28.

.PARAMETER List
Emit the closed tasks as JSON and exit, without showing the menu.

.PARAMETER DryRun
Print the display-menu arguments instead of executing them.

.EXAMPLE
# From the psmux command prompt (prefix then `:`):
:relaunch
# Pop the closed-pane menu; pick one to reopen it as a named window.
#>
[CmdletBinding()]
param(
    [int]    $RetentionDays   = 28,
    # The three path/exe overrides below are test seams; the defaults are what
    # you want interactively.
    [string] $ResurrectDir    = (Join-Path $env:USERPROFILE '.psmux\resurrect'),
    [string] $SessionStateDir = (Join-Path $env:USERPROFILE '.copilot\session-state'),
    [string] $Psmux           = 'psmux',
    [switch] $List,
    [switch] $DryRun
)

# The command-alias path (run-shell) sets PSMUX_TARGET_SESSION; a manual in-pane run
# sets TMUX. Either means "inside psmux", which gates the display-* calls below.
$inPsmux = [bool]($env:PSMUX_TARGET_SESSION -or $env:TMUX)

# The id the continuum copilot save-strategy persists: `clod --resume=<guid>`.
$resumeRe = '--resume[=\s]+([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})'

# Parse a snapshot file. Returns the parsed JSON, or $null if it can't be read
# or parsed -- callers distinguish "unreadable" from "valid but no panes".
function Read-Snapshot {
    param([string] $Path)
    try { return (Get-Content -LiteralPath $Path -Raw -EA Stop | ConvertFrom-Json -EA Stop) } catch { return $null }
}

# Copilot panes in a parsed snapshot as {Id, Name, Dir, Command}. Panes without a
# resume id are not Copilot tasks and are skipped (which keeps id the key).
function Get-Tasks {
    param($Json)
    $out = [System.Collections.Generic.List[object]]::new()
    foreach ($sess in @($Json.sessions)) {
        foreach ($win in @($sess.windows)) {
            foreach ($pane in @($win.panes)) {
                $cmd = [string]$pane.command
                if ($cmd -match $resumeRe) {
                    $out.Add([pscustomobject]@{
                        Id = $Matches[1]; Name = [string]$win.name
                        Dir = [string]$pane.directory; Command = $cmd
                    })
                }
            }
        }
    }
    return $out
}

# A session still held open by a live Copilot (inuse.<pid>.lock, pid running)
# must not be reopened -- that would fork a second Copilot on the same session.
function Test-InUse {
    param([string] $Id)
    # Check EVERY lock, not just the first: a stale dead-pid lock must not mask a
    # live one.
    foreach ($lock in (Get-ChildItem (Join-Path $SessionStateDir $Id) -Filter 'inuse.*.lock' -EA SilentlyContinue)) {
        if ($lock.Name -match '^inuse\.(\d+)\.lock$' -and (Get-Process -Id ([int]$Matches[1]) -EA SilentlyContinue)) {
            return $true
        }
    }
    return $false
}

$snapshots = @(Get-ChildItem -LiteralPath $ResurrectDir -Filter 'psmux_resurrect_*.json' -File -EA SilentlyContinue | Sort-Object Name)
if ($snapshots.Count -eq 0) {
    if (-not ($List -or $DryRun) -and $inPsmux) { & $Psmux display-message 'relaunch: no continuum snapshots found' }
    return
}
$newest = $snapshots[-1]
$newestName = $newest.Name

# The newest snapshot defines the "open" set, so it must be trustworthy: a
# half-written or malformed newest would empty that set and make still-open panes
# look closed. Bail rather than offer a live pane for relaunch.
$newestJson = Read-Snapshot $newest.FullName
if ($null -eq $newestJson) {
    if (-not ($List -or $DryRun) -and $inPsmux) { & $Psmux display-message 'relaunch: newest snapshot unreadable' }
    return
}

# Maintenance prune (delete old files) only on the real run; -List/-DryRun must
# not mutate ~/.psmux/resurrect. Every mode then bounds the working set in-memory
# by the same cutoff, so the list is identical whether or not files were deleted.
# The newest always survives -- continuum restores from it.
$cutoff = (Get-Date).AddDays(-$RetentionDays)
if (-not ($List -or $DryRun)) {
    foreach ($s in $snapshots) {
        if ($s.Name -ne $newestName -and $s.LastWriteTime -lt $cutoff) {
            Remove-Item -LiteralPath $s.FullName -Force -EA SilentlyContinue
        }
    }
}
$kept = @($snapshots | Where-Object { $_.Name -eq $newestName -or $_.LastWriteTime -ge $cutoff })

# Dedupe by id, newest snapshot wins (walk oldest->newest, overwrite). LastTs
# tracks the latest snapshot each id was seen in, so the menu lists freshest
# first. Unreadable historical snapshots contribute nothing and are skipped.
$byId = @{}
foreach ($s in $kept) {
    $json = if ($s.Name -eq $newestName) { $newestJson } else { Read-Snapshot $s.FullName }
    if ($null -eq $json) { continue }
    foreach ($t in (Get-Tasks $json)) {
        $t | Add-Member -NotePropertyName LastTs -NotePropertyValue $s.Name -Force
        $byId[$t.Id] = $t
    }
}

# Open = ids in the newest snapshot. Closed = the rest with live on-disk state
# that isn't currently held open.
$openIds = @{}
foreach ($t in (Get-Tasks $newestJson)) { $openIds[$t.Id] = $true }

$closed = @(
    foreach ($id in $byId.Keys) {
        if ($openIds.ContainsKey($id)) { continue }
        if (-not (Test-Path -LiteralPath (Join-Path $SessionStateDir $id))) { continue }
        if (Test-InUse $id) { continue }
        $byId[$id]
    }
) | Sort-Object LastTs -Descending

if ($List) {
    # Force an array before serializing so zero rows emit "[]" -- a bare pipeline
    # into ConvertTo-Json emits nothing, which isn't valid JSON for a seam.
    $rows = @($closed | Select-Object Id, Name, Dir, Command, LastTs)
    return (ConvertTo-Json -InputObject $rows -Depth 3)
}

if (@($closed).Count -eq 0) {
    if (-not $DryRun -and $inPsmux) { & $Psmux display-message 'relaunch: no closed Copilot panes' }
    return
}

# Single-quote each arg so spaces, backslashes, and '&' reach psmux's parser
# literally. Doubling embedded quotes keeps a stray apostrophe from breaking the
# parse (psmux has no single-quote escape, so the apostrophe itself drops out).
function Quote([string] $s) { "'" + ($s -replace "'", "''") + "'" }

$menu = [System.Collections.Generic.List[string]]::new()
$menu.Add('-T'); $menu.Add(' relaunch closed ')
$i = 0
foreach ($t in $closed) {
    $i++
    $key = if ($i -le 9) { "$i" } elseif ($i -le 35) { [char](87 + $i) } else { '' }  # 1-9 then a-z
    $action = "new-window -n $(Quote $t.Name) -c $(Quote $t.Dir) $(Quote $t.Command)"
    $menu.Add($t.Name); $menu.Add($key); $menu.Add($action)
}

if ($DryRun) { return ($menu -join "`n") }

# The menu renders on the current client, so relaunch must run inside psmux; the
# action's new-window then executes in that client's context, landing the reopened
# pane in your session (a client-less server resolves the wrong one).
if (-not $inPsmux) { Write-Warning 'relaunch must be run inside a psmux session.'; return }
& $Psmux display-menu @menu
