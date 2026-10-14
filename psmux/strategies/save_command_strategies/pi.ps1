#!/usr/bin/env pwsh
# Resolve a pane's current Pi session at SAVE time. No launch-argument fallback:
# after /new or /resume, launch arguments may refer to an abandoned session.
param(
    [Parameter(Position = 0)] [AllowEmptyString()] [string] $Command,
    [Parameter(Position = 1)] [AllowEmptyString()] [string] $PanePid,
    [Parameter(Position = 2)] [AllowEmptyString()] [string] $Directory
)
$ErrorActionPreference = 'Stop'
$first = (($Command -split '\s+', 2)[0] -split '[\\/]' | Select-Object -Last 1) -replace '\.exe$', ''
$panePidInt = 0
if ($first -notin @('pi', 'node') -or
    -not [int]::TryParse($PanePid, [ref]$panePidInt) -or $panePidInt -le 0) {
    Write-Output $Command; return
}

$maps = Join-Path $env:USERPROFILE '.pi\agent\psmux-sessions'
try {
    if (-not (Test-Path -LiteralPath $maps)) { Write-Output $Command; return }
    $byParent = @{}
    $byPid = @{}
    foreach ($p in (Get-CimInstance Win32_Process)) {
        $byPid[[int]$p.ProcessId] = $p
        $parent = [int]$p.ParentProcessId
        if (-not $byParent.ContainsKey($parent)) { $byParent[$parent] = [Collections.Generic.List[int]]::new() }
        $byParent[$parent].Add([int]$p.ProcessId)
    }
    $seen = @{}
    $queue = [Collections.Generic.Queue[int]]::new()
    $queue.Enqueue($panePidInt)
    while ($queue.Count) {
        $cur = $queue.Dequeue()
        if ($seen.ContainsKey($cur)) { continue }
        $seen[$cur] = $true
        $p = $byPid[$cur]
        # Pi is node.exe here. Require its CLI entrypoint, not just any Node descendant.
        if ($p -and $p.Name -eq 'node.exe' -and
            $p.CommandLine -match '[/\\]pi-coding-agent[/\\]+dist[/\\](?:bundle[/\\])?cli\.js(?:["\s]|$)') {
            foreach ($item in (Get-ChildItem -LiteralPath $maps -Filter "$cur-*.json" -File | Sort-Object LastWriteTime -Descending)) {
                $file = $item.FullName
                # Reject crash leftovers if Windows has reused the owning PID.
                if ($p.CreationDate -and $item.LastWriteTime -ge $p.CreationDate) {
                    $mapping = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
                    $sessionFile = [string]$mapping.sessionFile
                    if ($mapping.sessionId -and [IO.Path]::IsPathFullyQualified($sessionFile) -and
                        (Test-Path -LiteralPath $sessionFile -PathType Leaf)) {
                        $header = Get-Content -LiteralPath $sessionFile -TotalCount 1 | ConvertFrom-Json
                        if ($header.type -eq 'session' -and $header.id -eq $mapping.sessionId) {
                            # ASCII output survives legacy Windows console encodings. PowerShell
                            # Unicode escapes reconstruct the path; escape interpolation characters too.
                            $argument = [Text.StringBuilder]::new('"')
                            foreach ($rune in $sessionFile.EnumerateRunes()) {
                                if ($rune.Value -lt 32 -or $rune.Value -gt 126) {
                                    [void]$argument.Append('`u{' + $rune.Value.ToString('x') + '}')
                                } else {
                                    if ($rune.Value -in @(34, 36, 96)) { [void]$argument.Append('`') }
                                    [void]$argument.Append($rune.ToString())
                                }
                            }
                            [void]$argument.Append('"')
                            Write-Output "pi --session $argument"
                            return
                        }
                    }
                }
            }
        }
        if ($byParent.ContainsKey($cur)) {
            foreach ($child in $byParent[$cur]) {
                $childProcess = $byPid[$child]
                # A surviving orphan retains its original parent PID even after PID reuse.
                if ($p.CreationDate -and $childProcess.CreationDate -and
                    $childProcess.CreationDate -ge $p.CreationDate) { $queue.Enqueue($child) }
            }
        }
    }
} catch {
    # Missing, corrupt, inaccessible, or concurrently removed state cannot improve the command.
}
Write-Output $Command
