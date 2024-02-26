oh-my-posh init pwsh --config $env:POSH_THEMES_PATH/jandedobbeleer.omp.json | Invoke-Expression
$env:POSH_GIT_ENABLED = $true

Import-Module -Name Terminal-Icons

Import-Module z

# Load up everything in the scripts folder
foreach ($scriptFile in (Get-ChildItem -Path $PSScriptRoot\scripts -Recurse -Include *.ps1))
{
  . $scriptFile.FullName
}
. $PSScriptRoot\aliases.ps1

$Env:PYTHONIOENCODING='utf-8'
iex "$(thefuck --alias)"

# PowerShell parameter completion shim for the dotnet CLI
Register-ArgumentCompleter -Native -CommandName dotnet -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)
        dotnet complete --position $cursorPosition "$commandAst" | ForEach-Object {
            [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
        }
}
