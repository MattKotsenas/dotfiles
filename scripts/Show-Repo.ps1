<#
.SYNOPSIS
Get the git repo specified in $Path, and optionally open in the default browser.

.PARAMETER Open
Open the repo in the default browser.

.PARAMETER Path
The path to the git repo. Defaults to the current working directory.

.PARAMETER Remote
The remote to use in the git repo. Defaults to 'origin'.
#>
function Show-Repo {
    [CmdletBinding()]
    param (
        [switch]
        $Open,

        [Parameter(Mandatory = $false, ValueFromPipeline = $true, ValueFromPipelineByPropertyName)]
        [string[]]
        $Path = $PWD,

        [Parameter(Mandatory = $false)]
        [string]
        $Remote = "origin"
    )

    begin {
        $action = { param ($url) Write-Output $url }

        if ($Open)
        {
            $action = { param($url) Start-Process $url }
        }
    }

    process {
        foreach ($p in $Path)
        {
            $workingDir = (Resolve-Path $Path)
            $remoteUrl = [System.Uri]::new((git -C $workingDir remote get-url $Remote))
            $result = $null

            if ($remoteUrl.Host -eq "github.com")
            {
                $result = $remoteUrl.ToString()
            }
            elseif ($remoteUrl.Host -eq "dev.azure.com")
            {
                $result = "$($remoteUrl.Scheme)://$($remoteUrl.Host)$($remoteUrl.PathAndQuery)"
            }
            else
            {
                throw "Unable to parse remote url '$($remoteUrl.OriginalString)'"
            }

            Invoke-Command $action -ArgumentList $result
        }
    }

    end {

    }
}