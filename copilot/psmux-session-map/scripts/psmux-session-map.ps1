#!/usr/bin/env pwsh
# =============================================================================
# psmux-session-map: Copilot CLI hook
#
# Writes a pid -> session-id mapping so psmux-resurrect's copilot save strategy
# can turn a bare `clod` pane into `clod --resume=<session-id>` at save time.
#
#   sessionStart : ~/.copilot/psmux-sessions/<COPILOT_LOADER_PID> = <session-id>
#                  then prune any files whose pid is no longer alive.
#   sessionEnd   : delete this session's own file.
#
# Crash safety: a non-graceful exit (reboot, kill, terminal close) never fires
# sessionEnd, so its file lingers. The next session's start prunes it because
# its pid is dead. PID reuse by a new copilot is harmless: that session's start
# overwrites the file with its own (correct) session id.
#
# Deliberately dependency-free -- no psmux inuse.lock, no events.jsonl. The
# COPILOT_LOADER_PID / COPILOT_AGENT_SESSION_ID env vars are the only inputs.
# =============================================================================
param(
    [Parameter(Position = 0)] [string] $Phase = 'start'
)

$ErrorActionPreference = 'SilentlyContinue'

$loaderPid = $env:COPILOT_LOADER_PID
$sessionId = $env:COPILOT_AGENT_SESSION_ID

# Without a loader pid there is nothing to key the mapping on.
if ([string]::IsNullOrWhiteSpace($loaderPid)) { return }

$dir     = Join-Path $env:USERPROFILE '.copilot\psmux-sessions'
$mapFile = Join-Path $dir $loaderPid

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

# Prune mappings whose owning process is gone (self-healing crash cleanup).
foreach ($f in Get-ChildItem -Path $dir -File -ErrorAction SilentlyContinue) {
    $filePid = 0
    if ([int]::TryParse($f.Name, [ref]$filePid) -and $filePid -gt 0) {
        if (-not (Get-Process -Id $filePid -ErrorAction SilentlyContinue)) {
            Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue
        }
    }
}
