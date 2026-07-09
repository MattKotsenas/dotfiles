#!/usr/bin/env pwsh
# =============================================================================
# psmux-session-map: Copilot CLI hook
#
# Writes a pid -> session-id mapping so psmux-resurrect's copilot save strategy
# can save a `clod` pane as `clod --resume=<session-id>` and restore the real
# session after a reboot.
#
#   sessionStart : write ~/.copilot/psmux-sessions/<copilot-pid> = <session-id>,
#                  then prune files whose pid is gone.
#   sessionEnd   : delete this session's own file.
#
# sessionStart fires on every session transition -- fresh start, --resume, and
# in-session /new or /resume -- so the mapping always names the current session,
# not the id the pane launched with. Input source and keying are explained at the
# code below.
#
# Deliberately dependency-free -- no psmux inuse.lock, no events.jsonl.
# =============================================================================
param(
    [Parameter(Position = 0)] [string] $Phase = 'start'
)

$ErrorActionPreference = 'SilentlyContinue'

$loaderPid = $env:COPILOT_LOADER_PID
$sessionId = $env:COPILOT_AGENT_SESSION_ID

# Copilot delivers the hook payload as JSON on stdin ({ "sessionId": ... }); the
# COPILOT_* env vars are empty at hook time, so stdin is the real source. Guard
# on IsInputRedirected so an interactive invocation never blocks on ReadToEnd.
if ([string]::IsNullOrWhiteSpace($sessionId) -and [Console]::IsInputRedirected) {
    $raw = [Console]::In.ReadToEnd()
    if (-not [string]::IsNullOrWhiteSpace($raw)) {
        try { $sessionId = [string]($raw | ConvertFrom-Json).sessionId } catch { }
    }
}
if ($sessionId) { $sessionId = $sessionId.Trim() }

# Key the mapping by the copilot process that owns this session -- the loader pid
# the save strategy matches on. Prefer COPILOT_LOADER_PID when it names a live
# pid; current copilot builds leave it empty in hooks, so the ancestry walk is the
# active path. One snapshot, reused by the prune below.
$parentByPid = @{}
$nameByPid   = @{}
foreach ($p in (Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
    $parentByPid[[int]$p.ProcessId] = [int]$p.ParentProcessId
    $nameByPid[[int]$p.ProcessId]   = [string]$p.Name
}
$copilotPid = $null
$lpInt = 0
if ([int]::TryParse($loaderPid, [ref]$lpInt) -and $lpInt -gt 0 -and $nameByPid.ContainsKey($lpInt)) {
    $copilotPid = $lpInt
} else {
    $cur = $PID
    $seen = @{}
    for ($i = 0; $i -lt 32 -and $cur -and $nameByPid.ContainsKey($cur) -and -not $seen.ContainsKey($cur); $i++) {
        $seen[$cur] = $true
        if ($nameByPid[$cur] -match 'copilot') { $copilotPid = $cur; break }
        $cur = $parentByPid[$cur]
    }
}

# Without a copilot pid there is nothing to key the mapping on.
if (-not $copilotPid) { return }

$dir     = Join-Path $env:USERPROFILE '.copilot\psmux-sessions'
$mapFile = Join-Path $dir "$copilotPid"

if ($Phase -eq 'end') {
    # Only remove OUR mapping. If our pid was already reused by a newer copilot
    # session (which rewrote this file), a late end hook must not delete theirs.
    if ((Test-Path $mapFile) -and -not [string]::IsNullOrWhiteSpace($sessionId)) {
        $stored = (Get-Content $mapFile -Raw -ErrorAction SilentlyContinue)
        if ($stored -and $stored.Trim() -eq $sessionId) {
            Remove-Item $mapFile -Force -ErrorAction SilentlyContinue
        }
    }
    return
}

# --- start ---
New-Item -ItemType Directory -Path $dir -Force | Out-Null

# Record our mapping -- only a well-formed session guid, written atomically so a
# racing save never reads a half-written file.
$parsed = [guid]::Empty
if ([guid]::TryParse($sessionId, [ref]$parsed)) {
    $tmp = "$mapFile.$PID.tmp"
    Set-Content -Path $tmp -Value $sessionId -NoNewline -Encoding UTF8
    Move-Item -Path $tmp -Destination $mapFile -Force
}

# Prune mappings whose pid is no longer alive (self-healing cleanup after a
# non-graceful exit). Reuses the snapshot above. A pid reused by a non-copilot
# is ignored by the save strategy regardless, and pruned once it dies.
foreach ($f in Get-ChildItem -Path $dir -File -ErrorAction SilentlyContinue) {
    $filePid = 0
    if ([int]::TryParse($f.Name, [ref]$filePid) -and $filePid -gt 0) {
        if (-not $nameByPid.ContainsKey($filePid)) {
            Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue
        }
    }
}
