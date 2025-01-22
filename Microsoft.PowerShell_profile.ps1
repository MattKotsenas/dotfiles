# Import modules that don't work with async profile import
# TODO: Get this to work with async profile
Import-Module -Name Terminal-Icons

function prompt {
    # oh-my-posh will override this prompt, however we want to customize it to prevent
    # PowerShell's own customization from being added.

    "[Loading...]: PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) ";
}

. $PSScriptRoot\Import-ProfileAsync.ps1 -Deferred {
    $Env:PYTHONIOENCODING='utf-8'
    iex "$(thefuck --alias)"

    Import-Module z

    oh-my-posh init pwsh --config $Env:POSH_THEMES_PATH/jandedobbeleer.omp.json | Invoke-Expression
    $Env:POSH_GIT_ENABLED = $true

    # PowerShell parameter completion shim for the dotnet CLI
    Register-ArgumentCompleter -Native -CommandName dotnet -ScriptBlock {
        param($wordToComplete, $commandAst, $cursorPosition)
            dotnet complete --position $cursorPosition "$commandAst" | ForEach-Object {
                [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
            }
    }
}

# Load up everything in the scripts folder
# TODO: Move into async
foreach ($scriptFile in (Get-ChildItem -Path $PSScriptRoot\scripts -Recurse -Include *.ps1))
{
  . $scriptFile.FullName
}
. $PSScriptRoot\aliases.ps1
