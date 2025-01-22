# From https://github.com/bvli/pwsh-srt

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
