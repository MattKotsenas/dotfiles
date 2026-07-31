using EventListeners.Generated;

namespace EventListeners.Tests;

public class JoinStrategyTests
{
    private const nint Prejoin1 = 100;
    private const nint Prejoin2 = 200;
    private const nint CalendarHwnd = 300;
    private const nint Elsewhere = 999;

    private static PrejoinWindow Prejoin(nint hwnd, string name) =>
        new(hwnd, name, ["prejoin-join-button"]);

    private static CalendarWindow Calendar(params string[] joinable) =>
        new(CalendarHwnd, TotalButtons: 125, joinable);

    [Fact]
    public void FocusedCalendar_BeatsAPrejoinLeftOpenBehindIt()
    {
        // The regression this ordering exists to prevent: joining a meeting the user
        // walked away from instead of the one they are looking at.
        var teams = new TeamsSnapshot([Prejoin(Prejoin1, "abandoned")], Calendar("what I want"));

        var decision = JoinStrategy.Decide(teams, foregroundHwnd: CalendarHwnd);

        var invoke = Assert.IsType<JoinDecision.InvokeCalendarJoin>(decision);
        Assert.Equal("what I want", invoke.MeetingName);
    }

    [Fact]
    public void SeveralWaysToJoinOneMeeting_Refuses()
    {
        // A broadcast can offer attendee and presenter at once. They are different
        // joins, and guessing picks the user's role for them.
        var teams = new TeamsSnapshot(
            [new PrejoinWindow(Prejoin1, "town hall",
                ["join-broadcast-as-attendee-button", "prejoin-join-button-broadcast-etm"])],
            null);

        var refuse = Assert.IsType<JoinDecision.Refuse>(
            JoinStrategy.Decide(teams, foregroundHwnd: Prejoin1));

        Assert.Contains("town hall", refuse.Because);
        Assert.Contains("join-broadcast-as-attendee-button", refuse.Because);
    }

    [Fact]
    public void FocusedPrejoin_IsInvoked()
    {
        var teams = new TeamsSnapshot(
            [Prejoin(Prejoin1, "standup"), Prejoin(Prejoin2, "retro")],
            Calendar());

        var decision = JoinStrategy.Decide(teams, foregroundHwnd: Prejoin2);

        var invoke = Assert.IsType<JoinDecision.Invoke>(decision);
        Assert.Equal(Prejoin2, invoke.Hwnd);
        Assert.Contains("retro", invoke.Because);
    }

    [Fact]
    public void SinglePrejoin_IsInvoked_EvenFromAnotherApp()
    {
        // The whole point of using UIA over a chord: this works from Edge.
        var teams = new TeamsSnapshot([Prejoin(Prejoin1, "standup")], Calendar());

        var decision = JoinStrategy.Decide(teams, foregroundHwnd: Elsewhere);

        var invoke = Assert.IsType<JoinDecision.Invoke>(decision);
        Assert.Equal(Prejoin1, invoke.Hwnd);
    }

    [Fact]
    public void SeveralPrejoins_NoneFocused_Refuses()
    {
        // A prejoin window left open is as likely abandoned as wanted, so with no
        // focus to disambiguate, guessing risks joining the wrong meeting.
        var teams = new TeamsSnapshot(
            [Prejoin(Prejoin1, "standup"), Prejoin(Prejoin2, "retro")],
            Calendar());

        var decision = JoinStrategy.Decide(teams, foregroundHwnd: Elsewhere);

        var refuse = Assert.IsType<JoinDecision.Refuse>(decision);
        Assert.Contains("standup", refuse.Because);
        Assert.Contains("retro", refuse.Because);
    }

    [Fact]
    public void PrejoinCarriesItsOwnAutomationId()
    {
        // Teams uses different ids per meeting type, so the id travels with the
        // window rather than being assumed by the caller.
        var teams = new TeamsSnapshot(
            [new PrejoinWindow(Prejoin1, "town hall", ["join-broadcast-as-attendee-button"])],
            null);

        var invoke = Assert.IsType<JoinDecision.Invoke>(
            JoinStrategy.Decide(teams, foregroundHwnd: Elsewhere));

        Assert.Equal("join-broadcast-as-attendee-button", invoke.AutomationId);
    }

    [Fact]
    public void OneJoinableMeeting_IsInvokedDirectly()
    {
        var teams = new TeamsSnapshot([], Calendar("asdf, 12:00 PM to 12:30 PM"));

        var invoke = Assert.IsType<JoinDecision.InvokeCalendarJoin>(
            JoinStrategy.Decide(teams, foregroundHwnd: Elsewhere));

        Assert.Equal(CalendarHwnd, invoke.Hwnd);
        Assert.Contains("asdf", invoke.MeetingName);
    }

    [Fact]
    public void SeveralJoinableMeetings_DeferToTeamsSelection()
    {
        // Teams does not expose which calendar event is selected, so only Teams
        // itself can break the tie.
        var teams = new TeamsSnapshot([], Calendar("asdf", "asdf2"));

        var chord = Assert.IsType<JoinDecision.FocusThenChord>(
            JoinStrategy.Decide(teams, foregroundHwnd: Elsewhere));

        Assert.Equal(CalendarHwnd, chord.Hwnd);
        Assert.Equal(["asdf", "asdf2"], chord.Candidates);
    }

    [Fact]
    public void ColdCalendar_Refuses_RatherThanReadingItAsEmpty()
    {
        // Observed live: the same window reported 0 buttons twice, then 126. Reading
        // that first scan as "nothing to join" would fire the blind toast chord; with
        // one joinable meeting present it would silently skip joining it.
        var cold = new CalendarWindow(CalendarHwnd, TotalButtons: 0, JoinableMeetings: []);

        var refuse = Assert.IsType<JoinDecision.Refuse>(
            JoinStrategy.Decide(new TeamsSnapshot([], cold), foregroundHwnd: Elsewhere));

        Assert.Contains("incomplete", refuse.Because);
    }

    [Theory]
    // Literal values, not the constant: writing the threshold into the test as
    // MinimumPlausibleButtons would move with it and assert nothing.
    [InlineData(0, false)]
    [InlineData(9, false)]
    [InlineData(10, true)]
    [InlineData(125, true)]
    public void PlausibilityGuardSitsAtTen(int buttons, bool trusted)
    {
        Assert.Equal(10, JoinStrategy.MinimumPlausibleButtons);
        var calendar = new CalendarWindow(CalendarHwnd, buttons, ["asdf"]);

        var decision = JoinStrategy.Decide(new TeamsSnapshot([], calendar), Elsewhere);

        if (trusted)
        {
            Assert.IsType<JoinDecision.InvokeCalendarJoin>(decision);
        }
        else
        {
            Assert.IsType<JoinDecision.Refuse>(decision);
        }
    }

    [Fact]
    public void FailedScan_Refuses_RatherThanReadingItAsNothingToJoin()
    {
        // A read that threw says nothing about what is on screen. Treating it as an
        // empty Teams would fire the blind toast chord at the focused application.
        var refuse = Assert.IsType<JoinDecision.Refuse>(
            JoinStrategy.Decide(TeamsSnapshot.Failed, foregroundHwnd: Elsewhere));

        Assert.Contains("partial", refuse.Because);
    }

    [Fact]
    public void PartialScan_Refuses_EvenWhenSomethingWasFound()
    {
        // A prejoin whose join control had not rendered marks the whole reading
        // partial. The calendar meeting here looks joinable, but the meeting we
        // failed to read may be the one the user meant.
        var partial = new TeamsSnapshot([], Calendar("asdf"), Complete: false);

        Assert.IsType<JoinDecision.Refuse>(JoinStrategy.Decide(partial, Elsewhere));
    }

    [Fact]
    public void NoCalendarWindow_FallsBackToTheToastChord()
    {
        var toast = Assert.IsType<JoinDecision.ToastChord>(
            JoinStrategy.Decide(TeamsSnapshot.Nothing, foregroundHwnd: Elsewhere));

        Assert.Contains("calendar", toast.Because);
    }

    [Fact]
    public void WarmCalendarWithNothingJoinable_FallsBackToTheToastChord()
    {
        var decision = JoinStrategy.Decide(new TeamsSnapshot([], Calendar()), Elsewhere);

        var toast = Assert.IsType<JoinDecision.ToastChord>(decision);
        Assert.Contains("joinable", toast.Because);
    }

    [Fact]
    public void PrejoinBeatsTheCalendar()
    {
        // A meeting already waiting to be joined is a stronger signal than a
        // calendar entry that merely could be joined.
        var teams = new TeamsSnapshot([Prejoin(Prejoin1, "standup")], Calendar("asdf", "asdf2"));

        Assert.IsType<JoinDecision.Invoke>(JoinStrategy.Decide(teams, Elsewhere));
    }
}
