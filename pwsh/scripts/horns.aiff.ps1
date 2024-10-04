function horns.aiff
{
    $path = (Join-Path -Path $PSScriptRoot -ChildPath horns.aiff.wav -Resolve)
    (New-Object System.Media.SoundPlayer $path).play()
}