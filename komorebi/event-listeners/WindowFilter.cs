namespace EventListeners;

/// <summary>
/// Immutable snapshot of a top-level window's properties relevant to the
/// reacquire sweep. Produced by the native enumerator, consumed by
/// <see cref="WindowFilter"/> (which is what keeps the decision logic testable
/// without a live desktop).
/// </summary>
public sealed record WindowInfo
{
    public required long Hwnd { get; init; }
    public required string Title { get; init; }

    /// <summary>Process name (no extension, case-insensitive), e.g. "WindowsTerminal".</summary>
    public required string Exe { get; init; }

    public required int Width { get; init; }
    public required int Height { get; init; }
    public required bool IsVisible { get; init; }

    /// <summary>DWM-cloaked: hidden on another virtual desktop or a suspended UWP app.</summary>
    public required bool IsCloaked { get; init; }

    /// <summary>WS_EX_TOOLWINDOW: a palette/overlay window, not a normal app window.</summary>
    public required bool IsToolWindow { get; init; }

    /// <summary>WS_EX_NOACTIVATE: cannot take focus, so komorebi can never manage it.</summary>
    public required bool IsNoActivate { get; init; }

    /// <summary>WS_CHILD: a child window, never a top-level managed window.</summary>
    public required bool IsChild { get; init; }
}

/// <summary>
/// Decides whether the reacquire sweep should ask komorebi to manage a given
/// top-level window.
///
/// This is intentionally a <em>coarse</em> filter: it only weeds out windows that
/// are obviously not tileable app windows (overlays, child windows, the shell,
/// komorebi's own UI, already-tracked windows) so the sweep doesn't waste a
/// focus-flick on them. komorebi's own manage/float/ignore rules remain the final
/// authority on anything that passes here -- e.g. a WS_EX_TOOLWINDOW Copilot flyout
/// is rejected here, but a borderline normal window is left for komorebi to judge.
/// </summary>
public static class WindowFilter
{
    public const int MinWidth = 200;
    public const int MinHeight = 150;

    private static readonly HashSet<string> ExcludedExes = new(StringComparer.OrdinalIgnoreCase)
    {
        "komorebi",      // the window manager itself (border windows etc.)
        "komorebi-bar",  // status bars
    };

    public static bool ShouldManage(WindowInfo w, IReadOnlySet<long> trackedHwnds)
    {
        if (trackedHwnds.Contains(w.Hwnd)) return false;   // komorebi already manages it
        if (!w.IsVisible) return false;
        if (w.IsCloaked) return false;
        if (string.IsNullOrWhiteSpace(w.Title)) return false;
        if (w.IsChild) return false;
        if (w.IsToolWindow) return false;                  // overlays/flyouts (e.g. Copilot Chat)
        if (w.IsNoActivate) return false;                  // can't focus => can't manage
        if (w.Width < MinWidth || w.Height < MinHeight) return false;
        if (ExcludedExes.Contains(w.Exe)) return false;
        if (string.Equals(w.Title, "Program Manager", StringComparison.Ordinal)) return false; // the desktop
        return true;
    }
}
