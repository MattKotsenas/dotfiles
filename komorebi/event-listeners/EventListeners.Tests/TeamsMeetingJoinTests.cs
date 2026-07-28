using System.Diagnostics;
using System.Runtime.InteropServices;
using EventListeners.Generated;
using Microsoft.Extensions.Logging.Abstractions;

namespace EventListeners.Tests;

public class TeamsMeetingJoinTests
{
    private static readonly ForegroundWindow TeamsCalendar =
        new("ms-teams", "TeamsWebView", "Calendar | Microsoft Teams");

    [Fact]
    public void FocusedTeamsCalendar_SelectsFocusedCalendarKey()
    {
        var virtualKey = TeamsMeetingJoin.SelectVirtualKey(TeamsCalendar);

        Assert.Equal(LayerCatalog.VirtualKeyTeamsJoinFocused, virtualKey);
    }

    [Theory]
    // Teams is focused on a non-Calendar surface.
    [InlineData("ms-teams", "TeamsWebView", "Chat | Microsoft Teams")]
    // Another app carries a matching window title.
    [InlineData("msedge", "Chrome_WidgetWin_1", "Calendar | Microsoft Teams")]
    // Teams owns a window of a different class.
    [InlineData("ms-teams", "Chrome_WidgetWin_1", "Calendar | Microsoft Teams")]
    // No foreground window could be identified.
    [InlineData(null, null, null)]
    public void OtherForegroundWindows_SelectToastKey(
        string? processName,
        string? windowClass,
        string? windowTitle)
    {
        var virtualKey = TeamsMeetingJoin.SelectVirtualKey(
            new ForegroundWindow(processName, windowClass, windowTitle));

        Assert.Equal(LayerCatalog.VirtualKeyTeamsJoinToast, virtualKey);
    }

    [Fact]
    public void Join_TapsTheCalendarKey_WhenTeamsCalendarIsForeground()
    {
        var kanata = new RecordingKanataClient();

        Join(kanata, TeamsCalendar);

        Assert.Equal([LayerCatalog.VirtualKeyTeamsJoinFocused], kanata.VirtualKeyTaps);
    }

    [Fact]
    public void Join_TapsTheToastKey_WhenAnotherAppIsForeground()
    {
        var kanata = new RecordingKanataClient();

        Join(kanata, new ForegroundWindow("msedge", "Chrome_WidgetWin_1", "Inbox"));

        Assert.Equal([LayerCatalog.VirtualKeyTeamsJoinToast], kanata.VirtualKeyTaps);
    }

    [Fact]
    public void Join_ReadsTheForegroundWindowEveryTime()
    {
        var kanata = new RecordingKanataClient();
        var windows = new Queue<ForegroundWindow>(
            [TeamsCalendar, new ForegroundWindow("msedge", "Chrome_WidgetWin_1", "Inbox")]);
        var join = new TeamsMeetingJoin(
            NullLogger<TeamsMeetingJoin>.Instance,
            new Lazy<IKanataClient>(() => kanata),
            windows.Dequeue);

        join.Join();
        join.Join();

        Assert.Equal(
            [LayerCatalog.VirtualKeyTeamsJoinFocused, LayerCatalog.VirtualKeyTeamsJoinToast],
            kanata.VirtualKeyTaps);
    }

    private static void Join(IKanataClient kanata, ForegroundWindow foreground) =>
        new TeamsMeetingJoin(
            NullLogger<TeamsMeetingJoin>.Instance,
            new Lazy<IKanataClient>(() => kanata),
            () => foreground).Join();

    [Fact]
    public void Describe_ReadsTheProcessClassAndTitleOfARealWindow()
    {
        // A message-only window of the built-in STATIC class. The test owns it,
        // so its process, class, and title are all known and all differ, and
        // reading any one of them through the wrong call fails here.
        var hwnd = CreateWindowExW(
            0, "STATIC", WindowTitle, 0, 0, 0, 0, 0, HwndMessage, 0, 0, 0);
        Assert.NotEqual(nint.Zero, hwnd);

        try
        {
            var window = TeamsMeetingJoin.Describe(hwnd);

            Assert.Equal(Process.GetCurrentProcess().ProcessName, window.ProcessName);
            Assert.Equal("Static", window.WindowClass);
            Assert.Equal(WindowTitle, window.Title);
        }
        finally
        {
            DestroyWindow(hwnd);
        }
    }

    [Fact]
    public void Describe_NoWindow_YieldsAnUnidentifiedWindow()
    {
        var window = TeamsMeetingJoin.Describe(nint.Zero);

        Assert.Equal(new ForegroundWindow(null, null, null), window);
    }

    private const string WindowTitle = "dotfiles-describe-test";
    private const nint HwndMessage = -3;

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern nint CreateWindowExW(
        int exStyle,
        string className,
        string windowName,
        int style,
        int x,
        int y,
        int width,
        int height,
        nint parent,
        nint menu,
        nint instance,
        nint param);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyWindow(nint hwnd);

    private sealed class RecordingKanataClient : IKanataClient
    {
        public List<string> VirtualKeyTaps { get; } = [];

        public Task SendChangeLayerAsync(string layerName, CancellationToken cancellationToken = default) =>
            throw new InvalidOperationException("Joining must not change layers.");

        public Task TapVirtualKeyAsync(string virtualKeyName, CancellationToken cancellationToken = default)
        {
            VirtualKeyTaps.Add(virtualKeyName);
            return Task.CompletedTask;
        }
    }
}
