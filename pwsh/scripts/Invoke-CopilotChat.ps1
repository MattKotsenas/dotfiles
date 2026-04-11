<#
.SYNOPSIS
Start a Copilot session for general Q&A, detached from any codebase.

.PARAMETER Prompt
An optional prompt to seed the conversation. The session remains interactive.

.PARAMETER Model
The AI model to use. Defaults to claude-opus-4.6.

.EXAMPLE
Invoke-CopilotChat
# Starts a blank Q&A session

.EXAMPLE
Invoke-CopilotChat "What are the tradeoffs between gRPC and REST?"
# Starts a session with an initial question

.EXAMPLE
ask "Explain the actor model"
# Use the alias
#>
function Invoke-CopilotChat {
    [CmdletBinding()]
    param (
        [Parameter(Position = 0, Mandatory = $false)]
        [string]
        $Prompt,

        [Parameter(Mandatory = $false)]
        [string]
        $Model = "claude-opus-4.6"
    )

    $chatRoot = Join-Path ([System.IO.Path]::GetTempPath()) "copilot-chat"
    $tempDir = Join-Path $chatRoot ([System.IO.Path]::GetRandomFileName())
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
    Push-Location $tempDir

    @"
# General Q&A Session

This is a general-purpose question and answer session, not tied to any specific codebase or project.

- Answer questions directly and concisely.
- You are not editing code or making changes to files unless explicitly asked.
- Focus on providing accurate, well-reasoned answers.
- When discussing code, provide examples inline rather than creating files.
- Use web search when the question requires current information.
"@ | Set-Content -Path "AGENTS.md" -Encoding utf8

    $copilotArgs = @(
        "--yolo",
        "--model", $Model,
        "--add-dir", $tempDir
    )

    if ($Prompt) {
        $copilotArgs += @("-i", $Prompt)
    }

    try {
        & copilot @copilotArgs
    }
    finally {
        Pop-Location
        Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Set-Alias -Name ask -Value Invoke-CopilotChat
