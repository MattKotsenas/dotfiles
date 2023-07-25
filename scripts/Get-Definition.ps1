<#
.SYNOPSIS
Give the definition(s) for a word

.DESCRIPTION
Give the definition(s) for a word

.PARAMETER Word
The word to define

.OUTPUTS
A collection of defintions for the provided word.
#>
function Get-Definition
{
    param
    (
        [Parameter(Mandatory = $true, ValueFromPipeline = $true)]
        [string]
        $Word
    )

    Set-StrictMode -Version 2

    $response = Invoke-WebRequest -Uri "http://services.aonaware.com/DictService/DictService.asmx/Define?word=$Word"
    $xml = [xml]($response.Content)

    $xml.WordDefinition.Definitions.Definition | fl
}