using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using EventListeners.Generated;
using EventListeners.Win32;
using Microsoft.Extensions.Logging;

namespace EventListeners;

public interface ITeamsMeetingJoin
{
    void Join();
}

/// <summary>The identity of the foreground window, as far as joining cares.</summary>
internal sealed record ForegroundWindow(string? ProcessName, string? WindowClass, string? Title);

/// <summary>
/// Joins a Teams meeting with the chord that suits the foreground window.
///
/// Teams Calendar wins when it is foreground, because <c>Ctrl+J</c> then joins
/// the selected event. Otherwise the global <c>Ctrl+Shift+J</c> toast shortcut
/// runs.
///
/// Both chords are kanata virtual keys, defined by keymap-gen; this only picks
/// which one to tap.
///
/// TODO: gate the toast chord on an actual meeting-started toast.
/// </summary>
internal sealed partial class TeamsMeetingJoin : ITeamsMeetingJoin
{
    private const string TeamsProcessName = "ms-teams";
    private const string TeamsWindowClass = "TeamsWebView";
    private const string CalendarTitlePrefix = "Calendar |";

    private readonly ILogger<TeamsMeetingJoin> _logger;
    private readonly Lazy<IKanataClient> _kanata;
    private readonly Func<ForegroundWindow> _readForeground;

    public TeamsMeetingJoin(ILogger<TeamsMeetingJoin> logger, Lazy<IKanataClient> kanata)
        : this(logger, kanata, ReadForeground)
    {
    }

    internal TeamsMeetingJoin(
        ILogger<TeamsMeetingJoin> logger,
        Lazy<IKanataClient> kanata,
        Func<ForegroundWindow> readForeground)
    {
        _logger = logger;
        _kanata = kanata;
        _readForeground = readForeground;
    }

    public void Join()
    {
        var virtualKey = SelectVirtualKey(_readForeground());
        _logger.LogInformation("Joining Teams meeting via {VirtualKey}", virtualKey);
        _ = _kanata.Value.TapVirtualKeyAsync(virtualKey);
    }

    internal static string SelectVirtualKey(ForegroundWindow window) =>
        window.ProcessName is TeamsProcessName
        && window.WindowClass is TeamsWindowClass
        && window.Title?.StartsWith(CalendarTitlePrefix, StringComparison.Ordinal) is true
            ? LayerCatalog.VirtualKeyTeamsJoinFocused
            : LayerCatalog.VirtualKeyTeamsJoinToast;

    internal static ForegroundWindow Describe(nint hwnd) =>
        hwnd == nint.Zero
            ? new ForegroundWindow(null, null, null)
            : new ForegroundWindow(
                GetProcessName(hwnd),
                ReadWindowText(hwnd, GetClassNameW),
                ReadWindowText(hwnd, GetWindowTextW));

    private static ForegroundWindow ReadForeground() => Describe(NativeWindows.GetForeground());

    private static string? GetProcessName(nint hwnd)
    {
        GetWindowThreadProcessId(hwnd, out var processId);
        try
        {
            using var process = Process.GetProcessById((int)processId);
            return process.ProcessName;
        }
        catch (ArgumentException)
        {
            // The owning process exited between the two calls.
            return null;
        }
    }

    private static string ReadWindowText(
        nint hwnd,
        Func<nint, StringBuilder, int, int> read)
    {
        var buffer = new StringBuilder(512);
        var length = read(hwnd, buffer, buffer.Capacity);
        return length > 0 ? buffer.ToString() : string.Empty;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int GetClassNameW(nint hwnd, StringBuilder buffer, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int GetWindowTextW(nint hwnd, StringBuilder buffer, int maxCount);

    [LibraryImport("user32.dll")]
    private static partial uint GetWindowThreadProcessId(nint hwnd, out uint processId);
}

