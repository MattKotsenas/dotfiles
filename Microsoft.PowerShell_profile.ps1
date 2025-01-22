# Import modules that don't work with async profile import
# TODO: Get this to work with async profile
Import-Module -Name Terminal-Icons

function prompt {
    # oh-my-posh will override this prompt, however we want to customize it to prevent
    # PowerShell's own customization from being added.

    "[Loading...]: PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) ";
}

. $PSScriptRoot\Import-ProfileAsync.ps1 -Deferred {
    # Note: Load items in priority order
    Import-Module z

    oh-my-posh init pwsh --config (Join-Path (Split-Path $PROFILE) matt.omp.json) | Invoke-Expression
    $Env:POSH_GIT_ENABLED = $true

    # PowerShell parameter completion shim for the dotnet CLI
    Register-ArgumentCompleter -Native -CommandName dotnet -ScriptBlock {
        param($wordToComplete, $commandAst, $cursorPosition)
            dotnet complete --position $cursorPosition "$commandAst" | ForEach-Object {
                [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
            }
    }

    # Load up everything in the scripts folder
    $root = (Split-Path $PROFILE)
    . $root\scripts\beep.ps1
    . $root\scripts\Get-Clipboard.ps1
    . $root\scripts\Get-Definition.ps1
    . $root\scripts\Get-SpellingSuggestions.ps1
    . $root\scripts\Get-Synonym.ps1
    . $root\scripts\hiyo.ps1
    . $root\scripts\horns.aiff.ps1
    . $root\scripts\New-Gitignore.ps1
    . $root\scripts\Out-Speech.ps1
    . $root\scripts\tail.ps1
    . $root\scripts\Update-EnvironmentVariables.ps1
    . $root\scripts\which.ps1
    . $root\aliases.ps1

    $Env:PYTHONIOENCODING='utf-8'
    iex "$(thefuck --alias)"
}
