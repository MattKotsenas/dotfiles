# Run with: pwsh -NoProfile -File psmux/scripts/unread.Tests.ps1
$ErrorActionPreference = 'Stop'
$previousEncoding = [Console]::OutputEncoding
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$namespace = 'unread-test-' + [guid]::NewGuid().ToString('N')
$root = Join-Path ([IO.Path]::GetTempPath()) $namespace
New-Item -ItemType Directory $root | Out-Null
$serverStarted = $false

function Mux {
    $result = & psmux -L $namespace @args 2>&1
    if ($LASTEXITCODE -ne 0) { throw "psmux $args failed: $result" }
    return ($result -join "`n")
}
function Equal($actual, $expected, $message) {
    if ($actual -cne $expected) { throw "${message}: expected '$expected', got '$actual'" }
    Write-Host "PASS $message"
}
function Wait-For([scriptblock] $Condition, $message) {
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
        if (& $Condition) { return }
        Start-Sleep -Milliseconds 50
    } while ([DateTime]::UtcNow -lt $deadline)
    Write-Host (Mux show-messages)
    throw "Timed out: $message"
}
function Panes { @((Mux list-panes -t $script:window -F '#{pane_id}') -split "`n") }

try {
    $config = Join-Path $root 'psmux.conf'
    $source = Get-Content (Join-Path $PSScriptRoot '..\.psmux.conf')
    $binding = @($source | Where-Object { $_ -match '^bind N run-shell ' })
    Equal $binding.Count 1 'one unread binding'
    $command = $binding[0] -replace "^bind N run-shell '|'$", ''
    $scripts = Join-Path $root 'scripts with spaces'
    New-Item -ItemType Directory $scripts | Out-Null
    Copy-Item (Join-Path $PSScriptRoot 'mark-unread.ps1') $scripts
    $command = $command.Replace('~/.psmux/scripts', $scripts.Replace('\', '/'))
    @('set -g default-shell pwsh', 'set -g program-status on') | Set-Content $config
    $program = Join-Path $root 'program.ps1'
    $ready = Join-Path $root 'ready'
    $resume = Join-Path $root 'resume'
    @'
param($Ready, $Resume)
[Console]::WriteLine('Original application output')
[Console]::Write("`e]7501;state=error:app=unread-test`a")
[Console]::Write("`e[31")
[IO.File]::WriteAllText($Ready, '')
while (-not (Test-Path $Resume)) { Start-Sleep -Milliseconds 25 }
[Console]::WriteLine('mRED')
while ($true) { Start-Sleep -Seconds 3600 }
'@ | Set-Content $program
    Mux -f $config new-session -d -s validation -- pwsh -NoLogo -NoProfile -File $program $ready $resume | Out-Null
    $serverStarted = $true
    $script:window = Mux display-message -p '#{window_id}'
    $pane = Mux display-message -p '#{pane_id}'
    Wait-For { (Test-Path $ready) -and (Mux display-message -p '#{pane_ps_state}') -eq 'error' } 'fixture ready'
    $other = Mux new-window -n elsewhere -P -F '#{window_id}'
    Mux select-window -t $window | Out-Null
    Equal (Mux display-message -p '#{pane_ps_seen}') '1' 'application result initially acknowledged'
    Equal (Panes).Count 1 'no reminder before toggle'

    $socket = Mux display-message -p '#{socket_path}'
    if (-not $socket.Contains($namespace)) { throw "Unexpected test socket: $socket" }
    Mux run-shell $command | Out-Null
    Wait-For { (Panes).Count -eq 2 } 'reminder pane created'
    $helper = Panes | Where-Object { $_ -ne $pane }
    Wait-For { (Mux display-message -p -t $helper '#{pane_ps_state}:#{pane_ps_app}:#{pane_ps_seen}') -eq 'done:manual-reminder:0' } 'helper emits unread result'
    Equal (Mux display-message -p '#{pane_id}') $pane 'application stays focused'
    Equal (Mux display-message -p -t $helper '#{pane_height}') '3' 'reminder uses three rows'
    Equal (Mux display-message -p '#{window_ps_state}:#{window_ps_seen}') 'done:0' 'window tab receives unread status'
    Equal (Mux display-message -p -t $pane '#{pane_ps_state}:#{pane_ps_app}:#{pane_ps_seen}') 'error:unread-test:1' 'application record unchanged'
    Equal (Mux show-options -w -v remain-on-exit) 'off' 'remain-on-exit unchanged'
    New-Item -ItemType File $resume | Out-Null
    Wait-For { (Mux capture-pane -p -t $pane).Contains('RED') } 'application resumes split escape sequence'
    if ((Mux capture-pane -p -t $pane).Contains('mRED')) { throw 'Reminder tore application escape sequence' }
    if ((Mux capture-pane -p -t $pane).Contains('Unread reminder')) { throw 'Reminder wrote into application pane' }
    Write-Host 'PASS application escape sequence is not torn'
    Mux select-window -t $other | Out-Null
    Equal (Mux display-message -p -t $helper '#{pane_ps_seen}') '0' 'leaving keeps reminder unread'
    Mux select-window -t $window | Out-Null
    Equal (Mux display-message -p -t $helper '#{pane_ps_seen}') '0' 'returning to original pane leaves reminder for dismissal'

    Mux run-shell $command | Out-Null
    Wait-For { (Panes).Count -eq 1 } 'second toggle removes reminder'
    Equal (Mux display-message -p '#{pane_id}') $pane 'dismissal preserves original pane'
    Mux run-shell $command | Out-Null
    Wait-For { (Panes).Count -eq 2 } 'can create reminder again'
    $helper = Panes | Where-Object { $_ -ne $pane }
    Wait-For { (Mux display-message -p -t $helper '#{pane_ps_state}') -eq 'done' } 'second helper ready'
    Mux select-pane -t $helper | Out-Null
    Mux run-shell $command | Out-Null
    Wait-For { (Panes).Count -eq 1 } 'toggle from helper dismisses it'
    Equal (Mux display-message -p '#{pane_id}') $pane 'original pane survives helper-focused dismissal'

    # Separate windows own separate reminders.
    Mux run-shell $command | Out-Null
    Wait-For { (Panes).Count -eq 2 } 'original window reminder ready'
    Mux select-window -t $other | Out-Null
    Mux run-shell $command | Out-Null
    Wait-For { @((Mux list-panes -t $other -F '#{pane_id}') -split "`n").Count -eq 2 } 'other window reminder ready'
    Mux select-window -t $window | Out-Null
    Mux run-shell $command | Out-Null
    Wait-For { (Panes).Count -eq 1 } 'original reminder dismissed'
    Equal @((Mux list-panes -t $other -F '#{pane_id}') -split "`n").Count 2 'other window reminder survives dismissal'

    $failure = & pwsh -NoProfile -File (Join-Path $scripts 'mark-unread.ps1') -Pane $pane 2>&1
    if ($LASTEXITCODE -eq 0 -or -not $failure) { throw 'Missing socket must fail with a diagnostic' }
    Equal (Panes).Count 1 'missing socket fails without creating a pane'
} finally {
    try {
        if ($serverStarted) { Mux kill-server | Out-Null }
    } finally {
        try { Remove-Item $root -Recurse -Force }
        finally { [Console]::OutputEncoding = $previousEncoding }
    }
}
