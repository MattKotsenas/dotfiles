<#
.SYNOPSIS
Start a Copilot session in YOLO mode.

.DESCRIPTION
Pass arguments to Copilot without creating persistent Git fsmonitor daemons;
Git commands may scan large worktrees more slowly. Additional arguments are
loaded from a private sidecar file.

.NOTES
The sidecar at ~/.copilot/clod-sidecar.txt contains one complete Copilot CLI
option per line. Options that take values use --option=value so they cannot
consume arguments passed directly to clod. After trimming, blank lines and lines
starting with # are ignored. Remaining lines are passed without PowerShell
evaluation. Sidecar arguments follow --yolo and precede direct arguments. If the
sidecar is missing or unreadable, clod warns and continues without it. An
invalid option stops clod before Copilot starts.

.EXAMPLE
clod
# Starts a copilot session in the current directory.

.EXAMPLE
clod -i "Fix the failing tests"
# Starts a session with an initial prompt.
#>
function Invoke-CopilotFast {
    function Get-ClodSidecarArguments {
        $sidecarPath = Join-Path $HOME '.copilot' 'clod-sidecar.txt'
        [string[]] $sidecarArguments = @(try {
            # Buffer the read so a mid-stream error cannot return partial arguments.
            @(
                Get-Content -LiteralPath $sidecarPath -ErrorAction Stop |
                    ForEach-Object { $_.Trim() } |
                    Where-Object { $_ -and -not $_.StartsWith('#', [StringComparison]::Ordinal) }
            )
        }
        catch {
            Write-Warning "clod sidecar unavailable: $sidecarPath ($($_.Exception.Message))"
            @()
        })

        $invalidArgument = $sidecarArguments |
            Where-Object { -not $_.StartsWith('-', [StringComparison]::Ordinal) } |
            Select-Object -First 1
        if ($invalidArgument) {
            throw "Invalid clod sidecar option in ${sidecarPath}: '$invalidArgument'. Each line must start with a hyphen."
        }

        $sidecarArguments
    }

    function Invoke-CopilotWithoutFsmonitor {
        param([string[]] $Arguments)

        $previousCount = [Environment]::GetEnvironmentVariable('GIT_CONFIG_COUNT')
        $configCount = [uint] ($previousCount ?? 0)

        # Append rather than replace config injected by a parent Copilot session.
        $keyName = "GIT_CONFIG_KEY_$configCount"
        $valueName = "GIT_CONFIG_VALUE_$configCount"
        $previousKey = [Environment]::GetEnvironmentVariable($keyName)
        $previousValue = [Environment]::GetEnvironmentVariable($valueName)

        try {
            Set-Item "Env:$keyName" 'core.fsmonitor'
            Set-Item "Env:$valueName" 'false'
            $env:GIT_CONFIG_COUNT = $configCount + 1
            & copilot --yolo @Arguments
        }
        finally {
            if ($null -eq $previousCount) { Remove-Item Env:GIT_CONFIG_COUNT -ErrorAction SilentlyContinue } else { $env:GIT_CONFIG_COUNT = $previousCount }
            if ($null -eq $previousKey) { Remove-Item "Env:$keyName" -ErrorAction SilentlyContinue } else { Set-Item "Env:$keyName" $previousKey }
            if ($null -eq $previousValue) { Remove-Item "Env:$valueName" -ErrorAction SilentlyContinue } else { Set-Item "Env:$valueName" $previousValue }
        }
    }

    [string[]] $copilotArguments = @(Get-ClodSidecarArguments) + $args
    Invoke-CopilotWithoutFsmonitor -Arguments $copilotArguments
}

Set-Alias -Name clod -Value Invoke-CopilotFast
