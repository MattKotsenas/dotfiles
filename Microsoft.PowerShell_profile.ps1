# Ensure delay loaded modules are available
# TODO: Remove this once errors are handled in async
if (-not (Get-Module -Name z -ListAvailable)) { throw "z not installed" }

# Import modules that don't work with async profile import
# TODO: Get this to work with async profile
Import-Module -Name Terminal-Icons

# TODO: Fix caret when inside async
oh-my-posh init pwsh --config $Env:POSH_THEMES_PATH/jandedobbeleer.omp.json | Invoke-Expression
$Env:POSH_GIT_ENABLED = $true

. $PSScriptRoot\Import-ProfileAsync.ps1 -Deferred {
    $Env:PYTHONIOENCODING='utf-8'
    iex "$(thefuck --alias)"

    Import-Module z

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
