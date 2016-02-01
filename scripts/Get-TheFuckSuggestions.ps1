function Get-TheFuckSuggestions {
    $fuck = $(thefuck (Get-History -Count 1).CommandLine)
    if (-not [string]::IsNullOrWhiteSpace($fuck))
    {
        if ($fuck.StartsWith("echo")) { $fuck = $fuck.Substring(5) }
        else { iex "$fuck" }
    }
}
