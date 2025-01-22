function hiyo
{
    $path = (Join-Path -Path $PSScriptRoot -ChildPath hiyo.wav -Resolve)
    (New-Object System.Media.SoundPlayer $path).play()
}