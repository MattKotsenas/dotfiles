$json = [Console]::In.ReadToEnd()
if (-not $json) { return }

$data = $json | ConvertFrom-Json
$pct = [math]::Round($data.context_window.used_percentage ?? 0)

$e = [char]0x1B
$color = switch ($true) {
    ($pct -gt 80) { "$e[31m"; break }
    ($pct -gt 50) { "$e[33m"; break }
    default        { "$e[32m" }
}
$reset = "$e[0m"

$filled = [math]::Clamp([int][math]::Round($pct / 5), 0, 20)
$empty = 20 - $filled
$bar = '█' * $filled + '░' * $empty

$session = $data.session_name
$sep = if ($session) { " $e[90m$e[0m $session" } else { '' }

"${color}ctx ${bar} ${pct}%${reset}${sep}"
