<#
.SYNOPSIS
Run pointer UI acceptance tests inside the dedicated Hyper-V VM.

.DESCRIPTION
Restores the configured checkpoint unless -ReuseVM is supplied, checks out the
exact host commit in the guest, builds PointerUi.Acceptance.slnx, launches its
runner in the logged-in desktop through a one-shot scheduled task, copies
artifacts back to the host, and powers the VM off unless -KeepRunning is
supplied.

The guest must contain a clean dotfiles checkout, the .NET 10 SDK, the
acceptance marker, and a logged-in acceptance user. The DPAPI-encrypted
PowerShell Direct credential must identify that user. The exact host commit
must be reachable from the guest's origin.

.PARAMETER MarkerPathInVM
Guest path containing the acceptance marker. Defaults to
C:\ProgramData\PointerUiAcceptance\vm.marker.
#>
#requires -Version 7.0

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $RepoPathInVM,

    [string] $VMName = 'pointer-ui-dev',

    [string] $CheckpointName = 'pointer-ui-ready',

    [string] $CredentialPath = (Join-Path $env:LOCALAPPDATA 'pointer-ui-vm\pointer-ui-dev.credential.xml'),

    [string] $MarkerPathInVM = 'C:\ProgramData\PointerUiAcceptance\vm.marker',

    [string] $HostArtifacts = (Join-Path $PSScriptRoot ('..\artifacts\pointer-ui-acceptance\{0:yyyyMMdd-HHmmss}' -f (Get-Date))),

    [ValidateRange(1, 120)]
    [int] $TimeoutMinutes = 30,

    [switch] $ReuseVM,

    [switch] $KeepRunning
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = (
    Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..')
).Path
$expectedRevision = (
    git -C $repoRoot rev-parse HEAD
).Trim()
if ($LASTEXITCODE -ne 0) {
    throw 'Unable to resolve the host Git revision.'
}

$credential = Import-Clixml -LiteralPath $CredentialPath
$interactiveUser = $credential.UserName
$interactiveUserLeaf = (
    $interactiveUser -split '[\\/]'
)[-1]
$vm = Get-VM -Name $VMName -ErrorAction Stop
$session = $null

function Stop-AcceptanceVM {
    $current = Get-VM -Name $VMName
    if ($current.State -ne 'Off') {
        Stop-VM -Name $VMName -TurnOff -Force
    }
}

function Start-AcceptanceVM {
    $state = (Get-VM -Name $VMName).State.ToString()
    switch ($state) {
        'Running' { return }
        'Paused' {
            Resume-VM -Name $VMName | Out-Null
            return
        }
        { $_ -in @('Off', 'Saved') } {
            Start-VM -Name $VMName | Out-Null
            return
        }
        default {
            throw "VM '$VMName' cannot start from state '$state'."
        }
    }
}

function Open-DirectSession {
    $deadline = (Get-Date).AddMinutes(5)
    $lastError = $null
    do {
        try {
            return New-PSSession `
                -VMName $VMName `
                -Credential $credential `
                -ErrorAction Stop
        } catch {
            $lastError = $_.Exception.Message
            Start-Sleep -Seconds 5
        }
    } until ((Get-Date) -ge $deadline)

    throw (
        "PowerShell Direct did not become ready for '$VMName'. " +
        "Last error: $lastError"
    )
}

# Stream artifacts through literal file access without wildcard expansion.
function Copy-AcceptanceArtifact {
    param(
        $Session,
        [string] $GuestPath,
        [string] $HostPath,
        [long] $ExpectedLength
    )

    New-Item `
        -ItemType Directory `
        -Path (Split-Path -Parent $HostPath) `
        -Force |
        Out-Null
    $destination = [IO.File]::Open(
        $HostPath,
        [IO.FileMode]::Create,
        [IO.FileAccess]::Write,
        [IO.FileShare]::Read)
    $written = 0L
    try {
        while ($written -lt $ExpectedLength) {
            $remaining = $ExpectedLength - $written
            $requested = [int] [Math]::Min(
                [long](4MB),
                $remaining)
            $chunk = Invoke-Command `
                -Session $Session `
                -ScriptBlock {
                    param(
                        [string] $Path,
                        [long] $Offset,
                        [int] $Count
                    )

                    $source = [IO.File]::Open(
                        $Path,
                        [IO.FileMode]::Open,
                        [IO.FileAccess]::Read,
                        (
                            [IO.FileShare]::ReadWrite -bor
                            [IO.FileShare]::Delete
                        ))
                    try {
                        $source.Seek(
                            $Offset,
                            [IO.SeekOrigin]::Begin) |
                            Out-Null
                        $buffer = [Array]::CreateInstance(
                            [byte],
                            $Count)
                        $total = 0
                        while ($total -lt $Count) {
                            $readCount = $source.Read(
                                $buffer,
                                $total,
                                $Count - $total)
                            if ($readCount -eq 0) {
                                break
                            }
                            $total += $readCount
                        }
                        if ($total -eq $Count) {
                            [pscustomobject]@{
                                Bytes = $buffer
                            }
                        } else {
                            $partial = [Array]::CreateInstance(
                                [byte],
                                $total)
                            [Array]::Copy(
                                $buffer,
                                $partial,
                                $total)
                            [pscustomobject]@{
                                Bytes = $partial
                            }
                        }
                    } finally {
                        $source.Dispose()
                    }
                } `
                -ArgumentList @(
                    $GuestPath,
                    $written,
                    $requested
                ) `
                -ErrorAction Stop
            if ($chunk.Bytes -isnot [byte[]]) {
                throw (
                    "Artifact transfer returned " +
                    "'$($chunk.Bytes.GetType().FullName)' " +
                    "instead of 'System.Byte[]'."
                )
            }
            $bytes = $chunk.Bytes
            if ($bytes.Length -eq 0) {
                throw (
                    "Artifact ended before $ExpectedLength bytes: " +
                    "'$GuestPath'."
                )
            }
            $destination.Write(
                $bytes,
                0,
                $bytes.Length)
            $written += $bytes.Length
        }
    } finally {
        $destination.Dispose()
    }

    if ($written -ne $ExpectedLength) {
        throw (
            "Artifact transfer length mismatch for '$GuestPath': " +
            "expected $ExpectedLength bytes, wrote $written."
        )
    }
}

try {
    if (-not $ReuseVM) {
        if ($vm.State -ne 'Off') {
            Stop-AcceptanceVM
        }
        Restore-VMSnapshot `
            -VMName $VMName `
            -Name $CheckpointName `
            -Confirm:$false
    }

    Start-AcceptanceVM

    $session = Open-DirectSession
    $guestArtifacts = (
        'C:\PointerUiAcceptanceArtifacts\{0}' -f
        [Guid]::NewGuid().ToString('N')
    )
    $acceptanceError = $null
    try {
        Invoke-Command -Session $session -ScriptBlock {
        param(
            [string] $RepoPath,
            [string] $Revision,
            [string] $MarkerPath,
            [string] $Artifacts,
            [int] $TimeoutMinutes,
            [string] $InteractiveUser,
            [string] $InteractiveUserLeaf
        )

        $ErrorActionPreference = 'Stop'
        Set-StrictMode -Version Latest

        $previousErrorActionPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $gitStatus = @(
                git -C $RepoPath status --porcelain 2> $null
            )
            $gitStatusExitCode = $LASTEXITCODE
            if ($gitStatusExitCode -ne 0) {
                $gitStatusError = @(
                    git -C $RepoPath status --porcelain 2>&1
                )
                $detail = if ($gitStatusError.Count -gt 0) {
                    $gitStatusError -join "`n"
                } else {
                    'No error detail was written.'
                }
                throw "Git status failed in the guest: $detail"
            }
            if ($gitStatus.Count -ne 0) {
                throw "The guest checkout is dirty: $RepoPath"
            }

            $gitFetch = @(git -C $RepoPath fetch origin 2>&1)
            if ($LASTEXITCODE -ne 0) {
                throw "Git fetch failed in the guest: $($gitFetch -join "`n")"
            }

            $gitCheckout = @(
                git -C $RepoPath checkout --detach $Revision 2>&1
            )
            if ($LASTEXITCODE -ne 0) {
                throw (
                    "Guest checkout could not select ${Revision}: " +
                    ($gitCheckout -join "`n")
                )
            }
        } finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }

        New-Item -ItemType Directory -Path $Artifacts -Force |
            Out-Null
        $solution = Join-Path `
            $RepoPath `
            'komorebi\pointer-ui\PointerUi.Acceptance.slnx'
        $loggedIn = Get-Process explorer -IncludeUserName |
            Where-Object {
                $_.UserName -and (
                    $_.UserName -eq $InteractiveUser -or
                    $_.UserName.EndsWith(
                        "\$InteractiveUserLeaf",
                        [StringComparison]::OrdinalIgnoreCase
                    )
                )
            }
        if ($null -eq $loggedIn) {
            throw "The interactive acceptance user is not logged in: $InteractiveUser"
        }

        $previousErrorActionPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            dotnet build $solution -c Release --nologo *>&1 |
                Set-Content -LiteralPath (
                    Join-Path $Artifacts 'build.log'
                )
            $buildExitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
        if ($buildExitCode -ne 0) {
            throw 'Acceptance build failed.'
        }

        $taskName = 'PointerUiAcceptance-{0}' -f [Guid]::NewGuid().ToString('N')
        $resultPath = Join-Path $Artifacts 'exit-code.txt'
        $errorPath = Join-Path $Artifacts 'error.txt'
        $runner = Join-Path `
            $RepoPath `
            'komorebi\pointer-ui\acceptance\PointerUi.Acceptance.Runner\bin\Release\net10.0-windows\PointerUi.Acceptance.Runner.dll'

        $argument = @(
            "`"$runner`"",
            '--solution', "`"$solution`"",
            '--marker', "`"$MarkerPath`"",
            '--artifacts', "`"$Artifacts`"",
            '--result', "`"$resultPath`"",
            '--error', "`"$errorPath`"",
            '--timeout-minutes', $TimeoutMinutes
        ) -join ' '
        $action = New-ScheduledTaskAction `
            -Execute (Get-Command dotnet).Source `
            -Argument $argument
        $principal = New-ScheduledTaskPrincipal `
            -UserId $InteractiveUser `
            -LogonType Interactive `
            -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet `
            -ExecutionTimeLimit (
                New-TimeSpan -Minutes ($TimeoutMinutes + 4)
            ) `
            -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries

        Register-ScheduledTask `
            -TaskName $taskName `
            -Action $action `
            -Principal $principal `
            -Settings $settings |
            Out-Null
        try {
            Start-ScheduledTask -TaskName $taskName
            # The inner test collects blame at T, Runner reports by T+2,
            # Task Scheduler stops at T+4, and this outer wait ends at T+6.
            $reportDeadlineMinutes = $TimeoutMinutes + 6
            $deadline = (Get-Date).AddMinutes(
                $reportDeadlineMinutes)
            while (
                -not (Test-Path -LiteralPath $resultPath) -and
                (Get-Date) -lt $deadline
            ) {
                Start-Sleep -Seconds 2
            }
            if (-not (Test-Path -LiteralPath $resultPath)) {
                Stop-ScheduledTask -TaskName $taskName
                throw (
                    'Acceptance task did not report within {0} minutes.' -f
                    $reportDeadlineMinutes
                )
            }
            $exitCode = (
                Get-Content -LiteralPath $resultPath -Raw
            ).Trim()
            if ($exitCode -ne '0') {
                $detail = if (Test-Path -LiteralPath $errorPath) {
                    Get-Content -LiteralPath $errorPath -Raw
                } else {
                    'No error detail was written.'
                }
                throw "Acceptance tests failed: $detail"
            }
        } finally {
            Unregister-ScheduledTask `
                -TaskName $taskName `
                -Confirm:$false `
                -ErrorAction SilentlyContinue
        }
        } -ArgumentList @(
            $RepoPathInVM,
            $expectedRevision,
            $MarkerPathInVM,
            $guestArtifacts,
            $TimeoutMinutes,
            $interactiveUser,
            $interactiveUserLeaf
        )
    } catch {
        $acceptanceError = $_
    }

    try {
        $artifactFiles = @(
            Invoke-Command `
                -Session $session `
                -ScriptBlock {
                    param([string] $Path)
                    if (Test-Path -LiteralPath $Path) {
                        $prefix = $Path.TrimEnd('\') + '\'
                        Get-ChildItem `
                            -LiteralPath $Path `
                            -Recurse `
                            -Force `
                            -File |
                            ForEach-Object {
                                [pscustomobject]@{
                                    RelativePath =
                                        $_.FullName.Substring(
                                            $prefix.Length)
                                    Length = $_.Length
                                }
                            }
                    }
                } `
                -ArgumentList $guestArtifacts
        )
        if ($artifactFiles.Count -gt 0) {
            foreach ($artifactFile in $artifactFiles) {
                Copy-AcceptanceArtifact `
                    -Session $session `
                    -GuestPath (
                        Join-Path `
                            $guestArtifacts `
                            $artifactFile.RelativePath
                    ) `
                    -HostPath (
                        Join-Path `
                            $HostArtifacts `
                            $artifactFile.RelativePath
                    ) `
                    -ExpectedLength $artifactFile.Length
            }
            Write-Output "Acceptance artifacts: $HostArtifacts"
        }
    } catch {
        if ($null -eq $acceptanceError) {
            throw
        }
        Write-Warning `
            -Message (
                "Artifact copy also failed: {0}" -f
                $_.Exception.Message
            ) `
            -WarningAction Continue
    }
    if ($null -ne $acceptanceError) {
        throw $acceptanceError
    }
} finally {
    if ($null -ne $session) {
        Remove-PSSession $session
    }
    if (-not $KeepRunning) {
        Stop-AcceptanceVM
    }
}
