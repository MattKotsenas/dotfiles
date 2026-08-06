<#
.SYNOPSIS
Start a Copilot session in YOLO mode.

.DESCRIPTION
Pass arguments to Copilot without creating persistent Git fsmonitor daemons.
Git commands may scan large worktrees more slowly.

.EXAMPLE
clod
# Starts a copilot session in the current directory.

.EXAMPLE
clod -i "Fix the failing tests"
# Starts a session with an initial prompt.
#>
function Invoke-CopilotFast {
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
        & copilot --yolo @args
    }
    finally {
        if ($null -eq $previousCount) { Remove-Item Env:GIT_CONFIG_COUNT -ErrorAction SilentlyContinue } else { $env:GIT_CONFIG_COUNT = $previousCount }
        if ($null -eq $previousKey) { Remove-Item "Env:$keyName" -ErrorAction SilentlyContinue } else { Set-Item "Env:$keyName" $previousKey }
        if ($null -eq $previousValue) { Remove-Item "Env:$valueName" -ErrorAction SilentlyContinue } else { Set-Item "Env:$valueName" $previousValue }
    }
}

Set-Alias -Name clod -Value Invoke-CopilotFast
