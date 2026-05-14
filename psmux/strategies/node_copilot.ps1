#!/usr/bin/env pwsh
# node_copilot strategy for psmux-resurrect
#
# Activated via: set -g @resurrect-strategy-node 'copilot'
#
# Restores a copilot CLI pane by re-attaching to the most recent session whose
# `cwd` matches the pane's directory. If no recent match exists, falls back to
# the original command (`node` - which means re-launching whatever node-based
# process was there, or just a node REPL).
#
# Why this is keyed on `node`: copilot CLI is a node app, and psmux on Windows
# reports `pane_current_command` as `node` for it (not `copilot`). Confirmed
# against actual `~/.psmux/resurrect/last` save data.
#
# Why this exists: copilot prints its session GUID on clean exit, but a crash
# (machine reboot, process kill, terminal close) skips that print. Resuming
# from psmux-resurrect's auto-restore therefore re-launches a bare process
# with no session context. This strategy reads ~/.copilot/session-store.db
# directly to recover the lost GUID.
#
# Implementation note: uses winsqlite3.dll (Windows 10+) via P/Invoke so no
# external sqlite tooling is required.

param(
    [Parameter(Mandatory)] [string] $OriginalCommand,
    [Parameter(Mandatory)] [string] $Directory
)

$ErrorActionPreference = 'Stop'
trap { $OriginalCommand; continue }

$db = Join-Path $env:USERPROFILE '.copilot\session-store.db'
if (-not (Test-Path $db)) { $OriginalCommand; return }

# Normalize the pane directory to match the format copilot stores
# (Windows backslashes, no trailing separator).
$normDir = ($Directory -replace '^~', $env:USERPROFILE).TrimEnd('\','/')
if ([string]::IsNullOrWhiteSpace($normDir)) { $OriginalCommand; return }

if (-not ([System.Management.Automation.PSTypeName]'PsmuxStrategies.WinSqlite').Type) {
    Add-Type -Namespace PsmuxStrategies -Name WinSqlite -MemberDefinition @'
[DllImport("winsqlite3.dll", CharSet=CharSet.Unicode)]
public static extern int sqlite3_open16(string filename, out System.IntPtr db);
[DllImport("winsqlite3.dll", CharSet=CharSet.Unicode)]
public static extern int sqlite3_prepare16_v2(System.IntPtr db, string sql, int nByte, out System.IntPtr stmt, out System.IntPtr tail);
[DllImport("winsqlite3.dll", CharSet=CharSet.Unicode)]
public static extern int sqlite3_bind_text16(System.IntPtr stmt, int idx, string val, int n, System.IntPtr destructor);
[DllImport("winsqlite3.dll")]
public static extern int sqlite3_step(System.IntPtr stmt);
[DllImport("winsqlite3.dll")]
public static extern System.IntPtr sqlite3_column_text16(System.IntPtr stmt, int col);
[DllImport("winsqlite3.dll")]
public static extern int sqlite3_finalize(System.IntPtr stmt);
[DllImport("winsqlite3.dll")]
public static extern int sqlite3_close(System.IntPtr db);
'@
}

$SQLITE_OK = 0
$SQLITE_ROW = 100
$SQLITE_TRANSIENT = [IntPtr]::new(-1)

$dbHandle = [IntPtr]::Zero
$stmt = [IntPtr]::Zero
$sessionId = $null
try {
    if ([PsmuxStrategies.WinSqlite]::sqlite3_open16($db, [ref]$dbHandle) -ne $SQLITE_OK) {
        $OriginalCommand; return
    }
    $sql = 'SELECT id FROM sessions WHERE cwd = ? AND datetime(updated_at) > datetime(''now'',''-12 hours'') ORDER BY updated_at DESC LIMIT 1'
    $tail = [IntPtr]::Zero
    if ([PsmuxStrategies.WinSqlite]::sqlite3_prepare16_v2($dbHandle, $sql, -1, [ref]$stmt, [ref]$tail) -ne $SQLITE_OK) {
        $OriginalCommand; return
    }
    [void][PsmuxStrategies.WinSqlite]::sqlite3_bind_text16($stmt, 1, $normDir, -1, $SQLITE_TRANSIENT)
    if ([PsmuxStrategies.WinSqlite]::sqlite3_step($stmt) -eq $SQLITE_ROW) {
        $ptr = [PsmuxStrategies.WinSqlite]::sqlite3_column_text16($stmt, 0)
        if ($ptr -ne [IntPtr]::Zero) {
            $sessionId = [System.Runtime.InteropServices.Marshal]::PtrToStringUni($ptr)
        }
    }
}
finally {
    if ($stmt -ne [IntPtr]::Zero) { [void][PsmuxStrategies.WinSqlite]::sqlite3_finalize($stmt) }
    if ($dbHandle -ne [IntPtr]::Zero) { [void][PsmuxStrategies.WinSqlite]::sqlite3_close($dbHandle) }
}

if ($sessionId) { "copilot --resume=$sessionId" } else { $OriginalCommand }
