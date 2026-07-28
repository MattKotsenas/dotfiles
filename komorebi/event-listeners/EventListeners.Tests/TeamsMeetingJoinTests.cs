using EventListeners.Generated;

namespace EventListeners.Tests;

public class TeamsMeetingJoinTests
{
    [Fact]
    public void FocusedTeamsCalendar_SelectsFocusedCalendarKey()
    {
        var virtualKey = TeamsMeetingJoin.SelectVirtualKey(
            "ms-teams",
            "TeamsWebView",
            "Calendar | Microsoft Teams");

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
            processName,
            windowClass,
            windowTitle);

        Assert.Equal(LayerCatalog.VirtualKeyTeamsJoinToast, virtualKey);
    }
}


