foreach ($script in (Get-ChildItem (Join-Path $PSScriptRoot *.ps1)))
{
    . $script.FullName
}