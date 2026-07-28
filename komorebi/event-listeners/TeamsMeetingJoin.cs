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

/// <summary>
/// Joins a Teams meeting with the chord that suits the foreground window.
///
/// Teams Calendar wins when it is foreground, because <c>Ctrl+J</c> then joins
/// the selected event. Otherwise the global <c>Ctrl+Shift+J</c> toast shortcut
/// runs.
///
/// Both chords are kanata virtual keys triggered over TCP, so kanata's own
/// <c>unmod</c> handling isolates them from physically-held modifiers.
///
/// TODO: gate the toast chord on an actual meeting-started toast.
/// </summary>
internal sealed partial class TeamsMeetingJoin(
    ILogger<TeamsMeetingJoin> logger,
    Lazy<IKanataClient> kanata) : ITeamsMeetingJoin
{
    private const string TeamsProcessName = "ms-teams";
    private const string TeamsWindowClass = "TeamsWebView";
    private const string CalendarTitlePrefix = "Calendar |";

    public void Join()
    {
        var virtualKey = SelectVirtualKey();
        logger.LogInformation("Joining Teams meeting via {VirtualKey}", virtualKey);
        _ = kanata.Value.TapVirtualKeyAsync(virtualKey);
    }

    internal static string SelectVirtualKey(
        string? processName,
        string? windowClass,
        string? windowTitle) =>
        processName is TeamsProcessName
        && windowClass is TeamsWindowClass
        && windowTitle?.StartsWith(CalendarTitlePrefix, StringComparison.Ordinal) is true
            ? LayerCatalog.VirtualKeyTeamsJoinFocused
            : LayerCatalog.VirtualKeyTeamsJoinToast;

    private static string SelectVirtualKey()
    {
        var hwnd = NativeWindows.GetForeground();
        if (hwnd == nint.Zero)
        {
            return LayerCatalog.VirtualKeyTeamsJoinToast;
        }

        return SelectVirtualKey(
            GetProcessName(hwnd),
            ReadWindowText(hwnd, GetClassNameW),
            ReadWindowText(hwnd, GetWindowTextW));
    }

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

