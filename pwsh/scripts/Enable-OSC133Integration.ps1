<#
.SYNOPSIS
Emits OSC 133;C;cmdline_url= (kitty-style command identity) and OSC 133;D
(command done) from pwsh, for terminal multiplexers that consume
shell-integration signals (psmux#299, WezTerm, kitty, ghostty, etc.).

.DESCRIPTION
Two hooks, neither of which wraps `$function:prompt`:

  * Enter / ViAcceptLine handlers are replaced to emit
    OSC 133;C;cmdline_url=<percent-encoded command> immediately after
    AcceptLine, capturing the literal command and setting an
    "in-execution" flag.

  * A `PowerShell.OnIdle` engine event handler emits OSC 133;D when the
    runspace becomes idle and the in-execution flag is set, clearing the
    flag. OnIdle fires reliably between commands regardless of who owns
    `$function:prompt`, which is what makes this robust against profile
    races (e.g. zoxide / oh-my-posh / pay-respects each wrap prompt at
    undefined times during async init).

OSC 133;A (prompt start) and OSC 133;B (input area start) are NOT emitted.
They require wrapping `$function:prompt`, which is brittle in this profile,
and they are not consumed by psmux (only OSC 133;C and 133;D are). Terminal
emulators that use A/B for scrollback navigation (kitty, iTerm2, VS Code's
integrated terminal, etc.) will lose that capability for pwsh sessions
loaded with this script; add a more robust prompt mechanism if that ever
matters in practice.

OSC 7 (cwd) is NOT emitted here. oh-my-posh handles that via its
`pwd: osc7` setting in matt.omp.json.

Coexists with oh-my-posh. The Enter handler implementation matches OMP's
contract (parse-error check + Set-TransientPrompt + AcceptLine) so transient
prompt behavior is preserved when OMP is loaded.

Idempotent: sourcing twice is a no-op.

.NOTES
This snippet is the "escape hatch" for users on pwsh without VS Code's
shellIntegration.ps1. Once oh-my-posh ships JanDeDobbeleer/oh-my-posh#7536
(`cmdline_url=` extension to its existing OSC 133;C emission), users with
`shell_integration: true` won't need this snippet at all.

For details: https://github.com/psmux/psmux/issues/299
#>

if ($global:__PsmuxOSC133Installed) { return }

# RETIRE WHEN: JanDeDobbeleer/oh-my-posh#7536 ships. Once OMP emits
# OSC 133;C;cmdline_url= natively from its `shell_integration: true` mode,
# delete this script and the line that sources it from the profile.

$global:__PsmuxOSC133LastInExec = $false
$global:__PsmuxOSC133Installed = $true

# --- Idle handler for OSC 133;D --------------------------------------------
# Wrapping `function:prompt` is unreliable here: other profile items
# (zoxide, pay-respects, etc.) wrap the prompt at undefined times during
# async init, so a wrapper installed by this script gets displaced out of
# the chain. PowerShell.OnIdle fires reliably between commands, regardless
# of who owns $function:prompt.

$global:__PsmuxOSC133IdleSubscriber = Register-EngineEvent `
    -SourceIdentifier PowerShell.OnIdle `
    -SupportEvent `
    -Action {
        if ($global:__PsmuxOSC133LastInExec) {
            $ESC = [char]27
            $BEL = [char]7
            [Console]::Write("${ESC}]133;D${BEL}")
            $global:__PsmuxOSC133LastInExec = $false
        }
    }

# --- Enter key handler ------------------------------------------------------
# Replaces oh-my-posh's bare OSC 133;C emission with the kitty-style
# parameterized form: OSC 133;C;cmdline_url=<percent-encoded command>.
# Preserves OMP's contract: parse-error check + transient prompt support.

$__psmuxEnterHandler = {
    $cmd = $null
    $cursor = $null
    $parseErrors = $null
    [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState(
        [ref]$cmd, [ref]$cursor, [ref]$parseErrors, [ref]$null
    )
    $executingCommand = $parseErrors.Count -eq 0

    try {
        # Preserve oh-my-posh transient prompt behavior if OMP is loaded.
        # Set-TransientPrompt is defined by OMP's init when transient is
        # configured; absent otherwise.
        if ($executingCommand -and (Get-Command -Name 'Set-TransientPrompt' -ErrorAction SilentlyContinue)) {
            Set-Variable -Name TooltipCommand -Value '' -Scope Script -ErrorAction SilentlyContinue
            Set-TransientPrompt
        }
    } finally {
        [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()

        if ($executingCommand) {
            $ESC = [char]27
            $BEL = [char]7
            if ([string]::IsNullOrEmpty($cmd)) {
                # Bare Enter on empty line - emit C without param so the
                # state machine still transitions cleanly.
                [Console]::Write("${ESC}]133;C${BEL}")
            } else {
                $encoded = [Uri]::EscapeDataString($cmd)
                [Console]::Write("${ESC}]133;C;cmdline_url=${encoded}${BEL}")
            }
            $global:__PsmuxOSC133LastInExec = $true
        }
    }
}

$__psmuxViEnterHandler = {
    $cmd = $null
    $cursor = $null
    $parseErrors = $null
    [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState(
        [ref]$cmd, [ref]$cursor, [ref]$parseErrors, [ref]$null
    )
    $executingCommand = $parseErrors.Count -eq 0

    try {
        if ($executingCommand -and (Get-Command -Name 'Set-TransientPrompt' -ErrorAction SilentlyContinue)) {
            Set-Variable -Name TooltipCommand -Value '' -Scope Script -ErrorAction SilentlyContinue
            Set-TransientPrompt
        }
    } finally {
        [Microsoft.PowerShell.PSConsoleReadLine]::ViAcceptLine()

        if ($executingCommand) {
            $ESC = [char]27
            $BEL = [char]7
            if ([string]::IsNullOrEmpty($cmd)) {
                [Console]::Write("${ESC}]133;C${BEL}")
            } else {
                $encoded = [Uri]::EscapeDataString($cmd)
                [Console]::Write("${ESC}]133;C;cmdline_url=${encoded}${BEL}")
            }
            $global:__PsmuxOSC133LastInExec = $true
        }
    }
}

Set-PSReadLineKeyHandler -Key Enter `
    -BriefDescription 'PsmuxOSC133EnterHandler' `
    -Description 'Emit OSC 133;C;cmdline_url= with the typed command' `
    -ScriptBlock $__psmuxEnterHandler

if ((Get-PSReadLineOption).EditMode -eq 'Vi') {
    Set-PSReadLineKeyHandler -ViMode Command -Key Enter `
        -BriefDescription 'PsmuxOSC133ViEnterHandler' `
        -Description 'Emit OSC 133;C;cmdline_url= with the typed command (Vi)' `
        -ScriptBlock $__psmuxViEnterHandler
}

# --- Enter key handler ------------------------------------------------------
# Replaces oh-my-posh's bare OSC 133;C emission with the kitty-style
# parameterized form: OSC 133;C;cmdline_url=<percent-encoded command>.
# Preserves OMP's contract: parse-error check + transient prompt support.

$__psmuxEnterHandler = {
    $cmd = $null
    $cursor = $null
    $parseErrors = $null
    [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState(
        [ref]$cmd, [ref]$cursor, [ref]$parseErrors, [ref]$null
    )
    $executingCommand = $parseErrors.Count -eq 0

    try {
        # Preserve oh-my-posh transient prompt behavior if OMP is loaded.
        # Set-TransientPrompt is defined by OMP's init when transient is
        # configured; absent otherwise.
        if ($executingCommand -and (Get-Command -Name 'Set-TransientPrompt' -ErrorAction SilentlyContinue)) {
            Set-Variable -Name TooltipCommand -Value '' -Scope Script -ErrorAction SilentlyContinue
            Set-TransientPrompt
        }
    } finally {
        [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()

        if ($executingCommand) {
            $ESC = [char]27
            $BEL = [char]7
            if ([string]::IsNullOrEmpty($cmd)) {
                # Bare Enter on empty line - emit C without param so the
                # state machine still transitions cleanly.
                [Console]::Write("${ESC}]133;C${BEL}")
            } else {
                $encoded = [Uri]::EscapeDataString($cmd)
                [Console]::Write("${ESC}]133;C;cmdline_url=${encoded}${BEL}")
            }
            $global:__PsmuxOSC133LastInExec = $true
        }
    }
}

$__psmuxViEnterHandler = {
    $cmd = $null
    $cursor = $null
    $parseErrors = $null
    [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState(
        [ref]$cmd, [ref]$cursor, [ref]$parseErrors, [ref]$null
    )
    $executingCommand = $parseErrors.Count -eq 0

    try {
        if ($executingCommand -and (Get-Command -Name 'Set-TransientPrompt' -ErrorAction SilentlyContinue)) {
            Set-Variable -Name TooltipCommand -Value '' -Scope Script -ErrorAction SilentlyContinue
            Set-TransientPrompt
        }
    } finally {
        [Microsoft.PowerShell.PSConsoleReadLine]::ViAcceptLine()

        if ($executingCommand) {
            $ESC = [char]27
            $BEL = [char]7
            if ([string]::IsNullOrEmpty($cmd)) {
                [Console]::Write("${ESC}]133;C${BEL}")
            } else {
                $encoded = [Uri]::EscapeDataString($cmd)
                [Console]::Write("${ESC}]133;C;cmdline_url=${encoded}${BEL}")
            }
            $global:__PsmuxOSC133LastInExec = $true
        }
    }
}

Set-PSReadLineKeyHandler -Key Enter `
    -BriefDescription 'PsmuxOSC133EnterHandler' `
    -Description 'Emit OSC 133;C;cmdline_url= with the typed command' `
    -ScriptBlock $__psmuxEnterHandler

if ((Get-PSReadLineOption).EditMode -eq 'Vi') {
    Set-PSReadLineKeyHandler -ViMode Command -Key Enter `
        -BriefDescription 'PsmuxOSC133ViEnterHandler' `
        -Description 'Emit OSC 133;C;cmdline_url= with the typed command (Vi)' `
        -ScriptBlock $__psmuxViEnterHandler
}
