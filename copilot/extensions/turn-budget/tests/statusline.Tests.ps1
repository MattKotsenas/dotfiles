#!/usr/bin/env pwsh

$ErrorActionPreference = 'Continue'
$script:pass = 0
$script:fail = 0

function Check {
    param(
        [string] $Name,
        [bool] $Condition,
        [string] $Detail = ''
    )

    if ($Condition) {
        Write-Host "  PASS: $Name" -ForegroundColor Green
        $script:pass++
    } else {
        Write-Host "  FAIL: $Name  $Detail" -ForegroundColor Red
        $script:fail++
    }
}

$renderer = Join-Path (Split-Path $PSScriptRoot -Parent) 'statusline.ps1'
$temp = Join-Path $env:TEMP "turn_budget_statusline_$([guid]::NewGuid().ToString('N'))"
$sessionId = [guid]::NewGuid().ToString()
$transcriptPath = $temp
$stateDirectory = Join-Path $temp 'files\turn-budget'
$statePath = Join-Path $stateDirectory 'state.json'

function New-State {
    param(
        [object] $OpenUnit = $null,
        [object] $LatestUnit = $null,
        [string] $Mode = 'interactive',
        [string] $Health = 'ok',
        [string] $Heartbeat = '',
        [string] $StateSessionId = $sessionId
    )

    if ([string]::IsNullOrWhiteSpace($Heartbeat)) {
        $Heartbeat = [datetime]::UtcNow.ToString('O', [System.Globalization.CultureInfo]::InvariantCulture)
    }

    [ordered]@{
        schemaVersion = 1
        sessionId = $StateSessionId
        heartbeatAt = $Heartbeat
        health = [ordered]@{ status = $Health }
        accounting = [ordered]@{
            schemaVersion = 1
            mode = $Mode
            openUnit = $OpenUnit
            latestUnit = $LatestUnit
        }
    }
}

function New-Unit {
    param(
        [decimal] $UsedNanoAiu,
        [decimal] $CapAiCredits = 1000
    )

    [ordered]@{
        usedNanoAiu = $UsedNanoAiu
        capAiCredits = $CapAiCredits
    }
}

function Write-State {
    param([object] $State)

    $State | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statePath
}

function Invoke-Renderer {
    param(
        [decimal] $SessionNanoAiu = 3961234000000,
        [string] $PayloadSessionId = $sessionId
    )

    $payload = [ordered]@{
        session_id = $PayloadSessionId
        transcript_path = $transcriptPath
        ai_used = [ordered]@{ total_nano_aiu = $SessionNanoAiu }
    } | ConvertTo-Json -Compress

    $priorNoColor = $env:NO_COLOR
    $env:NO_COLOR = '1'
    try {
        ($payload | pwsh -NoLogo -NoProfile -File $renderer) -join "`n"
    }
    finally {
        $env:NO_COLOR = $priorNoColor
    }
}

try {
    New-Item -ItemType Directory -Force -Path $stateDirectory | Out-Null

    Write-State (New-State -OpenUnit (New-Unit -UsedNanoAiu 327123400000))
    $output = Invoke-Renderer
    Check 'active unit uses open accounting' `
        ($output -eq 'S 3,961A ($39.61) | T 327/1,000A ($3.27/$10) - PASSIVE') $output

    Write-State (New-State -LatestUnit (New-Unit -UsedNanoAiu 842000000000))
    $output = Invoke-Renderer
    Check 'idle state uses latest completed unit' `
        ($output -eq 'S 3,961A ($39.61) | T 842/1,000A ($8.42/$10) - PASSIVE') $output

    Write-State (New-State)
    $output = Invoke-Renderer -SessionNanoAiu 0
    Check 'fresh session shows zero with ordinary default' `
        ($output -eq 'S 0A ($0) | T 0/1,000A ($0/$10) - PASSIVE') $output

    Write-State (New-State -OpenUnit (New-Unit -UsedNanoAiu 125500000000 -CapAiCredits 250))
    $output = Invoke-Renderer
    Check 'explicit native cap is rendered from the unit' `
        ($output -eq 'S 3,961A ($39.61) | T 126/250A ($1.26/$2.5) - PASSIVE') $output

    Remove-Item -LiteralPath $statePath -Force
    $output = Invoke-Renderer
    Check 'missing state fails visibly' `
        ($output -eq 'S 3,961A ($39.61) | T ? - PASSIVE') $output

    Set-Content -LiteralPath $statePath -Value '{invalid'
    $output = Invoke-Renderer
    Check 'malformed state fails visibly' `
        ($output -eq 'S 3,961A ($39.61) | T ? - PASSIVE') $output

    Write-State (New-State -StateSessionId ([guid]::NewGuid().ToString()))
    $output = Invoke-Renderer
    Check 'mismatched session fails visibly' `
        ($output -eq 'S 3,961A ($39.61) | T ? - PASSIVE') $output

    $staleHeartbeat = [datetime]::UtcNow.AddMinutes(-1).ToString(
        'O',
        [System.Globalization.CultureInfo]::InvariantCulture
    )
    Write-State (New-State -Heartbeat $staleHeartbeat)
    $output = Invoke-Renderer
    Check 'stale heartbeat fails visibly' `
        ($output -eq 'S 3,961A ($39.61) | T ? - PASSIVE') $output

    Write-State (New-State -Health 'fault')
    $output = Invoke-Renderer
    Check 'faulted accounting fails visibly' `
        ($output -eq 'S 3,961A ($39.61) | T ? - PASSIVE') $output

    Write-State (New-State -Mode 'unsupported')
    $output = Invoke-Renderer
    Check 'unsupported accounting mode fails visibly' `
        ($output -eq 'S 3,961A ($39.61) | T ? - PASSIVE') $output

    $output = '{}' | pwsh -NoLogo -NoProfile -File $renderer
    $plain = "$output" -replace "$([char]27)\[[0-9;]*m", ''
    Check 'malformed payload fails visibly without invented totals' `
        ($plain -eq 'S ? | T ? - PASSIVE') $plain
}
finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "`n=== turn-budget status line: $script:pass passed, $script:fail failed ===" `
    -ForegroundColor $(if ($script:fail -eq 0) { 'Green' } else { 'Red' })
exit $(if ($script:fail -eq 0) { 0 } else { 1 })
