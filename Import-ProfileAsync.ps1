# Adapted from https://fsackur.github.io/2023/11/20/Deferred-profile-loading-for-better-performance/
# https://github.com/fsackur/dotfiles/blob/06fcaa4fc8b9b3a647c414ebe255ada8e1cc9054/.chezmoitemplates/profile.ps1

[CmdletBinding()]
param (
    [Parameter()]
    [ScriptBlock]
    $DeferredLoad
)

function Write-DeferredLoadLog
{
    param
    (
        [Parameter(Mandatory, ValueFromPipeline)]
        [string]$Message
    )

    if (-not $LogDeferredLoad) {return}

    $LogPath = if ($env:XDG_CACHE_HOME)
    {
        Join-Path $env:XDG_CACHE_HOME PowerShellDeferredLoad.log
    }
    else
    {
        Join-Path $HOME .cache/PowerShellDeferredLoad.log
    }

    $Now = [datetime]::Now
    if (-not $Start)
    {
        $Global:Start = $Now
    }

    $Timestamp = $Now.ToString('o')
    (
        $Timestamp,
        ($Now - $Start).ToString('ss\.fff'),
        [System.Environment]::CurrentManagedThreadId.ToString().PadLeft(3, ' '),
        $Message
    ) -join '  ' | Out-File -FilePath $LogPath -Append
}


if ($env:PWSH_DEFERRED_LOAD -imatch '^(0|false|no)$')
{
    . $DeferredLoad
    return
}


$LogDeferredLoad = $false
"=== Starting deferred load ===" | Write-DeferredLoadLog


# https://seeminglyscience.github.io/powershell/2017/09/30/invocation-operators-states-and-scopes
$GlobalState = [psmoduleinfo]::new($false)
$GlobalState.SessionState = $ExecutionContext.SessionState

# A runspace to run our code asynchronously; pass in $Host to support Write-Host
$Runspace = [runspacefactory]::CreateRunspace($Host)
$Powershell = [powershell]::Create($Runspace)
$Runspace.Open()
$Runspace.SessionStateProxy.PSVariable.Set('GlobalState', $GlobalState)

# ArgumentCompleters are set on the ExecutionContext, not the SessionState
# Note that $ExecutionContext is not an ExecutionContext, it's an EngineIntrinsics
$Private = [System.Reflection.BindingFlags]'Instance, NonPublic'
$ContextField = [System.Management.Automation.EngineIntrinsics].GetField('_context', $Private)
$GlobalContext = $ContextField.GetValue($ExecutionContext)

# Get the ArgumentCompleters. If null, initialise them.
$ContextCACProperty = $GlobalContext.GetType().GetProperty('CustomArgumentCompleters', $Private)
$ContextNACProperty = $GlobalContext.GetType().GetProperty('NativeArgumentCompleters', $Private)
$CAC = $ContextCACProperty.GetValue($GlobalContext)
$NAC = $ContextNACProperty.GetValue($GlobalContext)
if ($null -eq $CAC)
{
    $CAC = [System.Collections.Generic.Dictionary[string, scriptblock]]::new()
    $ContextCACProperty.SetValue($GlobalContext, $CAC)
}
if ($null -eq $NAC)
{
    $NAC = [System.Collections.Generic.Dictionary[string, scriptblock]]::new()
    $ContextNACProperty.SetValue($GlobalContext, $NAC)
}

# Get the AutomationEngine and ExecutionContext of the runspace
$RSEngineField = $Runspace.GetType().GetField('_engine', $Private)
$RSEngine = $RSEngineField.GetValue($Runspace)
$EngineContextField = $RSEngine.GetType().GetFields($Private) | Where-Object {$_.FieldType.Name -eq 'ExecutionContext'}
$RSContext = $EngineContextField.GetValue($RSEngine)

# Set the runspace to use the global ArgumentCompleters
$ContextCACProperty.SetValue($RSContext, $CAC)
$ContextNACProperty.SetValue($RSContext, $NAC)

Remove-Variable -ErrorAction Ignore (
    'Private',
    'GlobalContext',
    'ContextField',
    'ContextCACProperty',
    'ContextNACProperty',
    'CAC',
    'NAC',
    'RSEngineField',
    'RSEngine',
    'EngineContextField',
    'RSContext',
    'Runspace'
)

$Wrapper = {
    # Without a sleep, you get issues:
    #   - occasional crashes
    #   - prompt not rendered
    #   - no highlighting
    # Assumption: this is related to PSReadLine.
    # 20ms seems to be enough on my machine, but let's be generous - this is non-blocking
    Start-Sleep -Milliseconds 1200

    . $GlobalState {. $DeferredLoad; Remove-Variable DeferredLoad}
}

$AsyncResult = $Powershell.AddScript($Wrapper.ToString()).BeginInvoke()

$null = Register-ObjectEvent -MessageData $AsyncResult -InputObject $Powershell -EventName InvocationStateChanged -SourceIdentifier __DeferredLoaderCleanup -Action {
    $AsyncResult = $Event.MessageData
    $Powershell = $Event.Sender
    if ($Powershell.InvocationStateInfo.State -ge 2)
    {
        if ($Powershell.Streams.Error)
        {
            $Powershell.Streams.Error | Out-String | Write-Host -ForegroundColor Red
        }

        try
        {
            # Profiles swallow output; it would be weird to output anything here
            $null = $Powershell.EndInvoke($AsyncResult)
        }
        catch
        {
            $_ | Out-String | Write-Host -ForegroundColor Red
        }

        $h1 = Get-History -Id 1 -ErrorAction Ignore
        if ($h1.CommandLine -match '\bcode\b.*shellIntegration\.ps1')
        {
            $Msg = 'VS Code Shell Integration is enabled. This may cause issues with deferred load. To disable it, set "terminal.integrated.shellIntegration.enabled" to "false" in your settings.'
            Write-Host $Msg -ForegroundColor Yellow
        }

        $PowerShell.Dispose()
        $Runspace.Dispose()
        Unregister-Event __DeferredLoaderCleanup
        Get-Job __DeferredLoaderCleanup | Remove-Job
    }
}

Remove-Variable Wrapper, Powershell, AsyncResult, GlobalState

"synchronous load complete" | Write-DeferredLoadLog