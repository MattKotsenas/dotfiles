function New-PushalotMessage
{
    [CmdletBinding()]
    param
    (
        [Parameter(Mandatory = $false)]
        [ValidateLength(32, 32)]
        [string]
        $AuthorizationToken = (Get-Content $Env:HOME\.pushalot),

        [Parameter(Mandatory = $false)]
        [ValidateLength(0, 250)]
        [string]
        $Title,

        [Parameter(Mandatory = $true)]
        [ValidateLength(0, 32768)]
        [string]
        $Body,

        [Parameter(Mandatory = $false)]
        [ValidateLength(0, 100)]
        [string]
        $LinkTitle,

        [Parameter(Mandatory = $false)]
        [ValidateLength(0, 1000)]
        [string]
        $Link,

        [Parameter(Mandatory = $false)]
        [bool]
        $IsImportant,

        [Parameter(Mandatory = $false)]
        [bool]
        $IsSlient,

        [Parameter(Mandatory = $false)]
        [ValidateLength(0, 250)]
        [string]
        $Image,

        [Parameter(Mandatory = $false)]
        [ValidateLength(0, 25)]
        [string]
        $Source,

        [Parameter(Mandatory = $false)]
        [ValidateRange(0, 43200)]
        [int]
        $TimeToLive
    )

    Set-StrictMode -Version 2
    $uri = "https://pushalot.com/api/sendmessage"
    $headers = @{
        "ContentType" = "application/json"
    }

    if ($AuthorizationToken -eq $null)
    {
        throw "AuthorizationToken not found. Either pass one in or define it in .pushalot in your user root."
    }

    if ($Title -eq $null)
    {
        $Title = $Body.Substring(0, [Math]::Min($Body.Length, 250))
    }

    $payload = @{
        "AuthorizationToken" = $AuthorizationToken;
        "Title" = $Title;
        "Body" = $Body;
        "LinkTitle" = $LinkTitle;
        "Link" = $Link;
        "IsImportant" = $IsImportant;
        "IsSlient" = $IsSlient;
        "Image" = $Image;
        "Source" = $Source;
        "TimeToLive" = $TimeToLive
    }

    Invoke-WebRequest -Uri $uri -Method POST -Headers $headers -Body $payload
}