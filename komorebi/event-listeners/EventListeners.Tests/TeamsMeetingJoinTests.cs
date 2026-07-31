using EventListeners.Generated;
using Microsoft.Extensions.Logging.Abstractions;

namespace EventListeners.Tests;

public class TeamsMeetingJoinTests
{
    private const nint PrejoinHwnd = 100;
    private const nint CalendarHwnd = 300;
    private const nint Elsewhere = 999;

    [Fact]
    public async Task PrejoinMeeting_IsInvoked_NotTypedAt()
    {
        // The point of the whole design: joining presses a button, it does not
        // fire keys at whatever happens to be focused.
        var teams = FakeSurface.WithPrejoin("standup");
        var kanata = new RecordingKanataClient();

        await JoinAsync(teams, kanata);

        Assert.Equal([(PrejoinHwnd, "prejoin-join-button")], teams.Invoked);
        Assert.Empty(kanata.VirtualKeyTaps);
    }

    [Fact]
    public async Task SingleCalendarMeeting_IsInvoked_NotTypedAt()
    {
        var teams = FakeSurface.WithCalendar("asdf");
        var kanata = new RecordingKanataClient();

        await JoinAsync(teams, kanata);

        Assert.Equal([(CalendarHwnd, "asdf")], teams.CalendarInvoked);
        Assert.Empty(kanata.VirtualKeyTaps);
    }

    [Fact]
    public async Task NothingJoinable_FallsBackToTheToastChord()
    {
        var teams = FakeSurface.WithCalendar();
        var kanata = new RecordingKanataClient();

        await JoinAsync(teams, kanata);

        Assert.Equal([LayerCatalog.VirtualKeyTeamsJoinToast], kanata.VirtualKeyTaps);
        Assert.Empty(teams.Invoked);
    }

    [Fact]
    public async Task ColdScan_SendsNothingAtAll()
    {
        // The dangerous case. An incomplete scan looks like an empty calendar, and
        // acting on it would fire a blind chord at the focused app.
        var teams = new FakeSurface(new TeamsSnapshot([], new CalendarWindow(CalendarHwnd, 0, [])));
        var kanata = new RecordingKanataClient();

        await JoinAsync(teams, kanata);

        Assert.Empty(kanata.VirtualKeyTaps);
        Assert.Empty(teams.Invoked);
        Assert.Empty(teams.CalendarInvoked);
    }

    [Fact]
    public async Task AmbiguousMeetings_SendTheChordOnlyOnceTeamsIsForeground()
    {
        var teams = FakeSurface.WithCalendar("asdf", "asdf2");
        var kanata = new RecordingKanataClient();

        // Focus lands on the third poll, the way a cold ForceForeground behaves.
        var reads = 0;
        await JoinAsync(teams, kanata, () => ++reads >= 3 ? CalendarHwnd : Elsewhere);

        Assert.Equal([LayerCatalog.VirtualKeyTeamsJoinFocused], kanata.VirtualKeyTaps);
    }

    [Fact]
    public async Task AmbiguousMeetings_SendNothingIfFocusNeverLands()
    {
        // Better to do nothing than to fire Ctrl+J into another application.
        var teams = FakeSurface.WithCalendar("asdf", "asdf2");
        var kanata = new RecordingKanataClient();

        await JoinAsync(teams, kanata, () => Elsewhere);

        Assert.Empty(kanata.VirtualKeyTaps);
    }

    [Fact]
    public void SecondJoin_IsDroppedWhileTheFirstIsRunning()
    {
        // Scans take hundreds of milliseconds. A queued second join would act on a
        // foreground window that has since moved.
        var release = new SemaphoreSlim(0, 1);
        var teams = new BlockingSurface(release);
        var join = new TeamsMeetingJoin(
            NullLogger<TeamsMeetingJoin>.Instance,
            new Lazy<IKanataClient>(() => new RecordingKanataClient()),
            teams,
            () => Elsewhere);

        join.Join();
        Assert.True(
            teams.FirstCapture.Wait(TimeSpan.FromSeconds(5)),
            "precondition: the first join must be running and blocked");

        join.Join();

        // The second request must never reach the surface. Waiting on its signal
        // gives it room to arrive: asserting immediately would pass merely because
        // its task had not been scheduled yet.
        Assert.False(
            teams.SecondCapture.Wait(TimeSpan.FromSeconds(1)),
            "the second join reached the Teams surface instead of being dropped");

        release.Release();
    }

    private static async Task JoinAsync(
        FakeSurface teams,
        IKanataClient kanata,
        Func<nint>? foreground = null) =>
        await new TeamsMeetingJoin(
            NullLogger<TeamsMeetingJoin>.Instance,
            new Lazy<IKanataClient>(() => kanata),
            teams,
            foreground ?? (() => Elsewhere)).ExecuteAsync();

    private sealed class FakeSurface(TeamsSnapshot snapshot) : ITeamsSurface
    {
        public List<(nint Hwnd, string Id)> Invoked { get; } = [];
        public List<(nint Hwnd, string Meeting)> CalendarInvoked { get; } = [];

        public static FakeSurface WithPrejoin(string meeting) =>
            new(new TeamsSnapshot(
                [new PrejoinWindow(PrejoinHwnd, meeting, ["prejoin-join-button"])],
                null));

        public static FakeSurface WithCalendar(params string[] joinable) =>
            new(new TeamsSnapshot([], new CalendarWindow(CalendarHwnd, 125, joinable)));

        public TeamsSnapshot Capture() => snapshot;

        public bool InvokeById(nint hwnd, string automationId)
        {
            Invoked.Add((hwnd, automationId));
            return true;
        }

        public bool InvokeCalendarJoin(nint hwnd, string meetingName)
        {
            CalendarInvoked.Add((hwnd, meetingName));
            return true;
        }
    }

    /// <summary>
    /// Blocks inside <see cref="Capture"/> so a second join can be attempted while
    /// the first is still running, and signals each arrival.
    /// </summary>
    private sealed class BlockingSurface(SemaphoreSlim release) : ITeamsSurface
    {
        private int _captures;

        public ManualResetEventSlim FirstCapture { get; } = new(false);
        public ManualResetEventSlim SecondCapture { get; } = new(false);

        public TeamsSnapshot Capture()
        {
            if (Interlocked.Increment(ref _captures) == 1)
            {
                FirstCapture.Set();
                release.Wait(TimeSpan.FromSeconds(10));
            }
            else
            {
                SecondCapture.Set();
            }

            return TeamsSnapshot.Nothing;
        }

        public bool InvokeById(nint hwnd, string automationId) => true;

        public bool InvokeCalendarJoin(nint hwnd, string meetingName) => true;
    }

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
