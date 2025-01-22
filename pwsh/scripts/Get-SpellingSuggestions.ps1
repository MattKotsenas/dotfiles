<#
.SYNOPSIS
Give spelling suggestions for the provided word

.DESCRIPTION
Give spelling suggestions for the provided word. If you need to spellcheck
a phrase, split the phrase into individual words and check them individually.

If no suggestions are given, your word is likely correct!

.PARAMETER Word
The word to be spellchecked.

.OUTPUTS
A collection of spelling suggestions for the provided word.
#>
function Get-SpellingSuggestions
{
    param
    (
        [Parameter(Mandatory = $true, ValueFromPipeline = $true)]
        [string]
        $Word
    )

    begin
    {
        Set-StrictMode -Version 2

        $app = New-Object -COM "Word.Application"
        $app.Documents.Add() | Out-Null
    }

    process
    {
        $app.GetSpellingSuggestions($Word) | %{ Write-Output $_.Name }
    }

    end
    {
        # Clean up
        $app.Quit()
        [System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null
        Remove-Variable app
        [GC]::Collect()
    }
}