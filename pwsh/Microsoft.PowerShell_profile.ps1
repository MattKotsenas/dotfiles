Set-PSReadlineKeyHandler -Key Tab -Function MenuComplete

# Disable the "make the prompt red during parse error" because it conflicts with oh-my-posh
Set-PSReadLineOption -PromptText ''

function prompt {
    # oh-my-posh will override this prompt, however because we're loading it async we want communicate that the
    # real prompt is still loading.
    "[async init]: PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) ";
}

# Load modules asynchronously and in parallel to reduce shell startup time
@(
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
        Import-Module -Name Terminal-Icons -Global
    },
    {
        Import-Module -Name z -Global
    },
    {
        Import-Module -Name Microsoft.WinGet.CommandNotFound -Global
    },
    {
        Import-Module -Name (Join-Path (Split-Path $PROFILE) scripts UserScripts.psd1) -Global
    },
    {
        # PowerShell parameter completion shim for the dotnet CLI
        Register-ArgumentCompleter -Native -CommandName dotnet -ScriptBlock {
            param($wordToComplete, $commandAst, $cursorPosition)
                dotnet complete --position $cursorPosition "$commandAst" | ForEach-Object {
                    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
                }
        }
    },
    {
        $Env:PYTHONIOENCODING='utf-8'
        New-Module -Name thefuck -ScriptBlock { iex "$(thefuck --alias fix)" } | Import-Module -Global
    }
) | Foreach-Object { Register-EngineEvent -SourceIdentifier PowerShell.OnIdle -MaxTriggerCount 1 -SupportEvent -Action $_ } | Out-Null
