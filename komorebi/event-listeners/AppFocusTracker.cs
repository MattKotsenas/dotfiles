using EventListeners.Models;
using Microsoft.Extensions.Logging;

namespace EventListeners;

/// <summary>
/// Tracks the currently focused application by watching komorebi focus events.
/// Other rules query <see cref="FocusedExe"/> to make context-aware decisions.
/// </summary>
public sealed class AppFocusTracker : IEventRule
{
    private readonly ILogger<AppFocusTracker> _logger;

    public string Name => "AppFocusTracker";

    /// <summary>
    /// The executable name (e.g., "WindowsTerminal.exe") of the currently
    /// focused window, or null if unknown.
    /// </summary>
    public string? FocusedExe { get; private set; }

    public AppFocusTracker(ILogger<AppFocusTracker> logger)
    {
        _logger = logger;
    }

    public void ProcessEvent(IEvent evt)
    {
        if (evt is not KomorebiWindowEvent komorebiEvt) return;
        if (komorebiEvt.State is null) return;

        var focusedHwnd = komorebiEvt.State.Value.GetFocusedHwnd();
        if (focusedHwnd is null) return;

        foreach (var window in komorebiEvt.State.Value.EnumerateAllWindows())
        {
            if (window.Hwnd == focusedHwnd.Value)
            {
                if (window.Exe != FocusedExe)
                {
                    _logger.LogDebug("Focused app changed: {OldExe} -> {NewExe}", FocusedExe, window.Exe);
                    FocusedExe = window.Exe;
                }
                return;
            }
        }
    }
}
