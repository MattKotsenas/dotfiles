if ($env:_PR_COMMAND -ne 'copilot') { return }

$sessionDir = Join-Path $env:USERPROFILE '.copilot' 'session-state'
if (-not (Test-Path $sessionDir)) { return }

$latest = Get-ChildItem $sessionDir -Directory |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if ($latest) {
    Write-Output "copilot --resume=$($latest.Name)"
} else {
    Write-Output "copilot --resume"
}
Write-Output "<_PR_BR>"
