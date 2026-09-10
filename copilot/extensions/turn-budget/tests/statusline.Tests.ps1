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
        [string] $StateSessionId = $sessionId,
        [object] $PendingOverride = $null,
        [string] $ExtensionGeneration = '00000000000000000100',
        [string] $ExtensionInstanceId = 'instance',
        [long] $Revision = 1
    )

    if ([string]::IsNullOrWhiteSpace($Heartbeat)) {
        $Heartbeat = [datetime]::UtcNow.ToString('O', [System.Globalization.CultureInfo]::InvariantCulture)
    }

    [ordered]@{
        schemaVersion = 1
        sessionId = $StateSessionId
        extensionGeneration = $ExtensionGeneration
        extensionInstanceId = $ExtensionInstanceId
        revision = $Revision
        heartbeatAt = $Heartbeat
        health = [ordered]@{ status = $Health }
        accounting = [ordered]@{
            schemaVersion = 1
            mode = $Mode
            pendingOverride = $PendingOverride
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
        ($output -eq 'S 3,961 AIC ($39.61) | T 327 / 1,000 AIC ($3.27 / $10) - PASSIVE') $output

    Write-State (New-State -OpenUnit (New-Unit -UsedNanoAiu 1000000000))
    $snapshotPath = Join-Path $stateDirectory 'state.00000000000000000100.0000000000000002.instance.json'
    New-State -OpenUnit (New-Unit -UsedNanoAiu 327123400000) -Revision 2 |
        ConvertTo-Json -Depth 8 |
        Set-Content -LiteralPath $snapshotPath
    $output = Invoke-Renderer
    Check 'versioned snapshot takes precedence over legacy state' `
        ($output -eq 'S 3,961 AIC ($39.61) | T 327 / 1,000 AIC ($3.27 / $10) - PASSIVE') $output

    $newGenerationPath = Join-Path $stateDirectory 'state.00000000000000000200.0000000000000002.instance.json'
    New-State `
        -OpenUnit (New-Unit -UsedNanoAiu 900000000000) `
        -ExtensionGeneration '00000000000000000200' `
        -Revision 2 |
        ConvertTo-Json -Depth 8 |
        Set-Content -LiteralPath $newGenerationPath
    $output = Invoke-Renderer
    Check 'newer generation wins an equal revision race' `
        ($output -eq 'S 3,961 AIC ($39.61) | T 900 / 1,000 AIC ($9 / $10) - PASSIVE') $output
    Remove-Item -LiteralPath $snapshotPath, $newGenerationPath -Force

    $invalidSnapshotIdentities = @(
        [ordered]@{
            Name = 'snapshot instance mismatch'
            Path = 'state.00000000000000000300.0000000000000003.filename.json'
            State = New-State `
                -OpenUnit (New-Unit -UsedNanoAiu 900000000000) `
                -ExtensionGeneration '00000000000000000300' `
                -ExtensionInstanceId 'payload' `
                -Revision 3
        },
        [ordered]@{
            Name = 'snapshot instance case mismatch'
            Path = 'state.00000000000000000301.0000000000000003.INSTANCE.json'
            State = New-State `
                -OpenUnit (New-Unit -UsedNanoAiu 900000000000) `
                -ExtensionGeneration '00000000000000000301' `
                -ExtensionInstanceId 'instance' `
                -Revision 3
        },
        [ordered]@{
            Name = 'snapshot array generation'
            Path = 'state.00000000000000000302.0000000000000003.instance.json'
            State = New-State `
                -OpenUnit (New-Unit -UsedNanoAiu 900000000000) `
                -ExtensionGeneration '00000000000000000302' `
                -Revision 3
        },
        [ordered]@{
            Name = 'snapshot array revision'
            Path = 'state.00000000000000000303.0000000000000003.instance.json'
            State = New-State `
                -OpenUnit (New-Unit -UsedNanoAiu 900000000000) `
                -ExtensionGeneration '00000000000000000303' `
                -Revision 3
        },
        [ordered]@{
            Name = 'snapshot array instance'
            Path = 'state.00000000000000000304.0000000000000003.instance.json'
            State = New-State `
                -OpenUnit (New-Unit -UsedNanoAiu 900000000000) `
                -ExtensionGeneration '00000000000000000304' `
                -Revision 3
        }
    )
    $invalidSnapshotIdentities[2].State.extensionGeneration = @('00000000000000000302')
    $invalidSnapshotIdentities[3].State.revision = @(3)
    $invalidSnapshotIdentities[4].State.extensionInstanceId = @('instance')

    foreach ($case in $invalidSnapshotIdentities) {
        $path = Join-Path $stateDirectory $case.Path
        $case.State |
            ConvertTo-Json -Depth 8 |
            Set-Content -LiteralPath $path
        $output = Invoke-Renderer
        Check "$($case.Name) fails visibly" `
            ($output -eq 'S 3,961 AIC ($39.61) | T ? - PASSIVE') $output
        Remove-Item -LiteralPath $path -Force
    }

    Write-State (New-State -LatestUnit (New-Unit -UsedNanoAiu 842000000000))
    $output = Invoke-Renderer
    Check 'idle state uses latest completed unit' `
        ($output -eq 'S 3,961 AIC ($39.61) | T 842 / 1,000 AIC ($8.42 / $10) - PASSIVE') $output

    Write-State (New-State)
    $output = Invoke-Renderer -SessionNanoAiu 0
    Check 'fresh session shows zero with ordinary default' `
        ($output -eq 'S 0 AIC ($0) | T 0 / 1,000 AIC ($0 / $10) - PASSIVE') $output

    Write-State (New-State -OpenUnit (New-Unit -UsedNanoAiu 125500000000 -CapAiCredits 250))
    $output = Invoke-Renderer
    Check 'explicit native cap is rendered from the unit' `
        ($output -eq 'S 3,961 AIC ($39.61) | T 126 / 250 AIC ($1.26 / $2.5) - PASSIVE') $output

    $pending = [ordered]@{
        aiCredits = 2000
        setAt = [datetime]::UtcNow.ToString(
            "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
            [System.Globalization.CultureInfo]::InvariantCulture
        )
        setEventId = 'budget-next'
    }
    Write-State (New-State -LatestUnit (New-Unit -UsedNanoAiu 842000000000) -PendingOverride $pending)
    $output = Invoke-Renderer
    Check 'pending next override remains visible while idle' `
        ($output -eq 'S 3,961 AIC ($39.61) | T 842 / 1,000 AIC ($8.42 / $10) - NEXT 2,000 AIC - PASSIVE') $output

    $invalidPendingOverrides = @(
        [ordered]@{
            Name = 'string AIC'
            Value = [ordered]@{
                aiCredits = '2000'
                setAt = [datetime]::UtcNow.ToString('O')
                setEventId = 'budget-next'
            }
        },
        [ordered]@{
            Name = 'unsafe integer AIC'
            Value = [ordered]@{
                aiCredits = 9007199254740992
                setAt = [datetime]::UtcNow.ToString('O')
                setEventId = 'budget-next'
            }
        },
        [ordered]@{
            Name = 'numeric event ID'
            Value = [ordered]@{
                aiCredits = 2000
                setAt = [datetime]::UtcNow.ToString('O')
                setEventId = 1
            }
        },
        [ordered]@{
            Name = 'array AIC'
            Value = [ordered]@{
                aiCredits = @(2000)
                setAt = [datetime]::UtcNow.ToString('O')
                setEventId = 'budget-next'
            }
        },
        [ordered]@{
            Name = 'array timestamp'
            Value = [ordered]@{
                aiCredits = 2000
                setAt = @([datetime]::UtcNow.ToString('O'))
                setEventId = 'budget-next'
            }
        },
        [ordered]@{
            Name = 'array event ID'
            Value = [ordered]@{
                aiCredits = 2000
                setAt = [datetime]::UtcNow.ToString('O')
                setEventId = @('budget-next')
            }
        },
        [ordered]@{
            Name = 'time-only timestamp'
            Value = [ordered]@{
                aiCredits = 2000
                setAt = '12:30'
                setEventId = 'budget-next'
            }
        },
        [ordered]@{
            Name = 'array value'
            Value = @(
                [ordered]@{
                    aiCredits = 2000
                    setAt = [datetime]::UtcNow.ToString('O')
                    setEventId = 'budget-next'
                }
            )
        }
    )

    foreach ($case in $invalidPendingOverrides) {
        Write-State (New-State -PendingOverride $case.Value)
        $output = Invoke-Renderer
        Check "invalid pending override ($($case.Name)) fails visibly" `
            ($output -eq 'S 3,961 AIC ($39.61) | T ? - PASSIVE') $output
    }

    Remove-Item -LiteralPath $statePath -Force
    $output = Invoke-Renderer
    Check 'missing state fails visibly' `
        ($output -eq 'S 3,961 AIC ($39.61) | T ? - PASSIVE') $output

    Set-Content -LiteralPath $statePath -Value '{invalid'
    $output = Invoke-Renderer
    Check 'malformed state fails visibly' `
        ($output -eq 'S 3,961 AIC ($39.61) | T ? - PASSIVE') $output

    Write-State (New-State -StateSessionId ([guid]::NewGuid().ToString()))
    $output = Invoke-Renderer
    Check 'mismatched session fails visibly' `
        ($output -eq 'S 3,961 AIC ($39.61) | T ? - PASSIVE') $output

    $staleHeartbeat = [datetime]::UtcNow.AddMinutes(-1).ToString(
        'O',
        [System.Globalization.CultureInfo]::InvariantCulture
    )
    Write-State (New-State -Heartbeat $staleHeartbeat)
    $output = Invoke-Renderer
    Check 'stale heartbeat fails visibly' `
        ($output -eq 'S 3,961 AIC ($39.61) | T ? - PASSIVE') $output

    Write-State (New-State -Health 'fault')
    $output = Invoke-Renderer
    Check 'faulted accounting fails visibly' `
        ($output -eq 'S 3,961 AIC ($39.61) | T ? - PASSIVE') $output

    Write-State (New-State -Mode 'unsupported')
    $output = Invoke-Renderer
    Check 'unsupported accounting mode fails visibly' `
        ($output -eq 'S 3,961 AIC ($39.61) | T ? - PASSIVE') $output

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
