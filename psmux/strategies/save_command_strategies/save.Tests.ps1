#!/usr/bin/env pwsh
# Isolated process-tree tests. No live psmux server or user mappings are touched.
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:TEMP "save_strategy_$([guid]::NewGuid().ToString('N'))"
$previousHome = $env:USERPROFILE
$processes = [Collections.Generic.List[int]]::new()
$pass = 0
function Check($name, $condition) {
    if (-not $condition) { throw "FAIL: $name" }
    $script:pass++; Write-Host "PASS: $name"
}
$node = (Get-Command node.exe).Source
$cmd = Join-Path $env:WINDIR 'System32\cmd.exe'
$maps = Join-Path $root '.pi\agent\psmux-sessions'
$cli = Join-Path $root 'pi-coding-agent\dist\bundle\cli.js'
function Start-Pane($script, $sessionFile = '') {
    $p = Start-Process $cmd -ArgumentList '/d','/s','/c',"`"`"$node`" `"$script`" `"$sessionFile`"`"" -PassThru -WindowStyle Hidden
    $script:processes.Add($p.Id)
    $child = $null
    for ($i = 0; $i -lt 30 -and -not $child; $i++) {
        Start-Sleep -Milliseconds 100
        $child = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($p.Id)" |
            Where-Object Name -eq 'node.exe' | Select-Object -First 1
    }
    if (-not $child) { throw 'Node stand-in failed to start' }
    $script:processes.Add([int]$child.ProcessId)
    return @{ Pane = $p.Id; Child = [int]$child.ProcessId; Created = $child.CreationDate }
}
function MapFile($info) { Join-Path $maps "$($info.Child)-00000000-0000-0000-0000-000000000000.json" }
function Seed($info, $id, $file) {
    @{ sessionId = $id; sessionFile = $file } | ConvertTo-Json -Compress |
        Set-Content -LiteralPath (MapFile $info)
}
function Resolve($command, $pane, $strategy = 'save') {
    $output = @(& pwsh -NoProfile -File (Join-Path $PSScriptRoot "$strategy.ps1") $command "$pane" $root)
    if ($LASTEXITCODE -ne 0) { throw "Strategy failed: $strategy" }
    if ($output.Count -ne 1) { throw "Expected exactly one output line: $output" }
    return $output[0]
}
function Expected($file) { return 'pi --session "' + $file + '"' }
function Check-Argument($command, $file) {
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($command, [ref]$tokens, [ref]$errors)
    Check 'saved command is ASCII-only across the native stdout boundary' ($command -notmatch '[^\x20-\x7e]')
    Check 'saved command is valid PowerShell' ($errors.Count -eq 0)
    Check 'session path round-trips as one literal argument' ($ast.EndBlock.Statements[0].PipelineElements[0].CommandElements[2].Value -ceq $file)
}
try {
    New-Item -ItemType Directory -Force -Path $maps,(Split-Path $cli) | Out-Null
    'setInterval(() => {}, 1000);' | Set-Content $cli
    $env:USERPROFILE = $root
    $first = Start-Pane $cli
    $second = Start-Pane $cli
    $fileA = Join-Path $root "session A's.jsonl"
    $fileB = Join-Path $root 'session B.jsonl'
    '{"type":"session","id":"first"}' | Set-Content $fileA
    '{"type":"session","id":"second"}' | Set-Content $fileB
    Seed $first 'first' $fileA
    Seed $second 'second' $fileB
    Check 'first pane resolves its own session, with PowerShell quoting' ((Resolve 'pi' $first.Pane) -eq (Expected $fileA))
    Check-Argument (Resolve 'pi' $first.Pane) $fileA
    $smartFile = Join-Path $root ("session $([char]0x2018)$([char]0x2019)$([char]0x201a)$([char]0x201b)$([char]::ConvertFromUtf32(0x1f642))" + '$variable`test.jsonl')
    '{"type":"session","id":"first"}' | Set-Content $smartFile
    Seed $first 'first' $smartFile
    Check-Argument (Resolve 'pi' $first.Pane) $smartFile
    Seed $first 'first' $fileA
    Check 'second pane in the same directory resolves a different session' ((Resolve 'pi' $second.Pane) -eq (Expected $fileB))
    Check 'node command dispatch reaches Pi after Copilot passes through' ((Resolve 'node' $first.Pane) -eq (Expected $fileA))
    Check 'unrelated commands pass through' ((Resolve 'vim' $first.Pane) -eq 'vim')
    Check 'invalid pane PID passes through' ((Resolve 'pi' 'invalid') -eq 'pi')
    Seed $first 'second' $fileB
    Check 'session replacement changes the saved command' ((Resolve 'pi' $first.Pane) -eq (Expected $fileB))
    $map = MapFile $first
    (Get-Item $map).LastWriteTime = $first.Created.AddMinutes(-5)
    Check 'PID reuse: mapping older than process is ignored' ((Resolve 'pi' $first.Pane) -eq 'pi')
    Seed $first 'first' (Join-Path $root 'absent.jsonl')
    Check 'not-yet-durable or deleted session passes through' ((Resolve 'pi' $first.Pane) -eq 'pi')
    Seed $first 'mismatched' $fileA
    Check 'session header must match the mapping ID' ((Resolve 'pi' $first.Pane) -eq 'pi')
    '{broken json' | Set-Content $map
    Check 'corrupt mapping passes through' ((Resolve 'pi' $first.Pane) -eq 'pi')
    Remove-Item $map
    Check 'missing mapping passes through' ((Resolve 'pi' $first.Pane) -eq 'pi')
    $otherCli = Join-Path $root 'other.js'
    'setInterval(() => {}, 1000);' | Set-Content $otherCli
    $other = Start-Pane $otherCli
    Seed $other 'first' $fileA
    Check 'mapping on an unrelated Node process is ignored' ((Resolve 'node' $other.Pane) -eq 'node')
    Check 'Copilot dispatch preserves the original fallback' ((Resolve 'clod' $other.Pane) -eq 'clod')

    # Windows preserves an orphan's original parent ID. A reused PID is not an ancestor.
    $orphan = @{ Child = 102 }
    Seed $orphan 'first' $fileA
    $now = Get-Date
    $fixture = @(
        [pscustomobject]@{ ProcessId = 101; ParentProcessId = 0; CreationDate = $now; Name = 'pwsh.exe'; CommandLine = '' },
        [pscustomobject]@{ ProcessId = 102; ParentProcessId = 101; CreationDate = $now.AddMinutes(-9); Name = 'node.exe'; CommandLine = 'node C:\pi-coding-agent\dist\bundle\cli.js' }
    )
    $piStrategy = Join-Path $PSScriptRoot 'pi.ps1'
    $resolved = & {
        function Get-CimInstance { $fixture }
        & $piStrategy 'pi' '101' $root
    }
    Check 'orphan predating reused parent PID cannot belong to that pane' ($resolved -eq 'pi')
    $fixture[0].CreationDate = $now.AddMinutes(-10)
    $resolved = & {
        function Get-CimInstance { $fixture }
        & $piStrategy 'pi' '101' $root
    }
    Check 'creation-time traversal accepts a genuine parent-child edge' ($resolved -eq (Expected $fileA))

    # Exercise the real extension in a pane-owned Node process, then resolve its output.
    # Only the Pi event source is a stand-in; publication/scavenging/lookup are real.
    $extensionPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\pi\agent\extensions\psmux-session-map.ts'))
    $extensionUrl = ([uri]$extensionPath).AbsoluteUri | ConvertTo-Json -Compress
    @"
process.env.PSMUX_SESSION = 'isolated';
process.env.TMUX = 'isolated,1,0';
process.env.TMUX_PANE = '%1';
import($extensionUrl).then(({ default: extension }) => {
  const handlers = new Map();
  extension({ on: (name, handler) => handlers.set(name, handler) });
  handlers.get('session_start')({}, { mode: 'tui', sessionManager: {
    getSessionId: () => 'first', getSessionFile: () => process.argv[2]
  }});
  setInterval(() => {}, 1000);
});
"@ | Set-Content $cli
    $published = Start-Pane $cli $fileA
    $publishedMap = $null
    for ($i = 0; $i -lt 30 -and -not $publishedMap; $i++) {
        $publishedMap = Get-ChildItem -LiteralPath $maps -Filter "$($published.Child)-*.json" | Select-Object -First 1
        if (-not $publishedMap) { Start-Sleep -Milliseconds 100 }
    }
    Check 'extension publishes the owning Node PID' ($null -ne $publishedMap)
    Check 'extension -> PID map -> pane -> exact saved command' ((Resolve 'pi' $published.Pane) -eq (Expected $fileA))
    Write-Host "save command strategy: $pass checks passed"
} finally {
    foreach ($p in $processes) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
    $env:USERPROFILE = $previousHome
    Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
}
