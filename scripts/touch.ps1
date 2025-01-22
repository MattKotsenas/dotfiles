function touch
{
    [CmdletBinding()]
    param (
        [Parameter(Mandatory = $true, ValueFromPipeline = $true)]
        [string[]]
        $Path
    )

    process {
        foreach ($p in $Path)
        {
            if (Test-Path $p)
            {
                (Get-Item $p).LastWriteTime = (Get-Date)
            }
            else {
                New-Item -Path $p -ItemType File
            }
        }
    }
}