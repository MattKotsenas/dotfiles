function Get-Clipboard
{
    [CmdletBinding()]
    param
    (
        [switch]
        $Raw
    )

    Set-StrictMode -Version 2

    # Windows forms requires STA
    $cmd =
    {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.Clipboard]::GetText()
    }
    $text = powershell -STA -NoProfile -Command $cmd

    if ($Raw)
    {
        Write-Output $text
    }
    else
    {
        Write-Output $text.Split("`r`n", [StringSplitOptions]::RemoveEmptyEntries).Trim()
    }
}