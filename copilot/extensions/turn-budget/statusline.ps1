#!/usr/bin/env pwsh

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$culture = [System.Globalization.CultureInfo]::GetCultureInfo('en-US')
$escape = [char]27
$separator = ' | '
$marker = ' - PASSIVE'
$useColor = -not [bool]$env:NO_COLOR

function Get-Property {
    param(
        [Parameter(Mandatory)]
        [object] $InputObject,

        [Parameter(Mandatory)]
        [string] $Name
    )

    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) {
        throw "Missing property '$Name'"
    }

    $property.Value
}

function Get-OptionalProperty {
    param(
        [Parameter(Mandatory)]
        [object] $InputObject,

        [Parameter(Mandatory)]
        [string] $Name
    )

    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }

    $property.Value
}

function ConvertTo-NonNegativeDecimal {
    param(
        [Parameter(Mandatory)]
        [object] $Value,

        [Parameter(Mandatory)]
        [string] $Name
    )

    $number = 0d
    if (-not [decimal]::TryParse(
            "$Value",
            [System.Globalization.NumberStyles]::Float,
            [System.Globalization.CultureInfo]::InvariantCulture,
            [ref] $number
        ) -or $number -lt 0) {
        throw "Invalid non-negative number '$Name'"
    }

    $number
}

function Format-AiCredits {
    param([decimal] $Value)

    $Value.ToString('#,0', $culture)
}

function Format-Usd {
    param([decimal] $AiCredits)

    ($AiCredits / 100d).ToString('#,0.##', $culture)
}

function Add-Color {
    param(
        [string] $Text,
        [int] $Code
    )

    if (-not $useColor) {
        return $Text
    }

    "$escape[$($Code)m$Text$escape[0m"
}

function Format-SessionSegment {
    param([Nullable[decimal]] $UsedNanoAiu)

    if ($null -eq $UsedNanoAiu) {
        return (Add-Color -Text 'S ?' -Code 2)
    }

    $usedAiCredits = [decimal] $UsedNanoAiu / 1000000000d
    $text = "S $(Format-AiCredits $usedAiCredits)A (`$$(Format-Usd $usedAiCredits))"
    Add-Color -Text $text -Code 2
}

function Format-TurnSegment {
    param(
        [Nullable[decimal]] $UsedNanoAiu,
        [Nullable[decimal]] $CapAiCredits
    )

    if ($null -eq $UsedNanoAiu -or $null -eq $CapAiCredits -or [decimal] $CapAiCredits -le 0) {
        return "$(Add-Color -Text 'T ?' -Code 31)$(Add-Color -Text $marker -Code 33)"
    }

    $usedAiCredits = [decimal] $UsedNanoAiu / 1000000000d
    $cap = [decimal] $CapAiCredits
    $ratio = $usedAiCredits / $cap
    $color = if ($ratio -ge 1d) { 31 } elseif ($ratio -ge 0.7d) { 33 } else { 32 }
    $text = "T $(Format-AiCredits $usedAiCredits)/$(Format-AiCredits $cap)A " +
        "(`$$(Format-Usd $usedAiCredits)/`$$(Format-Usd $cap))"

    "$(Add-Color -Text $text -Code $color)$(Add-Color -Text $marker -Code 33)"
}

function Read-Configuration {
    $configPath = Join-Path $PSScriptRoot 'config.json'
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json

    if ((Get-Property $config 'schemaVersion') -ne 1) {
        throw 'Unsupported configuration schema'
    }

    $result = [pscustomobject]@{
        OrdinaryAiCredits = ConvertTo-NonNegativeDecimal (Get-Property $config 'ordinaryAiCredits') 'ordinaryAiCredits'
        AutopilotAiCredits = ConvertTo-NonNegativeDecimal (Get-Property $config 'autopilotAiCredits') 'autopilotAiCredits'
        HeartbeatSeconds = ConvertTo-NonNegativeDecimal (Get-Property $config 'heartbeatSeconds') 'heartbeatSeconds'
    }

    if (
        $result.OrdinaryAiCredits -le 0 -or
        $result.AutopilotAiCredits -le 0 -or
        $result.HeartbeatSeconds -le 0
    ) {
        throw 'Configuration values must be positive'
    }

    $result
}

function Read-TurnState {
    param(
        [object] $Payload,
        [object] $Configuration
    )

    $sessionId = [string] (Get-Property $Payload 'session_id')
    $transcriptPath = [string] (Get-Property $Payload 'transcript_path')
    if ([string]::IsNullOrWhiteSpace($sessionId) -or [string]::IsNullOrWhiteSpace($transcriptPath)) {
        throw 'Missing session identity'
    }

    $statePath = Join-Path $transcriptPath 'files\turn-budget\state.json'
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if ((Get-Property $state 'schemaVersion') -ne 1) {
        throw 'Unsupported state schema'
    }

    if (-not [string]::Equals(
            [string] (Get-Property $state 'sessionId'),
            $sessionId,
            [System.StringComparison]::Ordinal
        )) {
        throw 'State belongs to another session'
    }

    $health = Get-Property $state 'health'
    if ((Get-Property $health 'status') -ne 'ok') {
        throw 'Accounting is unhealthy'
    }

    $heartbeat = [datetimeoffset]::MinValue
    if (-not [datetimeoffset]::TryParse(
            [string] (Get-Property $state 'heartbeatAt'),
            [System.Globalization.CultureInfo]::InvariantCulture,
            [System.Globalization.DateTimeStyles]::AssumeUniversal,
            [ref] $heartbeat
        )) {
        throw 'Invalid heartbeat'
    }

    $heartbeatAge = [datetimeoffset]::UtcNow - $heartbeat
    $maximumAgeSeconds = [math]::Max(10, [double] $Configuration.HeartbeatSeconds * 4)
    if ($heartbeatAge.TotalSeconds -gt $maximumAgeSeconds -or $heartbeatAge.TotalSeconds -lt -10) {
        throw "Accounting heartbeat is stale ($([math]::Round($heartbeatAge.TotalSeconds, 1)) seconds)"
    }

    $accounting = Get-Property $state 'accounting'
    if ((Get-Property $accounting 'schemaVersion') -ne 1) {
        throw 'Unsupported accounting schema'
    }

    $unit = Get-OptionalProperty $accounting 'openUnit'
    if ($null -eq $unit) {
        $unit = Get-OptionalProperty $accounting 'latestUnit'
    }

    if ($null -ne $unit) {
        return [pscustomobject]@{
            UsedNanoAiu = ConvertTo-NonNegativeDecimal (Get-Property $unit 'usedNanoAiu') 'usedNanoAiu'
            CapAiCredits = ConvertTo-NonNegativeDecimal (Get-Property $unit 'capAiCredits') 'capAiCredits'
        }
    }

    $mode = [string] (Get-Property $accounting 'mode')
    if ($mode -notin @('interactive', 'plan', 'autopilot')) {
        throw 'Unsupported accounting mode'
    }

    $cap = if ($mode -eq 'autopilot') {
        $Configuration.AutopilotAiCredits
    } else {
        $Configuration.OrdinaryAiCredits
    }

    [pscustomobject]@{
        UsedNanoAiu = 0d
        CapAiCredits = $cap
    }
}

$sessionUsedNanoAiu = $null
$turnUsedNanoAiu = $null
$turnCapAiCredits = $null

try {
    $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $aiUsed = Get-Property $payload 'ai_used'
    $sessionUsedNanoAiu = ConvertTo-NonNegativeDecimal (Get-Property $aiUsed 'total_nano_aiu') 'total_nano_aiu'

    $configuration = Read-Configuration
    $turnState = Read-TurnState -Payload $payload -Configuration $configuration
    $turnUsedNanoAiu = $turnState.UsedNanoAiu
    $turnCapAiCredits = $turnState.CapAiCredits
}
catch {
    if ($env:TURN_BUDGET_STATUSLINE_DEBUG) {
        [Console]::Error.WriteLine($_.Exception.Message)
    }
}

"$(Format-SessionSegment $sessionUsedNanoAiu)$separator$(Format-TurnSegment $turnUsedNanoAiu $turnCapAiCredits)"
