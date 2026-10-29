param(
    [ValidatePattern('^%\d+$')][string] $Pane,
    [string] $Socket,
    [switch] $Reminder
)
$ErrorActionPreference = 'Stop'

if ($Reminder) {
    [Console]::WriteLine('Unread reminder. Prefix + Shift+n dismisses it.')
    [Console]::Write("`e]7501;state=done:app=manual-reminder`a")
    # Stay alive without changing remain-on-exit for the application's window.
    while ($true) { Start-Sleep -Seconds 3600 }
}
if (-not $Pane -or -not $Socket) { throw 'mark-unread requires explicit -Pane %N and -Socket paths.' }

function Mux {
    $result = & psmux -S $Socket @args 2>&1
    if ($LASTEXITCODE -ne 0) { throw "psmux $args failed: $result" }
    return ($result -join "`n")
}

$window = Mux display-message -p -t $Pane '#{window_id}'
$command = "pwsh -NoLogo -NoProfile -File `"$PSCommandPath`" -Reminder"
# Serialize repeated keypresses so two helpers cannot both observe an empty window.
$server = $Socket -replace '[^a-zA-Z0-9_-]', '_'
$mutex = [Threading.Mutex]::new($false, "Local\dotfiles-unread-$server-$window")
$locked = $false
try {
    try { $locked = $mutex.WaitOne(10000) }
    catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Timed out waiting for the unread reminder toggle.' }

    $panes = Mux list-panes -t $window -F '#{pane_id}|#{pane_start_command}'
    foreach ($line in $panes -split "`n") {
        $id, $startCommand = $line -split '\|', 2
        if ($startCommand.Trim('"') -ceq $command) {
            Mux kill-pane -t $id | Out-Null
            return
        }
    }
    Mux split-window -d -v -l 3 -t $Pane -T 'Unread reminder' -- $command | Out-Null
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
