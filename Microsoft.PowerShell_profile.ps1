Import-Module posh-git
Import-Module oh-my-posh

# Load up everything in the scripts folder
foreach ($scriptFile in (Get-ChildItem -Path $PSScriptRoot\scripts -Recurse -Include *.ps1))
{
  . $scriptFile.FullName
}
. $PSScriptRoot\aliases.ps1

$Env:PYTHONIOENCODING='utf-8'
iex "$(thefuck --alias)"