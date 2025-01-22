# From https://github.com/bvli/pwsh-srt

<#
.SYNOPSIS
Download .srt files from anything supported by yt-dlp

.PARAMETER Uri
A link to the file to download.

.PARAMETER AdditionalArguments
Any additional arguments to pass to yt-dlp.

.EXAMPLE
Invoke-SrtDownload -Uri "https://my/file"

.EXAMPLE
Invoke-SrtDownload -Uri "https://my/file" -AdditionalArguments "--cookies ./path/to/cookies.txt"
#>
function Invoke-SrtDownload {
    [CmdletBinding()]
    param (
        [Parameter(Mandatory = $true, ValueFromPipeline = $true)]
        [Uri]
        $Uri,

        [Parameter(Mandatory = $false)]
        [string]
        $AdditionalArguments = ""
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = "Stop"
    $PSNativeCommandUseErrorActionPreference = $false # So we can emit the error message

    try {
        $cmd = @(
            "yt-dlp",
            "-o $Env:Temp/subs", # Write files using prefix to %TEMP%/subs*
            "--write-subs --write-auto-sub --sub-langs 'en.*'", # Write any english subs; prefer user authored but accept auto-generated
            "--skip-download", # Don't download the video
            "--convert-subtitles srt", # Convert from .vtt to .srt for easier extraction of text
            "--dump-single-json --no-simulate", # If the output it valid JSON assume success; if output isn't valid JSON assume failure
            "$AdditionalArguments $Uri",
            "2>&1" # Redirect stderr to stdout
        ) -join " "

        $output = Invoke-Expression $cmd
        if ($output | Out-String | Test-Json -ErrorAction SilentlyContinue) {
            # Success
            Get-Content $Env:Temp/subs.en.srt
        } else {
            # Error
            $output | Write-Error
        }
    }
    finally {
        Remove-Item $Env:Temp/subs.*.srt
    }
}

<#
.SYNOPSIS
Converts the contents of an .srt file (as an array of lines) to plain text.

.DESCRIPTION
Converts the contents of an .srt file to plain text. Assumes that the input is an array of lines of text. Removes:
  - time codes
  - blank lines
  - duplicate lines (common technique for incremental reveal)
#>
function Format-Srt {
    [CmdletBinding()]
    param (
        [Parameter(Mandatory = $false, ValueFromPipeline = $true)]
        [string[]]
        $SrtLines
    )

    begin {
        Set-StrictMode -Version Latest
        $ErrorActionPreference = "Stop"

        $lines = [System.Collections.Generic.List[string]]::new()
    }

    process {
        $lines.AddRange($SrtLines)
    }

    end {
        $lines | ConvertFrom-Srt | Select-Object -ExpandProperty text | Foreach-Object { $_.Trim() } | Foreach-Object { $_ -split "`n" } | Get-Unique -AsString -CaseInsensitive 
    }
}

<#
.SYNOPSIS
Convert the contents of an .srt file (as an array of lines) to SRT objects
#>
function ConvertFrom-Srt {
    [CmdletBinding()]
    param (
        [Parameter(Position = 0, ValueFromPipeline = $true)]
        [string[]] $entries
    )

    begin {
        Set-StrictMode -Version Latest
        $current = $null
    }

    process {
        foreach ($entry in $entries) {
            if ($entry -match "^\d+$") {
                $current
                $current = [PSCustomObject]@{}
                $current | Add-Member -MemberType NoteProperty -Name 'Sequence' -Value ([int]$entry)
                $current | Add-Member -MemberType NoteProperty -Name 'Text' -Value ""
            }
            elseif ( $entry -match "(\d{2}:\d{2}:\d{2},\d{3})\s-->\s(\d{2}:\d{2}:\d{2},\d{3})") {
                $current | Add-Member -MemberType NoteProperty -Name 'From' -Value ([TimeSpan]::ParseExact($Matches[1], "hh\:mm\:ss\,fff", [CultureInfo]::InvariantCulture))
                $current | Add-Member -MemberType NoteProperty -Name 'To' -Value  ([TimeSpan]::ParseExact($Matches[2], "hh\:mm\:ss\,fff", [CultureInfo]::InvariantCulture))
            }
            elseif ($entry) {
                $current.Text += "$entry`n"
            }
        }
    }

    end {
        $current
    }
}

function Add-SrtTimeDifference {
    [CmdletBinding()]
    param (
        [Parameter(Position = 0, ValueFromPipeline = $true)]
        [PSCustomObject[]] $entries,
        [Parameter(Mandatory = $true, ParameterSetName = 'Seconds')]
        [int] $Seconds,
        [Parameter(Mandatory = $true, ParameterSetName = 'MilliSeconds')]
        [int] $MilliSeconds
    )

    begin {
        Set-StrictMode -Version Latest
        if ($Seconds) {
            $difference = [TimeSpan]::FromSeconds($Seconds);
        }
        if ($MilliSeconds) {
            $difference = [TimeSpan]::FromMilliseconds($MilliSeconds);
        }
    }

    process {
        foreach ($entry in $entries) {
            $entry | Add-Member -MemberType NoteProperty -Name 'Difference' -Value $difference
            $entry.From = $entry.From.Add($difference)
            $entry.To = $entry.To.Add($difference)
            $entry
        }
    }
}

function ConvertTo-Srt {
    [CmdletBinding()]
    param (
        [Parameter(Position = 0, ValueFromPipeline = $true)]
        [PSCustomObject[]] $entries
    )

    begin {
        Set-StrictMode -Version Latest
        $format = 'hh\:mm\:ss\,fff'
        $sequence = [int]0
    }

    process {
        foreach ($entry in $entries) {
            $sequence += 1
            $sequence
            "$($entry.From.ToString($format, [CultureInfo]::InvariantCulture)) --> $($entry.To.ToString($format, [CultureInfo]::InvariantCulture))"
            $entry.Text.TrimEnd()
            ""
        }
    }
}
