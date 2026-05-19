<#
.SYNOPSIS
Emits OSC 133 (state markers) + OSC 133;C;cmdline_url= (kitty-style command
identity) from pwsh, for terminal multiplexers and terminals that consume
shell-integration signals (psmux#299, WezTerm, kitty, ghostty, etc.).

.DESCRIPTION
Two hooks:
  * `prompt` is wrapped to emit OSC 133;D (previous command done),
    OSC 133;A (prompt start), and OSC 133;B (prompt end / input start).
  * The Enter key handler is replaced to emit OSC 133;C;cmdline_url=<encoded>
    immediately after AcceptLine, capturing the literal command.

OSC 7 (cwd) is NOT emitted here — oh-my-posh handles that via its
`pwd: osc7` setting in matt.omp.json. If you change `pwd` to `osc99` or
remove it, psmux loses cwd visibility; the right fix is to keep `pwd: osc7`
in OMP, not to add OSC 7 emission back here.

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

# --- Prompt wrapper ---------------------------------------------------------
# Capture whatever prompt function is currently bound (oh-my-posh, plain pwsh,
# etc.) and wrap it with OSC emissions. Run in OnIdle queue position AFTER
# oh-my-posh init so we see OMP's prompt, not the bootstrap async-init string.

$global:__PsmuxOSC133OriginalPrompt = $function:prompt
$global:__PsmuxOSC133LastInExec = $false
$global:__PsmuxOSC133Installed = $true

function global:prompt {
    $ESC = [char]27
    $BEL = [char]7

    # OSC 133;D - previous command finished (only after at least one C).
    # Carry the previous-command exit code into the D marker for consumers
    # that surface it (e.g. monitor-activity 'on-command-finished' in psmux,
    # iTerm2's command status indicator).
    if ($global:__PsmuxOSC133LastInExec) {
        $exitCode = if ($global:?) { 0 } else { 1 }
        [Console]::Write("${ESC}]133;D;${exitCode}${BEL}")
        $global:__PsmuxOSC133LastInExec = $false
    }

    # OSC 7 (cwd) is intentionally NOT emitted here — oh-my-posh emits it via
    # its `pwd: osc7` setting in matt.omp.json (which is already invoked as
    # part of the original prompt body below).

    # OSC 133;A - prompt start.
    [Console]::Write("${ESC}]133;A${BEL}")

    # The user's actual prompt (oh-my-posh, plain pwsh, whatever was bound
    # at snippet-source time).
    & $global:__PsmuxOSC133OriginalPrompt

    # OSC 133;B - end of prompt / start of input area.
    # We can't emit this AFTER PSReadLine starts drawing - the marker must
    # be flushed BEFORE the prompt's last character is rendered, so emit it
    # as part of the prompt's returned string. Append via a final Write.
    [Console]::Write("${ESC}]133;B${BEL}")
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
