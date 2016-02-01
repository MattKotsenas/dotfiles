function New-GitIgnore
{
    param
    (
        [Parameter(Mandatory = $true)]
        [string[]]
        $List
    )

    $params = $List -join ","
    Invoke-WebRequest -Uri "http://www.gitignore.io/api/$params" | select -ExpandProperty content | Out-File -FilePath $(Join-Path -Path $pwd -ChildPath ".gitignore") -Encoding ascii
}