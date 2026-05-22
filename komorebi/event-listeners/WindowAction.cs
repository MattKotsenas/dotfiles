using System.Runtime.InteropServices;
using CliWrap;
using EventListeners.Win32;
using Microsoft.Extensions.Logging;

namespace EventListeners;

/// <summary>
/// Default <see cref="IWindowAction"/> implementation. Shells out to komorebic for
/// state-aware operations and uses Win32 directly for raw window messages.
/// </summary>
public sealed class WindowAction : IWindowAction
{
    private readonly ILogger<WindowAction> _logger;
    private readonly ICommandRunner _runner;

    public WindowAction(ILogger<WindowAction> logger, ICommandRunner runner)
    {
        _logger = logger;
        _runner = runner;
    }

    public async void ToggleFloat()
    {
        try
        {
            var result = await _runner.RunAsync(
                Cli.Wrap("komorebic")
                    .WithArguments("toggle-float")
                    .WithValidation(CommandResultValidation.None));

            if (result.ExitCode != 0)
            {
                _logger.LogWarning("komorebic toggle-float exited {ExitCode}", result.ExitCode);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to invoke komorebic toggle-float");
        }
    }

    public void Close(long hwnd)
    {
        var hwndPtr = (nint)hwnd;
        if (!NativeMethods.PostMessageW(hwndPtr, NativeMethods.WM_CLOSE, nint.Zero, nint.Zero))
        {
            var error = Marshal.GetLastWin32Error();
            _logger.LogWarning("PostMessage WM_CLOSE failed for hwnd {Hwnd} with error {ErrorCode}", hwnd, error);
        }
    }
}
