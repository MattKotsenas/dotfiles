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

function Test-IsIsoTimestamp {
    param([object] $Value)

    if (
        $Value -isnot [string] -or
        $Value -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
    ) {
        return $false
    }

    $parsed = [datetimeoffset]::MinValue
    [datetimeoffset]::TryParseExact(
        $Value,
        "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
        [System.Globalization.CultureInfo]::InvariantCulture,
        [System.Globalization.DateTimeStyles]::AssumeUniversal -bor
            [System.Globalization.DateTimeStyles]::AdjustToUniversal,
        [ref] $parsed
    )
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
    $text = "S $(Format-AiCredits $usedAiCredits) AIC (`$$(Format-Usd $usedAiCredits))"
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
    $text = "T $(Format-AiCredits $usedAiCredits) / $(Format-AiCredits $cap) AIC " +
        "(`$$(Format-Usd $usedAiCredits) / `$$(Format-Usd $cap))"
    $pending = if ($null -eq $PendingAiCredits) {
        ''
    } else {
        Add-Color -Text " - NEXT $(Format-AiCredits ([decimal] $PendingAiCredits)) AIC" -Code 36
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

function Read-LatestState {
    param([string] $StateDirectory)

    $sawSnapshots = $false
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $snapshots = @(
            Get-ChildItem -LiteralPath $StateDirectory -File -Filter 'state.*.json' |
                ForEach-Object {
                    if ($_.Name -match '^state\.(\d{20})\.(\d{16})\.([A-Za-z0-9._-]+)\.json$') {
                        [pscustomobject]@{
                            Path = $_.FullName
                            Name = $_.Name
                            Generation = $Matches[1]
                            Revision = [decimal] $Matches[2]
                            InstanceId = $Matches[3]
                        }
                    }
                } |
                Sort-Object Generation, Revision, Name -Descending
        )

        if ($snapshots.Count -eq 0) {
            if (-not $sawSnapshots) {
                $legacyPath = Join-Path $StateDirectory 'state.json'
                return [System.IO.File]::ReadAllText($legacyPath) | ConvertFrom-Json
            }
            continue
        }

        $sawSnapshots = $true
        foreach ($snapshot in $snapshots) {
            try {
                $state = [System.IO.File]::ReadAllText($snapshot.Path) | ConvertFrom-Json
                $stateGeneration = Get-Property $state 'extensionGeneration'
                $stateRevision = Get-Property $state 'revision'
                $stateInstanceId = Get-Property $state 'extensionInstanceId'
                if (
                    $stateGeneration -isnot [string] -or
                    -not [string]::Equals(
                        $stateGeneration,
                        $snapshot.Generation,
                        [System.StringComparison]::Ordinal
                    ) -or
                    -not (Test-IsJsonNumber $stateRevision) -or
                    [decimal] $stateRevision -ne [decimal]::Truncate([decimal] $stateRevision) -or
                    [decimal] $stateRevision -lt 0 -or
                    [decimal] $stateRevision -gt 9007199254740991d -or
                    [decimal] $stateRevision -ne $snapshot.Revision -or
                    $stateInstanceId -isnot [string] -or
                    -not [string]::Equals(
                        $stateInstanceId,
                        $snapshot.InstanceId,
                        [System.StringComparison]::Ordinal
                    )
                ) {
                    throw 'State snapshot identity does not match its contents'
                }
                return $state
            }
            catch [System.IO.FileNotFoundException] {
                continue
            }
        }
    }

    throw 'State snapshots changed too quickly to read'
}

function Read-MatchingHistoryUnit {
    param(
        [string] $Path,
        [object] $Unit,
        [string] $SessionId,
        [Nullable[decimal]] $ExpectedUsedNanoAiu = $null
    )

    $unitId = Get-Property $Unit 'id'
    if ($unitId -isnot [string] -or $unitId -notmatch '^[A-Za-z0-9._-]+$') {
        throw 'Invalid latest budget unit ID'
    }

    $record = [System.IO.File]::ReadAllText($Path) |
        ConvertFrom-Json -DateKind String
    if ((Get-Property $record 'schemaVersion') -ne 1) {
        throw 'Unsupported history schema'
    }

    foreach ($comparison in @(
        @('sessionId', $SessionId),
        @('recordId', $unitId),
        @('kind', (Get-Property $Unit 'kind')),
        @('startEventId', (Get-Property $Unit 'startEventId')),
        @('capSource', (Get-Property $Unit 'capSource'))
    )) {
        $value = Get-Property $record $comparison[0]
        $expected = [string] $comparison[1]
        if (
            $value -isnot [string] -or
            -not [string]::Equals(
                $value,
                $expected,
                [System.StringComparison]::Ordinal
            )
        ) {
            throw "History record conflicts with provisional state at '$($comparison[0])'"
        }
    }

    $recordKind = Get-Property $record 'kind'
    $recordOutcome = Get-Property $record 'outcome'
    $recordEndEventId = Get-Property $record 'endEventId'
    $recordStartEventId = Get-Property $record 'startEventId'
    $recordStartInteractionId = Get-Property $record 'startInteractionId'
    $recordObjectiveId = Get-Property $record 'objectiveId'
    $recordCapSource = Get-Property $record 'capSource'
    $recordStartedAt = Get-Property $record 'startedAt'
    $recordEndedAt = Get-Property $record 'endedAt'
    if (
        $recordKind -cnotin @('ordinary', 'autopilot') -or
        $recordCapSource -cnotin @(
            'explicit-native',
            'next-override',
            'autopilot-default',
            'ordinary-default'
        ) -or
        $recordOutcome -cnotin @(
            'completed',
            'interrupted',
            'mode-exit',
            'native-cap',
            'objective-deleted',
            'paused',
            'superseded'
        ) -or
        $recordEndEventId -isnot [string] -or
        [string]::IsNullOrEmpty($recordEndEventId) -or
        $recordStartEventId -isnot [string] -or
        [string]::IsNullOrEmpty($recordStartEventId) -or
        ($null -ne $recordStartInteractionId -and
            ($recordStartInteractionId -isnot [string] -or
                [string]::IsNullOrEmpty($recordStartInteractionId))) -or
        ($null -ne $recordObjectiveId -and
            (-not (Test-IsJsonNumber $recordObjectiveId) -or
                [decimal] $recordObjectiveId -ne
                    [decimal]::Truncate([decimal] $recordObjectiveId) -or
                [decimal] $recordObjectiveId -gt 9007199254740991d -or
                [decimal] $recordObjectiveId -lt -9007199254740991d)) -or
        -not (Test-IsIsoTimestamp $recordStartedAt) -or
        -not (Test-IsIsoTimestamp $recordEndedAt) -or
        [datetimeoffset] $recordEndedAt -lt [datetimeoffset] $recordStartedAt
    ) {
        throw 'History record contains unsupported values'
    }

    if (
        [datetimeoffset] $recordStartedAt -ne
        [datetimeoffset] (Get-Property $Unit 'startedAt')
    ) {
        throw "History record conflicts with provisional state at 'startedAt'"
    }

    foreach ($name in @('startInteractionId', 'objectiveId')) {
        $recordValue = Get-Property $record $name
        $unitValue = Get-Property $Unit $name
        if ($null -eq $recordValue -and $null -eq $unitValue) {
            continue
        }
        if (
            $recordValue -is [string] -and
            $unitValue -is [string] -and
            [string]::Equals(
                $recordValue,
                $unitValue,
                [System.StringComparison]::Ordinal
            )
        ) {
            continue
        }
        if (
            (Test-IsJsonNumber $recordValue) -and
            (Test-IsJsonNumber $unitValue) -and
            [decimal] $recordValue -eq [decimal] $unitValue
        ) {
            continue
        }
        throw 'History record conflicts with provisional state'
    }

    $recordUsedValue = Get-Property $record 'usedNanoAiu'
    $recordCapValue = Get-Property $record 'capAiCredits'
    if (
        -not (Test-IsJsonNumber $recordUsedValue) -or
        -not (Test-IsJsonNumber $recordCapValue)
    ) {
        throw 'History usage and cap must be JSON numbers'
    }
    $recordUsed = ConvertTo-NonNegativeDecimal $recordUsedValue 'history.usedNanoAiu'
    $recordCap = ConvertTo-NonNegativeDecimal $recordCapValue 'history.capAiCredits'
    $unitCap = ConvertTo-NonNegativeDecimal (Get-Property $Unit 'capAiCredits') 'unit.capAiCredits'
    if (
        $recordUsed -ne [decimal]::Truncate($recordUsed) -or
        $recordUsed -gt 9007199254740991d -or
        $recordCap -le 0 -or
        $recordCap -ne $unitCap -or
        ($null -ne $ExpectedUsedNanoAiu -and $recordUsed -ne $ExpectedUsedNanoAiu)
    ) {
        throw 'History record conflicts with provisional state'
    }

    $recordProvisionalProperty = $record.PSObject.Properties['provisional']
    $recordProvisional = $false
    if ($null -ne $recordProvisionalProperty) {
        if (
            $recordProvisionalProperty.Value -isnot [bool] -or
            -not $recordProvisionalProperty.Value
        ) {
            throw 'Invalid provisional history record'
        }
        $recordProvisional = $true
    }

    [pscustomobject]@{
        usedNanoAiu = $recordUsed
        capAiCredits = $recordCap
        provisional = $recordProvisional
        completionKey = @(
            [string] $recordOutcome,
            ([datetimeoffset] $recordEndedAt).ToUniversalTime().ToString('O'),
            [string] $recordEndEventId
        ) -join '|'
    }
}

function Resolve-LatestUnit {
    param(
        [object] $Unit,
        [string] $StateDirectory,
        [string] $SessionId
    )

    $unitId = Get-Property $Unit 'id'
    if ($unitId -isnot [string] -or $unitId -notmatch '^[A-Za-z0-9._-]+$') {
        throw 'Invalid latest budget unit ID'
    }

    $records = @(
        Read-MatchingHistoryUnit `
            -Path (Join-Path $StateDirectory "history\$unitId.json") `
            -Unit $Unit `
            -SessionId $SessionId
    )
    $candidateDirectory = Join-Path $StateDirectory "history\.candidates\$unitId"
    if (Test-Path -LiteralPath $candidateDirectory) {
        foreach ($candidate in Get-ChildItem -LiteralPath $candidateDirectory -File -Filter '*.json') {
            if ($candidate.Name -notmatch '^(\d{16})\.[A-Za-z0-9._-]+\.json$') {
                throw "Invalid history candidate '$($candidate.Name)'"
            }
            $candidateUsed = [decimal] $Matches[1]
            $records += Read-MatchingHistoryUnit `
                -Path $candidate.FullName `
                -Unit $Unit `
                -SessionId $SessionId `
                -ExpectedUsedNanoAiu $candidateUsed
        }
    }

    $provisionalFloor = (
        $records |
            Where-Object provisional |
            Measure-Object usedNanoAiu -Maximum
    ).Maximum
    if ($null -eq $provisionalFloor) {
        $provisionalFloor = 0d
    }
    foreach ($record in $records) {
        if (
            -not $record.provisional -and
            $record.usedNanoAiu -lt $provisionalFloor
        ) {
            throw 'History record loses known usage'
        }
    }

    $selected = $records[0]
    foreach ($record in $records | Select-Object -Skip 1) {
        if (
            $record.usedNanoAiu -gt $selected.usedNanoAiu -or
            ($record.usedNanoAiu -eq $selected.usedNanoAiu -and
                $selected.provisional -and -not $record.provisional)
        ) {
            $selected = $record
        } elseif (
            $record.usedNanoAiu -eq $selected.usedNanoAiu -and
            $record.provisional -eq $selected.provisional -and
            $record.completionKey -ne $selected.completionKey
        ) {
            throw 'History record has conflicting completions'
        }
    }

    $unitUsed = ConvertTo-NonNegativeDecimal (Get-Property $Unit 'usedNanoAiu') 'unit.usedNanoAiu'
    if ($selected.usedNanoAiu -lt $unitUsed) {
        throw 'History record loses known usage'
    }

    $selected
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

    $stateDirectory = Join-Path $transcriptPath 'files\turn-budget'
    $state = Read-LatestState $stateDirectory
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
        if ($null -ne $unit) {
            $provisionalProperty = $unit.PSObject.Properties['provisional']
            $provisional = $false
            if ($null -ne $provisionalProperty) {
                if (
                    $provisionalProperty.Value -isnot [bool] -or
                    -not $provisionalProperty.Value
                ) {
                    throw 'Invalid provisional budget unit'
                }
                $provisional = $true
            }
            $unitId = Get-OptionalProperty $unit 'id'
            $candidateDirectory = if ($unitId -is [string]) {
                Join-Path $stateDirectory "history\.candidates\$unitId"
            } else {
                $null
            }
            if (
                $provisional -or
                ($null -ne $candidateDirectory -and
                    (Test-Path -LiteralPath $candidateDirectory))
            ) {
                $unit = Resolve-LatestUnit `
                    -Unit $unit `
                    -StateDirectory $stateDirectory `
                    -SessionId $sessionId
            }
        }
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
