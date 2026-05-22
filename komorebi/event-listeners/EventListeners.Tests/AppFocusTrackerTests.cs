using Microsoft.Extensions.Logging.Abstractions;

namespace EventListeners.Tests;

public class AppFocusTrackerTests
{
    private static AppFocusTracker Create() =>
        new(NullLogger<AppFocusTracker>.Instance);

    [Fact]
    public void InitialState_FocusedExeIsNull()
    {
        var tracker = Create();

        Assert.Null(tracker.FocusedExe);
    }

    [Fact]
    public void KomorebiEvent_WithFocusedWindow_UpdatesFocusedExe()
    {
        var tracker = Create();
        var state = TestJson.State(tiled: [new(100, "Term", "WindowsTerminal.exe")]);

        tracker.ProcessEvent(new KomorebiWindowEvent("FocusChange", null, state));

        Assert.Equal("WindowsTerminal.exe", tracker.FocusedExe);
    }

    [Fact]
    public void NonKomorebiEvent_DoesNotUpdate()
    {
        var tracker = Create();

        tracker.ProcessEvent(new KanataLayerChangeEvent("wm"));
        tracker.ProcessEvent(new KanataMessageEvent("wm.focus.right"));

        Assert.Null(tracker.FocusedExe);
    }

    [Fact]
    public void EventWithNullState_DoesNotUpdate()
    {
        var tracker = Create();

        tracker.ProcessEvent(new KomorebiWindowEvent("Show", null, null));

        Assert.Null(tracker.FocusedExe);
    }

    [Fact]
    public void FocusChangeBetweenApps_TracksLatest()
    {
        var tracker = Create();

        tracker.ProcessEvent(new KomorebiWindowEvent("FocusChange", null,
            TestJson.State(tiled: [new(100, "T", "WindowsTerminal.exe")])));
        Assert.Equal("WindowsTerminal.exe", tracker.FocusedExe);

        tracker.ProcessEvent(new KomorebiWindowEvent("FocusChange", null,
            TestJson.State(tiled: [new(200, "C", "chrome.exe")])));
        Assert.Equal("chrome.exe", tracker.FocusedExe);

        tracker.ProcessEvent(new KomorebiWindowEvent("FocusChange", null,
            TestJson.State(tiled: [new(300, "V", "code.exe")])));
        Assert.Equal("code.exe", tracker.FocusedExe);
    }
}
