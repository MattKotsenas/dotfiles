# Healthy after mousemaster installs its low-level keyboard hook. wpm truncates
# the log at each start, so the marker belongs to the current process.

$ErrorActionPreference = 'SilentlyContinue'
$log = Join-Path $env:LOCALAPPDATA 'wpm\logs\mousemaster.log'
if (-not (Test-Path $log)) { exit 1 }
if (Select-String -Path $log -Pattern 'Installed keyboard hook' -SimpleMatch -Quiet) {
    exit 0
}
exit 1
