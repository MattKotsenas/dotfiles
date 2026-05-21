using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;

namespace EventListeners.Tests;

public class EmptyTeamsWindowRuleTests
{
    private static readonly TimeSpan CloseDelay = TimeSpan.FromSeconds(2);
    // Real wall-clock timeout for awaiting async test signals. Generous so CI flakes are rare.
    private static readonly TimeSpan SignalTimeout = TimeSpan.FromSeconds(5);

    private static EmptyTeamsWindowRule CreateRule(out FakeWindowAction action, out FakeTimeProvider time)
    {
        action = new FakeWindowAction();
        time = new FakeTimeProvider();
        var rule = new EmptyTeamsWindowRule(NullLogger<EmptyTeamsWindowRule>.Instance, action, time);
        return rule;
    }

    [Fact]
    public async Task EmptyTeamsWindow_AfterDelay_IsClosed()
    {
        var rule = CreateRule(out var action, out var time);

        rule.ProcessEvent(new KomorebiWindowEvent("Show", TestJson.ShowEventContent("ms-teams.exe", "Microsoft Teams", 100), null));

        Assert.Empty(action.ClosedHwnds);

        time.Advance(CloseDelay + TimeSpan.FromMilliseconds(100));
        Assert.True(await action.WaitForCloseAsync(SignalTimeout), "expected Close call after delay");

        Assert.Equal([100L], action.ClosedHwnds);
    }

    [Fact]
    public async Task Show_NonTeamsExe_DoesNotSchedule()
    {
        var rule = CreateRule(out var action, out var time);

        rule.ProcessEvent(new KomorebiWindowEvent("Show", TestJson.ShowEventContent("not-teams.exe", "Microsoft Teams", 100), null));

        time.Advance(CloseDelay + TimeSpan.FromSeconds(1));
        Assert.False(await action.WaitForCloseAsync(TimeSpan.FromMilliseconds(200)), "should not close non-Teams window");
    }

    [Fact]
    public async Task Show_TeamsWindowWithRealTitle_DoesNotSchedule()
    {
        var rule = CreateRule(out var action, out var time);

        rule.ProcessEvent(new KomorebiWindowEvent("Show", TestJson.ShowEventContent("ms-teams.exe", "Meeting with Alice | Microsoft Teams", 100), null));

        time.Advance(CloseDelay + TimeSpan.FromSeconds(1));
        Assert.False(await action.WaitForCloseAsync(TimeSpan.FromMilliseconds(200)));
    }

    [Fact]
    public async Task TitleChangesBeforeDelay_CancelsClose()
    {
        var rule = CreateRule(out var action, out var time);

        rule.ProcessEvent(new KomorebiWindowEvent("Show", TestJson.ShowEventContent("ms-teams.exe", "Microsoft Teams", 100), null));

        var stateWithRealTitle = TestJson.State(tiled: [
            new(100, "Meeting with Bob | Microsoft Teams", "ms-teams.exe")
        ]);
        rule.ProcessEvent(new KomorebiWindowEvent("TitleUpdate", null, stateWithRealTitle));

        time.Advance(CloseDelay + TimeSpan.FromSeconds(1));

        Assert.False(await action.WaitForCloseAsync(TimeSpan.FromMilliseconds(200)),
            "should not close window after title changed to real title");
    }

    [Fact]
    public async Task TitleNeverChanges_StateScansKeepFiring_StillCloses()
    {
        var rule = CreateRule(out var action, out var time);

        rule.ProcessEvent(new KomorebiWindowEvent("Show", TestJson.ShowEventContent("ms-teams.exe", "Microsoft Teams", 100), null));

        var emptyState = TestJson.State(tiled: [
            new(100, "Microsoft Teams", "ms-teams.exe")
        ]);
        rule.ProcessEvent(new KomorebiWindowEvent("FocusChange", null, emptyState));
        rule.ProcessEvent(new KomorebiWindowEvent("FocusChange", null, emptyState));

        time.Advance(CloseDelay + TimeSpan.FromMilliseconds(100));
        Assert.True(await action.WaitForCloseAsync(SignalTimeout));

        Assert.Equal([100L], action.ClosedHwnds);
    }

    [Fact]
    public async Task SameHwndShownTwice_OnlyOneCloseScheduled()
    {
        var rule = CreateRule(out var action, out var time);

        rule.ProcessEvent(new KomorebiWindowEvent("Show", TestJson.ShowEventContent("ms-teams.exe", "Microsoft Teams", 100), null));
        rule.ProcessEvent(new KomorebiWindowEvent("Show", TestJson.ShowEventContent("ms-teams.exe", "Microsoft Teams", 100), null));

        time.Advance(CloseDelay + TimeSpan.FromMilliseconds(100));
        Assert.True(await action.WaitForCloseAsync(SignalTimeout));

        // Wait briefly to ensure no second close lands.
        await Task.Delay(100);
        Assert.Equal([100L], action.ClosedHwnds);
    }

    [Fact]
    public async Task MultipleEmptyTeamsWindows_AllClosed()
    {
        var rule = CreateRule(out var action, out var time);

        rule.ProcessEvent(new KomorebiWindowEvent("Show", TestJson.ShowEventContent("ms-teams.exe", "Microsoft Teams", 100), null));
        rule.ProcessEvent(new KomorebiWindowEvent("Show", TestJson.ShowEventContent("ms-teams.exe", "Microsoft Teams", 200), null));

        time.Advance(CloseDelay + TimeSpan.FromMilliseconds(100));
        Assert.True(await action.WaitForCloseAsync(SignalTimeout));
        Assert.True(await action.WaitForCloseAsync(SignalTimeout));

        Assert.Equal([100L, 200L], action.ClosedHwnds.OrderBy(h => h).ToArray());
    }

    [Fact]
    public async Task OneTitleChanges_OthersStillClosed()
    {
        var rule = CreateRule(out var action, out var time);

        rule.ProcessEvent(new KomorebiWindowEvent("Show", TestJson.ShowEventContent("ms-teams.exe", "Microsoft Teams", 100), null));
        rule.ProcessEvent(new KomorebiWindowEvent("Show", TestJson.ShowEventContent("ms-teams.exe", "Microsoft Teams", 200), null));

        var state = TestJson.State(tiled: [
            new(100, "Meeting | Microsoft Teams", "ms-teams.exe"),
            new(200, "Microsoft Teams", "ms-teams.exe"),
        ]);
        rule.ProcessEvent(new KomorebiWindowEvent("TitleUpdate", null, state));

        time.Advance(CloseDelay + TimeSpan.FromMilliseconds(100));
        Assert.True(await action.WaitForCloseAsync(SignalTimeout));

        await Task.Delay(100);
        Assert.Equal([200L], action.ClosedHwnds);
    }

    [Fact]
    public async Task Show_TeamsWindowInFloatingLayer_TitleChangeAlsoCancels()
    {
        var rule = CreateRule(out var action, out var time);

        rule.ProcessEvent(new KomorebiWindowEvent("Show", TestJson.ShowEventContent("ms-teams.exe", "Microsoft Teams", 100), null));

        var stateFloating = TestJson.State(
            tiled: [],
            floating: [new(100, "Meeting | Microsoft Teams", "ms-teams.exe")],
            layer: "Floating");
        rule.ProcessEvent(new KomorebiWindowEvent("FocusChange", null, stateFloating));

        time.Advance(CloseDelay + TimeSpan.FromSeconds(1));
        Assert.False(await action.WaitForCloseAsync(TimeSpan.FromMilliseconds(200)),
            "title change in floating layer should also cancel pending close");
    }
}

