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
        await RunKomorebicAsync("toggle-float");
    }

    public Task<bool> MoveToMonitorAsync(int monitorIndex) =>
        RunKomorebicAsync($"move-to-monitor {monitorIndex}");

    public Task PromoteAsync() => RunKomorebicAsync("promote");

    public long GetForegroundWindow() => NativeMethods.GetForegroundWindow();

    public Task<bool> SetBorderColourAsync(BorderWindowKind kind, BorderColour colour) =>
        RunKomorebicAsync(
            $"border-colour {colour.R} {colour.G} {colour.B} --window-kind {kind.ToString().ToLowerInvariant()}");

    private async Task<bool> RunKomorebicAsync(string arguments)
    {
        try
        {
            var result = await _runner.RunAsync(
                Cli.Wrap("komorebic")
                    .WithArguments(arguments)
                    .WithValidation(CommandResultValidation.None));

            if (result.ExitCode != 0)
            {
                _logger.LogWarning("komorebic {Arguments} exited {ExitCode}", arguments, result.ExitCode);
                return false;
            }

            return true;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to invoke komorebic {Arguments}", arguments);
            return false;
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
