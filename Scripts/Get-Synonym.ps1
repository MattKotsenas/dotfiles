<#
.SYNOPSIS
Give the synonyms and antonyms for a word

.DESCRIPTION
Give the synonyms and antonyms for a word

.PARAMETER Word
The word to give synonyms and anotnyms for.

.OUTPUTS
A collection of synonyms and antonyms for the provided word.
#>
function Get-Synonym
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
        $info = $app.SynonymInfo($Word)

        # Flatten the non-generic Array to a string[] and join with separators
        $synonyms = [string]::Join(', ', ($info.MeaningList() | %{ $_ }))
        $antonyms = [string]::Join(', ', ($info.AntonymList() | %{ $_ }))

        Write-Output "Synonym(s): $synonyms"
        Write-Output "Antonym(s): $antonyms"
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