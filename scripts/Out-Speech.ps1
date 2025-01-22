function Out-Speech
{
    [CmdletBinding()]
    param
    (
        [Parameter(Mandatory = $true, ValueFromPipeline = $true)]
        [string]
        $Text,

        [Parameter(Mandatory = $false)]
        [int]
        $Rate = 4,

        [Parameter(Mandatory = $false)]
        [int]
        $Volume = 100,

        [Parameter(Mandatory = $false)]
        [string]
        $Voice = "Microsoft Hazel Desktop",

        [switch]
        $PassThru
    )

    begin
    {
        Set-StrictMode -Version 2
        Add-Type -AssemblyName System.Speech
        $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
        $synth.SelectVoice($Voice)
        $synth.Rate = $Rate
        $synth.Volume = $Volume
    }

    process
    {
        if ($PassThru)
        {
            $synth.SpeakAsync($Text) | Out-Null
            Write-Output $synth
        }
        else
        {
            $synth.Speak($Text) | Out-Null
        }
    }

    end
    {

    }
}
