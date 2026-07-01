# Set the cursor to a solid bar (reset after neovim changes it).
# Guard against stdout redirection so escape codes don't leak when the profile
# is loaded non-interactively (e.g. pwsh -c).
if (-not [Console]::IsOutputRedirected) { [Console]::Write("`e[6 q") }

# Disable the "make the prompt red during parse error" because it conflicts with oh-my-posh
Set-PSReadLineOption -PromptText ''

# This function needs to be defined prior to the idle work, otherwise
# `Push-Location` will be for the wrong runspace.
function Invoke-PsFzfAltCCommandHandler
{
    param($Location)

    Push-Location -Path $Location
}

function prompt {
    # oh-my-posh will override this prompt, however because we're loading it async we want to communicate that the
    # real prompt is still loading.
    "[async init]: PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) ";
}

# Load modules asynchronously to reduce shell startup time.
# Chunks are ordered by priority: most-needed commands first.
# Each chunk costs ~335ms of OnIdle scheduling overhead, so trivial chunks are merged.
[System.Collections.Queue]$__initQueue = @(
    {
        Import-Module -Name (Join-Path (Split-Path $PROFILE) scripts UserScripts.psd1) -Global
    },
    {
        New-Module -ScriptBlock {
            function Set-PoshJobInfo {
                $jobs = @(Get-Job)
                $running = @($jobs | Where-Object { $_.State -eq "Running"}).Count
                if ($running -gt 0)
                {
                    $env:POSH_JOBS_RUNNING = $running
                }
                else
                {
                    Remove-Item ENV:\POSH_JOBS_RUNNING -ErrorAction SilentlyContinue
                }

                $finished = ($jobs.Count - $running)
                if ($finished -gt 0)
                {
                    $env:POSH_JOBS_FINISHED = $finished
                }
                else
                {
                    Remove-Item ENV:\POSH_JOBS_FINISHED -ErrorAction SilentlyContinue
                }
            }

            function Set-PoshContexts {
                Set-PoshJobInfo
            }

            # Set-PoshContext is a function called before the prompt is rendered.
            New-Alias -Name 'Set-PoshContext' -Value 'Set-PoshContexts' -Scope Global -Force
        } | Import-Module -Global

        oh-my-posh init pwsh --config (Join-Path (Split-Path $PROFILE) matt.omp.json) | Invoke-Expression
        $Env:POSH_GIT_ENABLED = $true
    },
    {
        # This must be loaded _after_ omp, as zoxide hooks the prompt function
        New-Module -Name zoxide -ScriptBlock { Invoke-Expression (& { (zoxide init powershell | Out-String) }) } | Import-Module -Global
        Set-Alias -Name cd -Value z -Option AllScope -Scope Global -Force
    },
    {
        # Shell integration: emit OSC 7 (cwd), OSC 133 state markers, and
        # OSC 133;C;cmdline_url= (kitty-style command identity) for terminal
        # multiplexers and terminals that consume shell-integration signals.
        # Loaded after omp + zoxide so the prompt wrapper wraps the final
        # composed prompt. See script docblock for details.
        . (Join-Path (Split-Path $PROFILE) scripts Enable-OSC133Integration.ps1)
    },
    {
        $Env:FZF_ALT_C_COMMAND = "fd --type dir --hidden --exclude .git"
        $ENV:FZF_ALT_C_OPTS = "--preview 'eza --tree --color=always --icons=always {}'"
        $Env:FZF_CTRL_T_OPTS = "--preview 'bat -n --color=always --line-range :500 {}'"

        Set-PsFzfOption -PSReadlineChordProvider 'Ctrl+t' -PSReadlineChordReverseHistory 'Ctrl+r'
        Set-PSReadLineKeyHandler -Key Tab -ScriptBlock { Invoke-FzfTabCompletion }
        Set-PsFzfOption -TabExpansion
        Set-PsFzfOption -AltCCommand ${function:Invoke-PsFzfAltCCommandHandler}
    },
    {
        Import-Module -Name Microsoft.WinGet.CommandNotFound -Global
    },
    {
        # Env vars and completions - merged to reduce OnIdle scheduling overhead
        $Env:EZA_CONFIG_DIR = "$env:USERPROFILE/.config/eza"
        $Env:BAT_CONFIG_DIR="$Env:USERPROFILE/.config/bat"
        $Env:BAT_CONFIG_PATH="$Env:USERPROFILE/.config/bat/bat.conf"

        # PowerShell parameter completion shim for the dotnet CLI
        Register-ArgumentCompleter -Native -CommandName dotnet -ScriptBlock {
            param($wordToComplete, $commandAst, $cursorPosition)
                dotnet complete --position $cursorPosition "$commandAst" | ForEach-Object {
                    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
                }
        }
    },
    {
        $Env:_PR_LIB = Join-Path $env:USERPROFILE '.config' 'pay-respects' 'modules'
        New-Module -Name pay-respects -ScriptBlock ([scriptblock]::Create((pay-respects pwsh --alias fix | Out-String))) | Import-Module -Global
    }
)

if ($env:PSMUX_SESSION) {
    # psmux pre-warms the pane, so load synchronously; the pane is fully ready before the user interacts.
    while ($__initQueue.Count -gt 0) { & $__initQueue.Dequeue() }
    Remove-Variable -Name '__initQueue' -Scope Global -Force
} else {
    # No psmux, so load asynchronously to allow typing interleaved with initialization.
    Register-EngineEvent -SourceIdentifier PowerShell.OnIdle -SupportEvent -Action {
        if ($__initQueue.Count -gt 0) {
            & $__initQueue.Dequeue()
        } else {
            Unregister-Event -SubscriptionId $EventSubscriber.SubscriptionId -Force
            Remove-Variable -Name '__initQueue' -Scope Global -Force
            [Microsoft.PowerShell.PSConsoleReadLine]::InvokePrompt()
        }
    }
}
