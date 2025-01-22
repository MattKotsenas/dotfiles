function which
{
    [CmdletBinding()]
    param
    (
        [Parameter(Mandatory = $true, ValueFromPipeline = $true)]
        [string]
        $Path
    )

    process
    {
        Set-StrictMode -Version 2
        Get-Command $Path | Select-Object -ExpandProperty Path
    }
}
