<#
.SYNOPSIS
Start a Copilot session with slow MCP servers disabled for faster startup.

.PARAMETER Rest
Arguments passed through to copilot.

.EXAMPLE
clod
# Starts a fast copilot session in the current directory.

.EXAMPLE
clod -i "Fix the failing tests"
# Starts a fast session with an initial prompt.
#>
function Invoke-CopilotFast {
    param (
        [Parameter(ValueFromRemainingArguments)]
        [string[]]
        $Rest
    )

    & copilot --yolo `
        --disable-mcp-server playwright `
        --disable-mcp-server azure-devops `
        --disable-mcp-server enghub `
        --disable-mcp-server workiq `
        @Rest
}

Set-Alias -Name clod -Value Invoke-CopilotFast
