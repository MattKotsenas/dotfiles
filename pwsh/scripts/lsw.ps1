function lsw
{
    [CmdletBinding()]
    param (
        [Parameter(Mandatory = $false, ValueFromPipeline = $true, ValueFromPipelineByPropertyName)]
        [string[]]
        $Path
    )

    begin {

    }

    process {
        $Path | Get-ChildItem | Format-Wide -AutoSize
    }

    end {

    }
}