using System.Diagnostics;
using System.Runtime.InteropServices;
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

    public WindowAction(ILogger<WindowAction> logger)
    {
        _logger = logger;
    }

    public void ToggleFloat()
    {
        try
        {
            using var process = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = "komorebic",
                    Arguments = "toggle-float",
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true
                }
            };

            process.Start();
            process.WaitForExit();

            if (process.ExitCode != 0)
            {
                var stderr = process.StandardError.ReadToEnd();
                _logger.LogWarning("komorebic toggle-float exited {ExitCode}: {StdErr}", process.ExitCode, stderr);
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
