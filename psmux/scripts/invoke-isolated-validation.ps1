<#
.SYNOPSIS
Run psmux validation inside the disposable Hyper-V development VM.

.DESCRIPTION
By default, restores the configured checkpoint, copies a host worktree into the
guest, runs the selected validation under the MSVC developer environment, and
powers the VM off when finished. The guest shares no processes or psmux state
with the host. One invocation owns a VM at a time; another fails immediately.

The worktree archive contains Git-tracked or untracked/non-ignored regular
files; tracked deletions are represented by absence. Symlinks, junctions,
reparse points, submodule/gitlink entries, and case-insensitive path collisions
abort the run. Packaging stores raw, filter-free file content in a temporary
Git object database and materializes those content-addressed objects, so later
host edits cannot change the guest source.

.PARAMETER Worktree
Host psmux worktree to copy into the VM.

.PARAMETER Mode
check runs cargo check, test runs the Rust suite, smoke runs the release build
and smoke suite, full runs release build + Rust tests + smoke, and command runs
-Command.

.PARAMETER Command
PowerShell command to run in the guest when Mode is command.

.PARAMETER TimeoutMinutes
Maximum guest command time, from 1 through 240 minutes. A timeout always powers
off the VM, including when -KeepRunning is set.

.PARAMETER VMName
Dedicated Hyper-V VM used for validation.

.PARAMETER CheckpointName
Checkpoint selected when restoration is enabled.

.PARAMETER CredentialPath
DPAPI-encrypted PowerShell Direct credential for the guest account.

.PARAMETER ReuseVM
Skip checkpoint restoration and use the guest's current disk state.

.PARAMETER KeepRunning
Skip the final VM power-off.
#>
#requires -Version 7.0

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $Worktree,

    [ValidateSet('check', 'test', 'smoke', 'full', 'command')]
    [string] $Mode = 'full',

    [string] $Command,

    [ValidateRange(1, 240)]
    [int] $TimeoutMinutes = 45,

    [string] $VMName = 'psmux-dev',

    [string] $CheckpointName = 'psmux-toolchain-ready',

    [string] $CredentialPath = (
        Join-Path $env:LOCALAPPDATA 'psmux-vm\psmux-dev.credential.xml'
    ),

    [switch] $ReuseVM,
    [switch] $KeepRunning
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($Mode -eq 'command' -and [string]::IsNullOrWhiteSpace($Command)) {
    throw '-Command is required when -Mode is command.'
}

$worktreePath = (Resolve-Path -LiteralPath $Worktree).Path
if (-not (Test-Path -LiteralPath (Join-Path $worktreePath 'Cargo.toml'))) {
    throw "'$worktreePath' is not a psmux worktree."
}
$worktreeItem = Get-Item -LiteralPath $worktreePath -Force
if ($worktreeItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    throw "The psmux worktree root cannot be a reparse point: $worktreePath"
}

$credential = Import-Clixml -LiteralPath $CredentialPath
$vm = Get-VM -Name $VMName -ErrorAction Stop

function Stop-IsolatedVM {
    $current = Get-VM -Name $VMName
    if ($current.State -ne 'Off') {
        Stop-VM -Name $VMName -TurnOff -Force
    }
}

function Open-DirectSession {
    $deadline = (Get-Date).AddMinutes(5)
    $lastError = $null
    do {
        try {
            return New-PSSession -VMName $VMName -Credential $credential -ErrorAction Stop
        } catch {
            $lastError = $_.Exception.Message
            Start-Sleep -Seconds 5
        }
    } until ((Get-Date) -ge $deadline)

    throw "PowerShell Direct did not become ready for '$VMName'. Last error: $lastError"
}

function New-GitStartInfo {
    param(
        [string[]] $Arguments,
        [string] $ObjectDirectory
    )

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $git.Source
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($name in @(
        'GIT_DIR',
        'GIT_WORK_TREE',
        'GIT_COMMON_DIR',
        'GIT_CONFIG_GLOBAL',
        'GIT_CONFIG_SYSTEM',
        'GIT_CONFIG_NOSYSTEM',
        'GIT_INDEX_FILE',
        'GIT_OBJECT_DIRECTORY',
        'GIT_ALTERNATE_OBJECT_DIRECTORIES',
        'GIT_PREFIX'
    )) {
        [void] $startInfo.Environment.Remove($name)
    }
    foreach ($name in @($startInfo.Environment.Keys)) {
        if (
            $name -eq 'GIT_CONFIG_COUNT' -or
            $name -eq 'GIT_CONFIG_PARAMETERS' -or
            $name -like 'GIT_CONFIG_KEY_*' -or
            $name -like 'GIT_CONFIG_VALUE_*'
        ) {
            [void] $startInfo.Environment.Remove($name)
        }
    }
    $startInfo.Environment['GIT_WORK_TREE'] = $worktreePath
    $startInfo.Environment['GIT_CONFIG_GLOBAL'] = 'NUL'
    $startInfo.Environment['GIT_CONFIG_NOSYSTEM'] = '1'
    $startInfo.Environment['GIT_NO_REPLACE_OBJECTS'] = '1'
    if ($ObjectDirectory) {
        $startInfo.Environment['GIT_OBJECT_DIRECTORY'] = $ObjectDirectory
    }
    [void] $startInfo.ArgumentList.Add('-c')
    [void] $startInfo.ArgumentList.Add('core.excludesFile=')
    foreach ($argument in $Arguments) {
        [void] $startInfo.ArgumentList.Add($argument)
    }
    return $startInfo
}

function Invoke-GitCapture {
    param(
        [string[]] $Arguments,
        [string] $ObjectDirectory
    )

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = New-GitStartInfo `
        -Arguments $Arguments `
        -ObjectDirectory $ObjectDirectory
    $started = $false
    try {
        [void] $process.Start()
        $started = $true
        $outputTask = $process.StandardOutput.ReadToEndAsync()
        $errorTask = $process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        $output = $outputTask.GetAwaiter().GetResult()
        $errorOutput = $errorTask.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) {
            throw "Git failed: $errorOutput"
        }
        return $output
    } finally {
        if ($started -and -not $process.HasExited) {
            $process.Kill($true)
            $process.WaitForExit()
        }
        $process.Dispose()
    }
}

function Export-GitBlob {
    param(
        [string] $ObjectId,
        [string] $Destination,
        [string] $ObjectDirectory
    )

    $parent = Split-Path -Parent $Destination
    New-Item -ItemType Directory -Path $parent -Force | Out-Null

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = New-GitStartInfo `
        -ObjectDirectory $ObjectDirectory `
        -Arguments @(
            '-C',
            $worktreePath,
            'cat-file',
            'blob',
            $ObjectId
        )
    $started = $false
    $output = $null
    try {
        [void] $process.Start()
        $started = $true
        $errorTask = $process.StandardError.ReadToEndAsync()
        $output = [System.IO.File]::Open(
            $Destination,
            [System.IO.FileMode]::Create,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        $process.StandardOutput.BaseStream.CopyTo($output)
        $process.WaitForExit()
        $errorOutput = $errorTask.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) {
            throw "Git cat-file failed: $errorOutput"
        }
    } finally {
        if ($null -ne $output) {
            $output.Dispose()
        }
        if ($started -and -not $process.HasExited) {
            $process.Kill($true)
            $process.WaitForExit()
        }
        $process.Dispose()
    }
}

function Assert-NoReparsePath {
    param(
        [string] $Root,
        [string] $RelativePath,
        [System.Collections.Generic.HashSet[string]] $CheckedPaths
    )

    $currentPath = $Root
    foreach ($component in $RelativePath -split '[/\\]') {
        $currentPath = Join-Path $currentPath $component
        if ($null -ne $CheckedPaths -and -not $CheckedPaths.Add($currentPath)) {
            continue
        }
        $item = Get-Item -LiteralPath $currentPath -Force
        if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            throw (
                'Symlink, junction, or reparse-point source paths are ' +
                "unsupported: $RelativePath"
            )
        }
    }
}

$archive = Join-Path $env:TEMP "psmux-vm-$([guid]::NewGuid()).tar.gz"
$staging = Join-Path $env:TEMP "psmux-vm-$([guid]::NewGuid()).source"
$objectDirectory = Join-Path $env:TEMP "psmux-vm-$([guid]::NewGuid()).objects"
$session = $null
$job = $null
$primaryError = $null
$cleanupErrors = [System.Collections.Generic.List[string]]::new()
$mutexName = 'Global\psmux-vm-' + $vm.Id.ToString('N')
$vmMutex = [System.Threading.Mutex]::new($false, $mutexName)
$mutexAcquired = $false
$forcePowerOff = $false

try {
    $mutexAcquired = $vmMutex.WaitOne(0)
    if (-not $mutexAcquired) {
        throw "Another validation already owns '$VMName'."
    }

    if (-not $ReuseVM) {
        $checkpoint = Get-VMSnapshot `
            -VMName $VMName `
            -Name $CheckpointName `
            -ErrorAction Stop
        Stop-IsolatedVM
        Restore-VMSnapshot -VMName $VMName -Name $checkpoint.Name -Confirm:$false
    }

    if ((Get-VM -Name $VMName).State -ne 'Running') {
        Start-VM -Name $VMName
    }
    $session = Open-DirectSession

    $git = Get-Command git.exe -ErrorAction Stop
    New-Item -ItemType Directory -Path $objectDirectory -Force | Out-Null

    $gitOutput = Invoke-GitCapture -Arguments @(
        '-C',
        $worktreePath,
        '-c',
        'core.quotePath=false',
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard'
    )

    $trackedModes = @{}
    $trackedOutput = Invoke-GitCapture -Arguments @(
        '-C',
        $worktreePath,
        'ls-files',
        '--stage',
        '-z'
    )
    foreach ($entry in $trackedOutput.Split(
        [char] 0,
        [System.StringSplitOptions]::RemoveEmptyEntries
    )) {
        $separator = $entry.IndexOf("`t")
        if ($separator -lt 0) {
            throw "Unexpected Git index entry: $entry"
        }
        $metadata = $entry.Substring(0, $separator)
        $relativePath = $entry.Substring($separator + 1)
        $trackedModes[$relativePath] = $metadata.Split(' ')[0]
    }

    $files = [System.Collections.Generic.List[object]]::new()
    $checkedPaths = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::Ordinal
    )
    $caseInsensitivePaths = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    foreach ($relativePath in $gitOutput.Split(
        [char] 0,
        [System.StringSplitOptions]::RemoveEmptyEntries
    )) {
        $entryMode = if ($trackedModes.ContainsKey($relativePath)) {
            $trackedModes[$relativePath]
        } else {
            '100644'
        }
        if ($entryMode -in '120000', '160000') {
            throw "Symlink or gitlink source entries are unsupported: $relativePath"
        }
        $fullPath = Join-Path $worktreePath $relativePath
        if (-not (Test-Path -LiteralPath $fullPath)) {
            continue
        }
        if (-not $caseInsensitivePaths.Add($relativePath)) {
            throw "Case-insensitive path collision: $relativePath"
        }
        Assert-NoReparsePath `
            -Root $worktreePath `
            -RelativePath $relativePath `
            -CheckedPaths $checkedPaths
        if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
            continue
        }
        $objectId = (
            Invoke-GitCapture `
                -ObjectDirectory $objectDirectory `
                -Arguments @(
                    '-C',
                    $worktreePath,
                    'hash-object',
                    '-w',
                    '--no-filters',
                    '--',
                    $relativePath
                )
        ).Trim()
        Assert-NoReparsePath -Root $worktreePath -RelativePath $relativePath
        $files.Add([pscustomobject]@{
            Path = $relativePath
            ObjectId = $objectId
        })
    }
    if ($files.Count -eq 0) {
        throw "'$worktreePath' contains no files to validate."
    }

    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    foreach ($file in $files) {
        Export-GitBlob `
            -ObjectId $file.ObjectId `
            -Destination (Join-Path $staging $file.Path) `
            -ObjectDirectory $objectDirectory
    }
    & tar.exe -czf $archive -C $staging .
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to archive the source snapshot."
    }

    $guestArchive = 'C:\Temp\psmux-source.tar.gz'
    $guestWorktree = 'C:\work\psmux'
    Invoke-Command -Session $session -ScriptBlock {
        New-Item -ItemType Directory -Path 'C:\Temp', 'C:\work' -Force | Out-Null
        if (Test-Path -LiteralPath 'C:\work\psmux') {
            Remove-Item 'C:\work\psmux' -Recurse -Force -ErrorAction Stop
        }
        if (Test-Path -LiteralPath 'C:\work\psmux') {
            throw 'Failed to remove the previous guest workspace.'
        }
        New-Item -ItemType Directory -Path 'C:\work\psmux' -Force | Out-Null
        Remove-Item 'C:\Temp\psmux-source.tar.gz' -Force -ErrorAction SilentlyContinue
    }
    Copy-Item -LiteralPath $archive -Destination $guestArchive -ToSession $session
    Invoke-Command -Session $session -ScriptBlock {
        tar.exe -xzf 'C:\Temp\psmux-source.tar.gz' -C 'C:\work\psmux'
        if ($LASTEXITCODE -ne 0) {
            throw 'Failed to extract psmux source.'
        }
        Remove-Item 'C:\Temp\psmux-source.tar.gz' -Force
    }

    # PowerShell 7 otherwise permits failed native programs to continue into
    # later validation steps without producing a terminating error.
    $preamble = (
        'if ($PSVersionTable.PSVersion -lt [version]''7.3'') { ' +
        'throw ''Guest PowerShell 7.3 or newer is required.'' }; ' +
        '$ErrorActionPreference = ''Stop''; ' +
        '$PSNativeCommandUseErrorActionPreference = $true; '
    )
    $releaseBuild = 'cargo build --release --target x86_64-pc-windows-msvc'
    $smokeRun = (
        '$env:PSMUX_EXE = (Resolve-Path ' +
        '''target\x86_64-pc-windows-msvc\release\psmux.exe'').Path; ' +
        '& .\tests\run_smoke_integration.ps1'
    )
    $smoke = "$releaseBuild; $smokeRun"
    $commandBody = switch ($Mode) {
        'check' {
            'cargo check --all-targets'
        }
        'test' {
            'cargo test --all-targets'
        }
        'smoke' { $smoke }
        'full' {
            "$releaseBuild; cargo test --all-targets; $smokeRun"
        }
        'command' { $Command }
    }
    $guestCommand = $preamble + $commandBody

    $job = Invoke-Command -Session $session -AsJob -ArgumentList $guestCommand -ScriptBlock {
        param([string] $CommandText)

        $ErrorActionPreference = 'Stop'

        # VsDevCmd has no PowerShell-native activation hook. Import its complete
        # environment so cargo receives the compiler, SDK, INCLUDE, and LIB paths.
        $developerEnvironment = & $env:ComSpec /d /s /c (
            'call "C:\BuildTools\Common7\Tools\VsDevCmd.bat" ' +
            '-arch=x64 -host_arch=x64 >nul && set'
        )
        if ($LASTEXITCODE -ne 0 -or @($developerEnvironment).Count -eq 0) {
            throw "VsDevCmd failed with exit code $LASTEXITCODE."
        }
        foreach ($line in $developerEnvironment) {
            $separator = $line.IndexOf('=')
            if ($separator -gt 0) {
                Set-Item -Path "Env:$($line.Substring(0, $separator))" `
                    -Value $line.Substring($separator + 1)
            }
        }

        $env:PATH = (
            "$env:USERPROFILE\.cargo\bin;" +
            'C:\Program Files\Git\cmd;' +
            'C:\Program Files\PowerShell\7;' +
            $env:PATH
        )
        Set-Location 'C:\work\psmux'
        $guestPowerShell = 'C:\Program Files\PowerShell\7\pwsh.exe'
        if (-not (Test-Path -LiteralPath $guestPowerShell -PathType Leaf)) {
            throw "Guest PowerShell is missing: $guestPowerShell"
        }

        # Redirect child streams into the Process object so compiler warnings
        # remain ordinary output rather than remoting ErrorRecords.
        $runId = [guid]::NewGuid().ToString('N')
        $commandFile = "C:\Temp\psmux-validation-$runId.ps1"
        try {
            [System.IO.File]::WriteAllText(
                $commandFile,
                $CommandText,
                [System.Text.UTF8Encoding]::new($false)
            )
            $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
            $startInfo.FileName = $guestPowerShell
            $startInfo.Arguments = (
                "-NoProfile -NonInteractive -File `"$commandFile`""
            )
            $startInfo.UseShellExecute = $false
            $startInfo.CreateNoWindow = $true
            $startInfo.WorkingDirectory = 'C:\work\psmux'
            $startInfo.RedirectStandardOutput = $true
            $startInfo.RedirectStandardError = $true
            $process = [System.Diagnostics.Process]::new()
            $process.StartInfo = $startInfo
            [void] $process.Start()
            $stdout = $process.StandardOutput.ReadToEndAsync()
            $stderr = $process.StandardError.ReadToEndAsync()
            $process.WaitForExit()

            $stdout.GetAwaiter().GetResult()
            $stderr.GetAwaiter().GetResult()
            if ($process.ExitCode -ne 0) {
                throw "Guest validation failed with exit code $($process.ExitCode)."
            }
        } finally {
            Remove-Item `
                $commandFile `
                -Force `
                -ErrorAction SilentlyContinue
        }
    }

    if (-not (Wait-Job $job -Timeout ($TimeoutMinutes * 60))) {
        $forcePowerOff = $true
        try {
            Stop-IsolatedVM
        } catch {
            $cleanupErrors.Add("Timeout Stop-IsolatedVM: $($_.Exception.Message)")
        }
        try {
            Stop-Job $job -ErrorAction Stop
        } catch {
            $cleanupErrors.Add("Stop-Job: $($_.Exception.Message)")
        }
        throw "Guest validation exceeded $TimeoutMinutes minutes; the VM will be powered off."
    }

    $guestErrors = @()
    Receive-Job $job -ErrorAction SilentlyContinue -ErrorVariable guestErrors
    if ($job.State -ne 'Completed') {
        $details = @(
            $guestErrors |
                ForEach-Object { $_.ToString().Trim() } |
                Where-Object { $_ } |
                Select-Object -Unique
        ) -join "`n"
        if ($details) {
            throw "Guest validation failed:`n$details"
        }
        $reason = $job.ChildJobs[0].JobStateInfo.Reason
        throw "Guest validation failed: $reason"
    }
} catch {
    $primaryError = $_
} finally {
    if ($null -ne $job) {
        try {
            Remove-Job $job -Force -ErrorAction Stop
        } catch {
            $cleanupErrors.Add("Remove-Job: $($_.Exception.Message)")
        }
    }
    if ($null -ne $session) {
        try {
            Remove-PSSession $session -ErrorAction Stop
        } catch {
            $cleanupErrors.Add("Remove-PSSession: $($_.Exception.Message)")
        }
    }
    Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $objectDirectory -Recurse -Force -ErrorAction SilentlyContinue
    if ($mutexAcquired -and ($forcePowerOff -or -not $KeepRunning)) {
        try {
            Stop-IsolatedVM
        } catch {
            $cleanupErrors.Add("Stop-IsolatedVM: $($_.Exception.Message)")
        }
    }
    if ($mutexAcquired) {
        try {
            $vmMutex.ReleaseMutex()
        } catch {
            $cleanupErrors.Add("ReleaseMutex: $($_.Exception.Message)")
        }
    }
    $vmMutex.Dispose()
}

if ($null -ne $primaryError) {
    if ($cleanupErrors.Count -gt 0) {
        throw (
            "$($primaryError.Exception.Message)`n" +
            "Cleanup failures:`n$($cleanupErrors -join "`n")"
        )
    }
    throw $primaryError
}
if ($cleanupErrors.Count -gt 0) {
    throw "Validation completed, but cleanup failed:`n$($cleanupErrors -join "`n")"
}
