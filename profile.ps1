Import-Module posh-git
Import-Module oh-my-posh

foreach ($scriptFile in (Get-ChildItem -Path $PSScriptRoot -Recurse -Include *.ps1 -Exclude profile.ps1))
{
  . $scriptFile.FullName
}

iex "$(thefuck --alias)"