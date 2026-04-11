<#
.SYNOPSIS
Start a Copilot session in YOLO mode.

.PARAMETER Rest
Arguments passed through to copilot.

.EXAMPLE
clod
# Starts a copilot session in the current directory.

.EXAMPLE
clod -i "Fix the failing tests"
# Starts a session with an initial prompt.
#>
function Invoke-CopilotFast {
    param (
        [Parameter(ValueFromRemainingArguments)]
        [string[]]
        $Rest
    )

    & copilot --yolo @Rest
}

Set-Alias -Name clod -Value Invoke-CopilotFast
