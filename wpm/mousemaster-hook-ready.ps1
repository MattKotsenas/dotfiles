# wpm CommandHealthcheck for mousemaster: reports "healthy" only once mousemaster's
# low-level keyboard hook is actually installed.
#
# Why this exists: the Windows WH_KEYBOARD_LL hook *order* is private to the kernel -
# no process can query it, it can only be enforced by install order (last installed is
# called first). kanata's unit sets Requires = ["mousemaster"], so kanata (re)starts
# only after this check passes. That makes kanata's hook the newest -> called first ->
# it eats the physical backtick before mousemaster ever sees it, which is exactly the
# ordering the CAP + ` -> F13 activation needs.
#
# Signal: mousemaster logs "Installed keyboard hook successfully" (INFO) immediately
# after SetWindowsHookEx succeeds. wpm truncates the unit log on every (re)start, so
# this only ever matches the current process's line - no stale-match risk.

$ErrorActionPreference = 'SilentlyContinue'
$log = Join-Path $env:LOCALAPPDATA 'wpm\logs\mousemaster.log'
if (-not (Test-Path $log)) { exit 1 }
if (Select-String -Path $log -Pattern 'Installed keyboard hook successfully' -SimpleMatch -Quiet) {
    exit 0
}
exit 1
