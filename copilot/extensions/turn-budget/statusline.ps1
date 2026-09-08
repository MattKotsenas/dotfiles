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

    return ,$property.Value
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

    return ,$property.Value
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

function Test-IsJsonNumber {
    param([object] $Value)

    $Value -is [byte] -or
    $Value -is [sbyte] -or
    $Value -is [short] -or
    $Value -is [ushort] -or
    $Value -is [int] -or
    $Value -is [uint] -or
    $Value -is [long] -or
    $Value -is [ulong] -or
    $Value -is [float] -or
    $Value -is [double] -or
    $Value -is [decimal]
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
        [Nullable[decimal]] $CapAiCredits,
        [Nullable[decimal]] $PendingAiCredits
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
    $pending = if ($null -eq $PendingAiCredits) {
        ''
    } else {
        Add-Color -Text " - NEXT $(Format-AiCredits ([decimal] $PendingAiCredits))A" -Code 36
    }

    "$(Add-Color -Text $text -Code $color)$pending$(Add-Color -Text $marker -Code 33)"
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

    $pendingProperty = $accounting.PSObject.Properties['pendingOverride']
    $pendingOverride = $null
    if ($null -ne $pendingProperty) {
        $pendingOverride = $pendingProperty.Value
    }
    $pendingAiCredits = $null
    if ($null -ne $pendingOverride) {
        if ($pendingOverride -isnot [System.Management.Automation.PSCustomObject]) {
            throw 'Invalid pending override'
        }

        $pendingAiCreditsValue = Get-Property $pendingOverride 'aiCredits'
        if (-not (Test-IsJsonNumber $pendingAiCreditsValue)) {
            throw 'Pending override AIC must be a number'
        }

        $pendingAiCredits = ConvertTo-NonNegativeDecimal $pendingAiCreditsValue 'pendingOverride.aiCredits'
        if (
            $pendingAiCredits -le 0 -or
            $pendingAiCredits -ne [decimal]::Truncate($pendingAiCredits) -or
            $pendingAiCredits -gt 9007199254740991d
        ) {
            throw 'Pending override must be a positive safe integer'
        }

        $pendingSetAtValue = Get-Property $pendingOverride 'setAt'
        $pendingSetAt = [datetimeoffset]::MinValue
        if ($pendingSetAtValue -is [datetime]) {
            $pendingSetAt = [datetimeoffset] $pendingSetAtValue
        } elseif (
            $pendingSetAtValue -isnot [string] -or
            -not [datetimeoffset]::TryParseExact(
                $pendingSetAtValue,
                "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
                [System.Globalization.CultureInfo]::InvariantCulture,
                [System.Globalization.DateTimeStyles]::AssumeUniversal -bor
                    [System.Globalization.DateTimeStyles]::AdjustToUniversal,
                [ref] $pendingSetAt
            )
        ) {
            throw 'Invalid pending override timestamp'
        }

        $pendingEventId = Get-Property $pendingOverride 'setEventId'
        if ($pendingEventId -isnot [string] -or [string]::IsNullOrWhiteSpace($pendingEventId)) {
            throw 'Invalid pending override event'
        }
    }

    $unit = Get-OptionalProperty $accounting 'openUnit'
    if ($null -eq $unit) {
        $unit = Get-OptionalProperty $accounting 'latestUnit'
    }

    if ($null -ne $unit) {
        return [pscustomobject]@{
            UsedNanoAiu = ConvertTo-NonNegativeDecimal (Get-Property $unit 'usedNanoAiu') 'usedNanoAiu'
            CapAiCredits = ConvertTo-NonNegativeDecimal (Get-Property $unit 'capAiCredits') 'capAiCredits'
            PendingAiCredits = $pendingAiCredits
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
        PendingAiCredits = $pendingAiCredits
    }
}

$sessionUsedNanoAiu = $null
$turnUsedNanoAiu = $null
$turnCapAiCredits = $null
$pendingAiCredits = $null

try {
    $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $aiUsed = Get-Property $payload 'ai_used'
    $sessionUsedNanoAiu = ConvertTo-NonNegativeDecimal (Get-Property $aiUsed 'total_nano_aiu') 'total_nano_aiu'

    $configuration = Read-Configuration
    $turnState = Read-TurnState -Payload $payload -Configuration $configuration
    $turnUsedNanoAiu = $turnState.UsedNanoAiu
    $turnCapAiCredits = $turnState.CapAiCredits
    $pendingAiCredits = $turnState.PendingAiCredits
}
catch {
    if ($env:TURN_BUDGET_STATUSLINE_DEBUG) {
        [Console]::Error.WriteLine($_.Exception.Message)
    }
}

"$(Format-SessionSegment $sessionUsedNanoAiu)$separator$(Format-TurnSegment $turnUsedNanoAiu $turnCapAiCredits $pendingAiCredits)"
