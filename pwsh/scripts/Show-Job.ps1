function Show-Job {
    [CmdletBinding()]
    param (
        [Parameter(Mandatory = $true, ValueFromPipeline = $true, ValueFromPipelineByPropertyName)]
        [int[]]
        $Id
    )

    begin {

    }

    process {
        Receive-Job -Id $Id -AutoRemoveJob -Wait
    }

    end {

    }
}

Set-Alias -Name sjb -Value Show-Job