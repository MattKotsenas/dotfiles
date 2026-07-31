using Microsoft.Extensions.Logging.Abstractions;

namespace EventListeners.Tests;

public class TeamsCallControlsTests
{
    [Fact]
    public async Task Leave_PressesTheCallsOwnHangupButton()
    {
        // Pressing the button rather than sending a shortcut is the point: it needs
        // no focus, so leaving works from any application.
        var teams = new ScriptedSurface(ControlSearch.Invoked);

        await LeaveAsync(teams);

        Assert.Equal(["hangup-button"], teams.Requested);
    }

    [Fact]
    public async Task Leave_RetriesAMiss_BecauseAColdTreeLooksLikeNoCall()
    {
        // Observed live: a Teams window can report an almost empty tree. One miss is
        // not proof that no call is running, so a second look is worth taking.
        var teams = new ScriptedSurface(ControlSearch.NotFound, ControlSearch.Invoked);

        await LeaveAsync(teams);

        Assert.Equal(["hangup-button", "hangup-button"], teams.Requested);
    }

    [Fact]
    public async Task Leave_RetriesAFailedRead()
    {
        var teams = new ScriptedSurface(ControlSearch.Failed, ControlSearch.Invoked);

        await LeaveAsync(teams);

        Assert.Equal(2, teams.Requested.Count);
    }

    [Fact]
    public async Task Leave_GivesUpRatherThanRetryingForever()
    {
        var teams = new ScriptedSurface(ControlSearch.NotFound);

        await LeaveAsync(teams);

        // It kept looking, then stopped. The exact count depends on timing; what
        // matters is that it bounded itself instead of spinning.
        Assert.InRange(teams.Requested.Count, 2, 40);
    }

    [Fact]
    public async Task Leave_WithSeveralCalls_PressesNothing()
    {
        // Teams can hold one call while another is active. Enumeration order is not
        // evidence of which one the user meant, so pressing either would be a guess.
        var teams = new ScriptedSurface(ControlSearch.Ambiguous);

        await LeaveAsync(teams);

        // Asked once and stopped: ambiguity is not the sort of thing retrying fixes.
        Assert.Single(teams.Requested);
    }

    [Fact]
    public void SecondLeave_IsDroppedWhileTheFirstIsRunning()
    {
        var release = new SemaphoreSlim(0, 1);
        var teams = new BlockingSurface(release);
        var controls = new TeamsCallControls(NullLogger<TeamsCallControls>.Instance, teams);

        controls.Leave();
        Assert.True(
            teams.FirstCall.Wait(TimeSpan.FromSeconds(5)),
            "precondition: the first leave must be running and blocked");

        controls.Leave();

        Assert.False(
            teams.SecondCall.Wait(TimeSpan.FromSeconds(1)),
            "the second leave reached the Teams surface instead of being dropped");

        release.Release();
    }

    [Fact]
    public async Task AfterALeaveCompletes_TheNextOneStillRuns()
    {
        // The in-flight guard must be released, not merely set. Leaving once and
        // then never again is worse than never having worked.
        var teams = new CountingSurface();
        var controls = new TeamsCallControls(NullLogger<TeamsCallControls>.Instance, teams);

        await controls.RunAsync();
        Assert.Equal(1, teams.Calls);

        await controls.RunAsync();

        Assert.Equal(2, teams.Calls);
    }

    [Fact]
    public async Task AfterAThrowingLeave_TheNextOneStillRuns()
    {
        var teams = new CountingSurface { Throw = true };
        var controls = new TeamsCallControls(NullLogger<TeamsCallControls>.Instance, teams);

        await controls.RunAsync();
        Assert.Equal(1, teams.Calls);
        teams.Throw = false;

        await controls.RunAsync();

        Assert.Equal(2, teams.Calls);
    }

    [Fact]
    public async Task AHungScan_IsNeverJoinedByASecond()
    {
        // A timed-out scan leaves a blocked thread behind, because the UIA call is
        // synchronous and cannot be cancelled. Pressing the key again is exactly
        // what a user does when nothing happens, so each press must not strand
        // another thread.
        var release = new SemaphoreSlim(0, 1);
        var teams = new HangingSurface(release);
        var controls = new TeamsCallControls(NullLogger<TeamsCallControls>.Instance, teams)
        {
            ScanCeiling = TimeSpan.FromMilliseconds(200),
        };

        await controls.RunAsync();
        Assert.Equal(1, teams.Started);

        await controls.RunAsync();
        await controls.RunAsync();

        Assert.Equal(1, teams.Started);
        release.Release();
    }

    private static async Task LeaveAsync(ITeamsSurface teams) =>
        await new TeamsCallControls(NullLogger<TeamsCallControls>.Instance, teams).LeaveAsync();

    /// <summary>Blocks forever, the way a wedged UIA provider does.</summary>
    private sealed class HangingSurface(SemaphoreSlim release) : ITeamsSurface
    {
        private int _started;

        public int Started => Volatile.Read(ref _started);

        public ControlSearch InvokeUniqueInAnyWindow(string automationId)
        {
            Interlocked.Increment(ref _started);
            release.Wait(TimeSpan.FromSeconds(30));
            return ControlSearch.Invoked;
        }

        public TeamsSnapshot Capture() => TeamsSnapshot.Nothing;

        public bool InvokeById(nint hwnd, string automationId) => true;

        public bool InvokeCalendarJoin(nint hwnd, string meetingName) => true;
    }

    private sealed class CountingSurface : ITeamsSurface
    {
        public int Calls { get; private set; }
        public bool Throw { get; set; }

        public ControlSearch InvokeUniqueInAnyWindow(string automationId)
        {
            Calls++;
            if (Throw) throw new InvalidOperationException("the window went away");
            return ControlSearch.Invoked;
        }

        public TeamsSnapshot Capture() => TeamsSnapshot.Nothing;

        public bool InvokeById(nint hwnd, string automationId) => true;

        public bool InvokeCalendarJoin(nint hwnd, string meetingName) => true;
    }

    /// <summary>Returns each scripted outcome in turn, repeating the last forever.</summary>
    private sealed class ScriptedSurface(params ControlSearch[] outcomes) : ITeamsSurface
    {
        public List<string> Requested { get; } = [];

        public ControlSearch InvokeUniqueInAnyWindow(string automationId)
        {
            Requested.Add(automationId);
            return outcomes[Math.Min(Requested.Count - 1, outcomes.Length - 1)];
        }

        public TeamsSnapshot Capture() =>
            throw new InvalidOperationException("Leaving must not scan for meetings to join.");

        public bool InvokeById(nint hwnd, string automationId) =>
            throw new InvalidOperationException("Leaving is not scoped to a known window.");

        public bool InvokeCalendarJoin(nint hwnd, string meetingName) =>
            throw new InvalidOperationException("Leaving has nothing to do with the calendar.");
    }

    private sealed class BlockingSurface(SemaphoreSlim release) : ITeamsSurface
    {
        private int _calls;

        public ManualResetEventSlim FirstCall { get; } = new(false);
        public ManualResetEventSlim SecondCall { get; } = new(false);

        public ControlSearch InvokeUniqueInAnyWindow(string automationId)
        {
            if (Interlocked.Increment(ref _calls) == 1)
            {
                FirstCall.Set();
                release.Wait(TimeSpan.FromSeconds(10));
            }
            else
            {
                SecondCall.Set();
            }

            return ControlSearch.Invoked;
        }

        public TeamsSnapshot Capture() => TeamsSnapshot.Nothing;

        public bool InvokeById(nint hwnd, string automationId) => true;

        public bool InvokeCalendarJoin(nint hwnd, string meetingName) => true;
    }
}
