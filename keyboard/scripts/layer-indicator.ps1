#!/usr/bin/env pwsh
# Kanata TCP layer listener - watches for layer changes and updates border colors.
# Connects to kanata's TCP server and listens for LayerChange events.
# Runs as a background service via wpmd.

$port = 9999
$normalColors = @{
    single    = @(116, 199, 236)
    stack     = @(203, 166, 247)
    unfocused = @( 69,  71,  90)
}
$wmColors = @{
    single    = @( 50, 210, 248)
    stack     = @(180, 120, 250)
    unfocused = @( 80,  85, 110)
}

function Set-BorderColors([hashtable]$colors) {
    foreach ($kind in @('single', 'stack', 'unfocused')) {
        $c = $colors[$kind]
        komorebic border-colour $c[0] $c[1] $c[2] -w $kind
    }
}

while ($true) {
    try {
        $client = [System.Net.Sockets.TcpClient]::new('127.0.0.1', $port)
        $stream = $client.GetStream()
        $reader = [System.IO.StreamReader]::new($stream)

        while ($client.Connected) {
            $line = $reader.ReadLine()
            if ($null -eq $line) { break }

            if ($line -match '"LayerChange"' -and $line -match '"new":\s*"([^"]+)"') {
                $layer = $Matches[1]
                if ($layer -eq 'base') {
                    Set-BorderColors $normalColors
                } elseif ($layer -match '^wm') {
                    Set-BorderColors $wmColors
                }
            }
        }
    }
    catch {
        # kanata not ready yet or connection lost; retry
    }
    finally {
        if ($reader) { $reader.Dispose() }
        if ($client) { $client.Dispose() }
    }

    Start-Sleep -Seconds 2
}
