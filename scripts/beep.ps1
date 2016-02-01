function beep
{
    $path = (Join-Path -Path $PSScriptRoot -ChildPath beep.wav -Resolve)
    (New-Object System.Media.SoundPlayer $path).play()
}