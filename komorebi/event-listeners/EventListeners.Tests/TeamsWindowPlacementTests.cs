using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;

namespace EventListeners.Tests;

public class TeamsWindowPlacementTests
{
    private const string TeamsExe = "ms-teams.exe";
    private const string TeamsClass = "TeamsWebView";
    private const long TeamsHwnd = 0x3731402;

    private static readonly MonitorBounds Laptop = new(0, 0, 3440, 1440);
    private static readonly MonitorBounds External = new(3440, 0, 3440, 1440);

    private sealed class FakeTopology(params MonitorBounds[] attached) : IMonitorTopology
    {
        public bool IsAttached(MonitorBounds bounds) => attached.Contains(bounds);
    }

    private static TeamsWindowPlacement CreateRule(
        IMonitorTopology topology,
        out FakeWindowAction action,
        FakeTimeProvider? time = null)
    {
        action = new FakeWindowAction();
        return new TeamsWindowPlacement(
            NullLogger<TeamsWindowPlacement>.Instance, action, topology, time ?? new FakeTimeProvider());
    }

    /// <summary>Awaits any placement the last event started, so assertions never race it.</summary>
    private static Task Settle(TeamsWindowPlacement rule) => rule.LastPlacement ?? Task.CompletedTask;

    /// <summary>Docked: the external monitor is present at index 1 and attached.</summary>
    private static JsonElement DockedState(long focusedHwnd, params WindowSpec[] externalWindows)
    {
        var onExternal = externalWindows.Length > 0
            ? externalWindows
            : [new WindowSpec(focusedHwnd, "Meeting | Microsoft Teams", TeamsExe, TeamsClass)];

        var focusedIndex = Array.FindIndex(onExternal, w => w.Hwnd == focusedHwnd);

        return TestJson.MultiMonitorState(
            [
                new MonitorSpec(Laptop, [new WindowSpec(99, "Repo - Edge", "msedge.exe")]),
                new MonitorSpec(External, onExternal, Math.Max(focusedIndex, 0)),
            ],
            focusedMonitorIndex: focusedIndex >= 0 ? 1 : 0);
    }

    /// <summary>Undocked: komorebi still lists the external monitor, but it is gone.</summary>
    private static JsonElement UndockedState(long focusedHwnd) =>
        TestJson.MultiMonitorState(
            [
                new MonitorSpec(Laptop, [new WindowSpec(focusedHwnd, "Meeting | Microsoft Teams", TeamsExe, TeamsClass)]),
                new MonitorSpec(External, []),
            ],
            focusedMonitorIndex: 0);

    private static JsonElement WindowContent(long hwnd, string reason, string exe = TeamsExe, string title = "Microsoft Teams") =>
        TestJson.WindowEventContent(exe, title, hwnd, TeamsClass, reason);

    private static void Show(TeamsWindowPlacement rule, long hwnd, string exe = TeamsExe, JsonElement? state = null) =>
        rule.ProcessEvent(new KomorebiWindowEvent("Show", WindowContent(hwnd, "ObjectShow", exe), state));

    /// <summary>A window taking focus is a window taking the foreground.</summary>
    private static void Focus(TeamsWindowPlacement rule, FakeWindowAction action, long hwnd, JsonElement? state, string exe = TeamsExe)
    {
        action.ForegroundWindow = hwnd;
        rule.ProcessEvent(new KomorebiWindowEvent("FocusChange", WindowContent(hwnd, "SystemForeground", exe), state));
    }

    private static void Destroy(TeamsWindowPlacement rule, long hwnd, string exe = TeamsExe) =>
        rule.ProcessEvent(new KomorebiWindowEvent("Destroy", WindowContent(hwnd, "ObjectDestroy", exe), null));

    [Fact]
    public async Task Docked_NewTeamsWindow_MovesToExternalMonitorThenPromotes()
    {
        var rule = CreateRule(new FakeTopology(Laptop, External), out var action);
        Assert.Empty(action.Actions); // precondition: nothing placed yet

        Show(rule, TeamsHwnd);
        Focus(rule, action, TeamsHwnd, DockedState(TeamsHwnd));
        await Settle(rule);

        Assert.Equal([$"move-to-monitor 1 on {TeamsHwnd}", $"promote on {TeamsHwnd}"], action.Actions);
    }

    [Fact]
    public async Task Undocked_NewTeamsWindow_OnlyPromotes()
    {
        // komorebi still lists a monitor at index 1, but nothing is attached there:
        // moving to it would strand the window on a workspace nobody can see.
        var rule = CreateRule(new FakeTopology(Laptop), out var action);

        Show(rule, TeamsHwnd);
        Focus(rule, action, TeamsHwnd, UndockedState(TeamsHwnd));
        await Settle(rule);

        Assert.Equal([$"promote on {TeamsHwnd}"], action.Actions);
    }

    [Fact]
    public async Task SingleMonitor_NewTeamsWindow_OnlyPromotes()
    {
        var rule = CreateRule(new FakeTopology(Laptop), out var action);
        var state = TestJson.MultiMonitorState(
            [new MonitorSpec(Laptop, [new WindowSpec(TeamsHwnd, "Meeting | Microsoft Teams", TeamsExe, TeamsClass)])]);

        Show(rule, TeamsHwnd);
        Focus(rule, action, TeamsHwnd, state);
        await Settle(rule);

        Assert.Equal([$"promote on {TeamsHwnd}"], action.Actions);
    }

    [Fact]
    public async Task AFailedMoveDoesNotPromote()
    {
        var rule = CreateRule(new FakeTopology(Laptop, External), out var action);
        action.MoveSucceeds = false;

        Show(rule, TeamsHwnd);
        Focus(rule, action, TeamsHwnd, DockedState(TeamsHwnd));
        await Settle(rule);

        Assert.Equal([$"move-to-monitor 1 on {TeamsHwnd}"], action.Actions);
    }

    [Fact]
    public async Task WindowIsPlacedOnlyOnce_EvenWhenHiddenAndShownAgain()
    {
        // The user moves the window after placement; komorebi reports an unminimised
        // window as Show, which must not undo that move.
        var rule = CreateRule(new FakeTopology(Laptop, External), out var action);

        Show(rule, TeamsHwnd);
        Focus(rule, action, TeamsHwnd, DockedState(TeamsHwnd));
        await Settle(rule);
        Assert.Equal([$"move-to-monitor 1 on {TeamsHwnd}", $"promote on {TeamsHwnd}"], action.Actions); // precondition: placed once

        Show(rule, TeamsHwnd);
        Focus(rule, action, TeamsHwnd, DockedState(TeamsHwnd));
        await Settle(rule);

        Assert.Equal([$"move-to-monitor 1 on {TeamsHwnd}", $"promote on {TeamsHwnd}"], action.Actions);
    }

    [Fact]
    public async Task AWindowAlreadyOpenAtStartup_IsNotPlacedWhenItIsRestored()
    {
        var rule = CreateRule(new FakeTopology(Laptop, External), out var action);

        // First event carrying state seeds the windows komorebi already knows about.
        Focus(rule, action, 99, DockedState(99, new WindowSpec(99, "Repo - Edge", "msedge.exe"),
            new WindowSpec(TeamsHwnd, "Chat | Microsoft Teams", TeamsExe, TeamsClass)));
        await Settle(rule);
        Assert.Empty(action.Actions); // precondition: seeding places nothing itself

        Show(rule, TeamsHwnd);
        Focus(rule, action, TeamsHwnd, DockedState(TeamsHwnd));
        await Settle(rule);

        Assert.Empty(action.Actions);
    }

    [Fact]
    public async Task AWindowOpenInTheFirstStatefulEvent_IsNotPlaced()
    {
        var rule = CreateRule(new FakeTopology(Laptop, External), out var action);

        Show(rule, TeamsHwnd, TeamsExe, DockedState(TeamsHwnd));
        Focus(rule, action, TeamsHwnd, DockedState(TeamsHwnd));
        await Settle(rule);

        Assert.Empty(action.Actions);
    }

    [Fact]
    public async Task AWindowFocusedLongAfterItAppeared_IsNotPlaced()
    {
        var time = new FakeTimeProvider();
        var rule = CreateRule(new FakeTopology(Laptop, External), out var action, time);

        Show(rule, TeamsHwnd);
        time.Advance(TeamsWindowPlacement.PlacementWindow + TimeSpan.FromSeconds(1));
        Focus(rule, action, TeamsHwnd, DockedState(TeamsHwnd));
        await Settle(rule);

        Assert.Empty(action.Actions);
    }

    [Fact]
    public async Task AWindowFocusedInsideThePlacementWindow_IsStillPlaced()
    {
        var time = new FakeTimeProvider();
        var rule = CreateRule(new FakeTopology(Laptop, External), out var action, time);

        Show(rule, TeamsHwnd);
        time.Advance(TeamsWindowPlacement.PlacementWindow - TimeSpan.FromSeconds(1));
        Focus(rule, action, TeamsHwnd, DockedState(TeamsHwnd));
        await Settle(rule);

        Assert.Equal([$"move-to-monitor 1 on {TeamsHwnd}", $"promote on {TeamsHwnd}"], action.Actions);
    }

    [Fact]
    public async Task AWindowKomorebiCallsFocusedButWindowsDoesNot_IsNotMoved()
    {
        // komorebi's state is a snapshot; the foreground is what komorebic will
        // actually act on, so the two disagreeing means the move would hit the
        // wrong window.
        var rule = CreateRule(new FakeTopology(Laptop, External), out var action);

        Show(rule, TeamsHwnd);
        action.ForegroundWindow = 0x999;
        rule.ProcessEvent(new KomorebiWindowEvent(
            "FocusChange", WindowContent(TeamsHwnd, "SystemForeground"), DockedState(TeamsHwnd)));
        await Settle(rule);

        Assert.Empty(action.Actions);
    }

    [Fact]
    public async Task AWindowThatLosesTheForegroundMidPlacement_IsNotPromoted()
    {
        // komorebic promotes whatever holds the foreground, so promoting after focus
        // has moved on would pull the wrong window into the largest tile.
        var rule = CreateRule(new FakeTopology(Laptop, External), out var action);
        const long SecondHwnd = 0x2E0F70;
        action.BlockMove = new TaskCompletionSource();

        Show(rule, TeamsHwnd);
        Focus(rule, action, TeamsHwnd, DockedState(TeamsHwnd));
        var placement = rule.LastPlacement!;
        Assert.False(placement.IsCompleted); // precondition: the move is still in flight

        action.ForegroundWindow = SecondHwnd;
        action.BlockMove.SetResult();
        await placement;

        Assert.Equal([$"move-to-monitor 1 on {TeamsHwnd}"], action.Actions);
    }

    [Fact]
    public async Task AWindowThatArrivesDuringAPlacement_ForfeitsItsAttempt()
    {
        var rule = CreateRule(new FakeTopology(Laptop, External), out var action);
        const long SecondHwnd = 0x2E0F70;
        action.BlockMove = new TaskCompletionSource();

        Show(rule, TeamsHwnd);
        Focus(rule, action, TeamsHwnd, DockedState(TeamsHwnd));
        var first = rule.LastPlacement!;
        Assert.False(first.IsCompleted); // precondition: the first placement is mid-flight

        Show(rule, SecondHwnd);
        Focus(rule, action, SecondHwnd, DockedState(
            SecondHwnd,
            new WindowSpec(SecondHwnd, "Chat | Microsoft Teams", TeamsExe, TeamsClass)));

        // Focus returns to the first window, so only the forfeited attempt explains
        // the second window never being acted on.
        action.ForegroundWindow = TeamsHwnd;
        action.BlockMove.SetResult();
        await first;

        Assert.Equal([$"move-to-monitor 1 on {TeamsHwnd}", $"promote on {TeamsHwnd}"], action.Actions);
    }

    [Fact]
    public async Task ACompletedPlacementLetsTheNextWindowBePlaced()
    {
        var rule = CreateRule(new FakeTopology(Laptop, External), out var action);
        const long SecondHwnd = 0x2E0F70;

        Show(rule, TeamsHwnd);
        Focus(rule, action, TeamsHwnd, DockedState(TeamsHwnd));
        await Settle(rule);

        Show(rule, SecondHwnd);
        Focus(rule, action, SecondHwnd, DockedState(
            SecondHwnd,
            new WindowSpec(SecondHwnd, "Chat | Microsoft Teams", TeamsExe, TeamsClass)));
        await Settle(rule);

        Assert.Equal(
            [$"move-to-monitor 1 on {TeamsHwnd}", $"promote on {TeamsHwnd}",
             $"move-to-monitor 1 on {SecondHwnd}", $"promote on {SecondHwnd}"],
            action.Actions);
    }

    [Fact]
    public async Task AHandleReusedAfterItsWindowDied_IsPlacedAgain()
    {
        var rule = CreateRule(new FakeTopology(Laptop, External), out var action);

        Show(rule, TeamsHwnd);
        Focus(rule, action, TeamsHwnd, DockedState(TeamsHwnd));
        await Settle(rule);
        Assert.Equal([$"move-to-monitor 1 on {TeamsHwnd}", $"promote on {TeamsHwnd}"], action.Actions); // precondition: placed once

        Destroy(rule, TeamsHwnd);
        Show(rule, TeamsHwnd);
        Focus(rule, action, TeamsHwnd, DockedState(TeamsHwnd));
        await Settle(rule);

        Assert.Equal(
            [$"move-to-monitor 1 on {TeamsHwnd}", $"promote on {TeamsHwnd}",
             $"move-to-monitor 1 on {TeamsHwnd}", $"promote on {TeamsHwnd}"],
            action.Actions);
    }

    [Fact]
    public async Task RefocusingAWindowWeNeverSawShown_DoesNothing()
    {
        var rule = CreateRule(new FakeTopology(Laptop, External), out var action);

        Focus(rule, action, TeamsHwnd, DockedState(TeamsHwnd));
        await Settle(rule);

        Assert.Empty(action.Actions);
    }

    [Fact]
    public async Task NewWindowThatDoesNotHoldFocus_IsNotPlaced()
    {
        // Every komorebic move/promote acts on the focused window. If the state
        // disagrees with the event, acting would move somebody else's window.
        var rule = CreateRule(new FakeTopology(Laptop, External), out var action);
        const long OtherHwnd = 0x999;

        Show(rule, TeamsHwnd);
        Focus(rule, action, TeamsHwnd, DockedState(
            OtherHwnd,
            new WindowSpec(OtherHwnd, "Mail - Outlook", "olk.exe"),
            new WindowSpec(TeamsHwnd, "Meeting | Microsoft Teams", TeamsExe, TeamsClass)));
        await Settle(rule);

        Assert.Empty(action.Actions);
    }

    [Fact]
    public async Task NewWindowThatNeverTakesFocus_IsNotPlacedWhenAnotherWindowGainsFocus()
    {
        var rule = CreateRule(new FakeTopology(Laptop, External), out var action);
        const long SecondHwnd = 0x2E0F70;

        Show(rule, TeamsHwnd);
        Focus(rule, action, SecondHwnd, DockedState(
            SecondHwnd,
            new WindowSpec(SecondHwnd, "Chat | Microsoft Teams", TeamsExe, TeamsClass)));
        await Settle(rule);

        Assert.Empty(action.Actions);
    }

    [Theory]
    [InlineData("msedge.exe")]
    [InlineData("olk.exe")]
    [InlineData("Notepad.exe")]
    public async Task NonTeamsWindow_IsNotPlaced(string exe)
    {
        var rule = CreateRule(new FakeTopology(Laptop, External), out var action);

        Show(rule, TeamsHwnd, exe);
        Focus(rule, action, TeamsHwnd, DockedState(TeamsHwnd), exe);
        await Settle(rule);

        Assert.Empty(action.Actions);
    }

    [Fact]
    public async Task TeamsExeMatchIsCaseInsensitive()
    {
        var rule = CreateRule(new FakeTopology(Laptop, External), out var action);

        Show(rule, TeamsHwnd, "MS-Teams.exe");
        Focus(rule, action, TeamsHwnd, DockedState(TeamsHwnd), "MS-Teams.exe");
        await Settle(rule);

        Assert.Equal([$"move-to-monitor 1 on {TeamsHwnd}", $"promote on {TeamsHwnd}"], action.Actions);
    }

    [Fact]
    public async Task AFocusWithoutStateConsumesTheOneAttempt()
    {
        var rule = CreateRule(new FakeTopology(Laptop, External), out var action);

        Show(rule, TeamsHwnd);
        Focus(rule, action, TeamsHwnd, null);
        Focus(rule, action, TeamsHwnd, DockedState(TeamsHwnd));
        await Settle(rule);

        Assert.Empty(action.Actions);
    }

    [Theory]
    [InlineData("TitleUpdate")]
    [InlineData("Cloak")]
    [InlineData("Minimize")]
    public async Task OtherEventTypes_DoNotPlace(string eventType)
    {
        var rule = CreateRule(new FakeTopology(Laptop, External), out var action);

        rule.ProcessEvent(new KomorebiWindowEvent(
            eventType, WindowContent(TeamsHwnd, "ObjectShow"), DockedState(TeamsHwnd)));
        await Settle(rule);

        Assert.Empty(action.Actions);
    }

    [Theory]
    [InlineData("FocusWorkspaceNumber", "[\"Reason\", 12]")]
    [InlineData("MonitorPoll", "[\"Reason\", \"Timer\"]")]
    [InlineData("ReconcileMonitors", "[\"Reason\", [1, 2]]")]
    public void AnEventThatCarriesNoWindow_IsPassedOverQuietly(string eventType, string content)
    {
        // komorebi sends plenty of events whose content is not a window. Reading
        // one as a window turns ordinary traffic into a logged failure.
        var logger = new RecordingLogger<TeamsWindowPlacement>();
        var action = new FakeWindowAction();
        var rule = new TeamsWindowPlacement(
            logger, action, new FakeTopology(Laptop, External), new FakeTimeProvider());

        rule.ProcessEvent(new KomorebiWindowEvent(eventType, TestJson.Parse(content), DockedState(TeamsHwnd)));

        Assert.Empty(logger.Warnings);
        Assert.Empty(action.Actions);
    }

    [Fact]
    public async Task MalformedContent_IsIgnored()
    {
        var rule = CreateRule(new FakeTopology(Laptop, External), out var action);

        rule.ProcessEvent(new KomorebiWindowEvent("Show", TestJson.Parse("""{ "not": "a tuple" }"""), null));
        rule.ProcessEvent(new KomorebiWindowEvent("FocusChange", null, null));
        await Settle(rule);

        Assert.Empty(action.Actions);
    }

    [Fact]
    public void ResolveDestination_MissingMonitorAtIndex_IsNull()
    {
        var rule = CreateRule(new FakeTopology(Laptop, External), out _);
        var state = TestJson.MultiMonitorState([new MonitorSpec(Laptop, [])]);

        Assert.Null(rule.ResolveDestination(state));
    }

    [Fact]
    public void ResolveDestination_MonitorWithoutSize_IsNull()
    {
        var rule = CreateRule(new FakeTopology(Laptop, External), out _);
        var state = TestJson.MultiMonitorState(
            [new MonitorSpec(Laptop, []), new MonitorSpec(null, [])]);

        Assert.Null(rule.ResolveDestination(state));
    }

    [Fact]
    public void ResolveDestination_StaleMonitorWithADifferentRect_IsNull()
    {
        var panel = new MonitorBounds(0, 0, 2496, 1664);
        var rule = CreateRule(new FakeTopology(panel), out _);
        var state = TestJson.MultiMonitorState(
            [new MonitorSpec(panel, []), new MonitorSpec(External, [])]);

        Assert.Null(rule.ResolveDestination(state));
    }

    [Fact]
    public void ResolveDestination_BoundsSharedWithAnotherListedMonitor_IsNull()
    {
        // komorebi lists a stale monitor whose remembered bounds match an attached
        // one, so a hit-test on those bounds cannot say which of the two it found.
        var topology = new FakeTopology(Laptop);
        var rule = CreateRule(topology, out _);
        var state = TestJson.MultiMonitorState(
            [new MonitorSpec(Laptop, []), new MonitorSpec(Laptop, [])]);

        Assert.True(topology.IsAttached(Laptop)); // precondition: the bounds report as attached
        Assert.Null(rule.ResolveDestination(state));
    }

    [Fact]
    public void ResolveDestination_AttachedExternalMonitor_IsIndexOne()
    {
        var rule = CreateRule(new FakeTopology(Laptop, External), out _);
        var state = TestJson.MultiMonitorState(
            [new MonitorSpec(Laptop, []), new MonitorSpec(External, [])]);

        Assert.Equal(TeamsWindowPlacement.ExternalMonitorIndex, rule.ResolveDestination(state));
    }
}
