# Assert verions of modules
@(
    @{ Name = "z"; Version = [System.Version]"1.1.13" },
    @{ Name = "Terminal-Icons"; Version = [System.Version]"0.11.0"}
) | Foreach-Object {
    if ((Get-Module -Name $_.Name -ListAvailable).Version -lt $_.Version) {
        throw "Module '$($_.Name)' not installed or not at least version '$($_.Version)'"
    }
}

# Load up everything in the scripts folder
foreach ($script in Get-ChildItem (Join-Path $PSScriptRoot scripts *.ps1))
{
    . $script.FullName
}

# Disable the "make the prompt red during parse error" because it conflicts with oh-my-posh
Set-PSReadLineOption -PromptText ''
function prompt {
    # oh-my-posh will override this prompt, however because we're loading it async we want communicate that the
    # real prompt is still loading.
    "[async init]: PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) ";
}

# Load modules asynchronously to improve shell startup
$null = Register-EngineEvent -SourceIdentifier PowerShell.OnIdle -MaxTriggerCount 1 -Action {
    oh-my-posh init pwsh --config (Join-Path (Split-Path $PROFILE) matt.omp.json) | Invoke-Expression
    $Env:POSH_GIT_ENABLED = $true

    Import-Module -Name Terminal-Icons
    Import-Module -Name z

    # PowerShell parameter completion shim for the dotnet CLI
    Register-ArgumentCompleter -Native -CommandName dotnet -ScriptBlock {
        param($wordToComplete, $commandAst, $cursorPosition)
            dotnet complete --position $cursorPosition "$commandAst" | ForEach-Object {
                [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
            }
    }

    $Env:PYTHONIOENCODING='utf-8'
    iex "$(thefuck --alias)"
}
