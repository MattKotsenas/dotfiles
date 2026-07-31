using EventListeners.Generated;
using EventListeners.Win32;
using Microsoft.Extensions.Logging;

namespace EventListeners;

public interface ITeamsMeetingJoin
{
    void Join();
}

/// <summary>
/// Joins the meeting the user means, preferring to invoke a control directly over
/// sending a keyboard shortcut.
///
/// Invoking needs no focus, so it works from any application, and it cannot land
/// on the wrong window. A keyboard chord is used only where the intended join
/// control cannot be identified: several joinable calendar meetings, where Teams
/// tracks a selection it does not expose, and the toast fallback below.
///
/// Scans take a few hundred milliseconds, so the work runs off the kanata event
/// loop. Requests arriving while one is in flight are dropped rather than queued:
/// a second join is never what the user wanted, and a queued one would act on a
/// foreground window that has since moved.
///
/// TODO: gate the toast chord on an actual meeting-started toast.
/// </summary>
internal sealed class TeamsMeetingJoin : ITeamsMeetingJoin
{
    /// <summary>
    /// How long to wait for Teams to actually reach the foreground. Focus arrives
    /// asynchronously, and ForceForeground's return value is an unreliable false
    /// negative, so the foreground window itself is the only sound signal.
    /// </summary>
    private static readonly TimeSpan FocusTimeout = TimeSpan.FromMilliseconds(600);

    private static readonly TimeSpan FocusPollInterval = TimeSpan.FromMilliseconds(25);

    private readonly ILogger<TeamsMeetingJoin> _logger;
    private readonly Lazy<IKanataClient> _kanata;
    private readonly ITeamsSurface _teams;
    private readonly Func<nint> _readForeground;

    private int _running;

    public TeamsMeetingJoin(
        ILogger<TeamsMeetingJoin> logger,
        Lazy<IKanataClient> kanata,
        ITeamsSurface teams)
        : this(logger, kanata, teams, NativeWindows.GetForeground)
    {
    }

    internal TeamsMeetingJoin(
        ILogger<TeamsMeetingJoin> logger,
        Lazy<IKanataClient> kanata,
        ITeamsSurface teams,
        Func<nint> readForeground)
    {
        _logger = logger;
        _kanata = kanata;
        _teams = teams;
        _readForeground = readForeground;
    }

    public void Join()
    {
        if (Interlocked.CompareExchange(ref _running, 1, 0) != 0)
        {
            _logger.LogDebug("Ignoring a join request while one is already running");
            return;
        }

        _ = Task.Run(async () =>
        {
            try
            {
                await ExecuteAsync();
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Joining failed");
            }
            finally
            {
                Volatile.Write(ref _running, 0);
            }
        });
    }

    internal async Task ExecuteAsync()
    {
        var decision = JoinStrategy.Decide(_teams.Capture(), _readForeground());

        switch (decision)
        {
            case JoinDecision.Invoke invoke:
                _logger.LogInformation("Joining: {Because}", invoke.Because);
                if (!_teams.InvokeById(invoke.Hwnd, invoke.AutomationId))
                {
                    _logger.LogWarning("The join control went away before it could be invoked");
                }
                break;

            case JoinDecision.InvokeCalendarJoin calendar:
                _logger.LogInformation("Joining '{Meeting}' from the calendar", calendar.MeetingName);
                if (!_teams.InvokeCalendarJoin(calendar.Hwnd, calendar.MeetingName))
                {
                    _logger.LogWarning("The calendar join went away before it could be invoked");
                }
                break;

            case JoinDecision.FocusThenChord chord:
                await FocusThenChordAsync(chord);
                break;

            case JoinDecision.ToastChord toast:
                _logger.LogInformation("No meeting found ({Because}); trying the toast shortcut", toast.Because);
                await _kanata.Value.TapVirtualKeyAsync(LayerCatalog.VirtualKeyTeamsJoinToast);
                break;

            case JoinDecision.Refuse refuse:
                _logger.LogInformation("Not joining: {Because}", refuse.Because);
                break;
        }
    }

    /// <summary>
    /// Hands the choice to Teams, which knows which calendar event is selected.
    ///
    /// The chord is sent only once Teams is confirmed foreground. That still leaves
    /// a race, accepted knowingly: focus can move between the confirmation and
    /// kanata emitting the keys, and the chord would land wherever focus went.
    /// Polling narrows the gap; it cannot close it.
    /// </summary>
    private async Task FocusThenChordAsync(JoinDecision.FocusThenChord chord)
    {
        _logger.LogInformation(
            "{Count} meetings are joinable ({Candidates}); letting Teams choose",
            chord.Candidates.Count,
            string.Join(", ", chord.Candidates));

        NativeWindows.ForceForeground(chord.Hwnd);

        if (!await WaitForForegroundAsync(chord.Hwnd))
        {
            _logger.LogWarning(
                "Teams did not reach the foreground within {Timeout}ms, so no keys were sent",
                FocusTimeout.TotalMilliseconds);
            return;
        }

        await _kanata.Value.TapVirtualKeyAsync(LayerCatalog.VirtualKeyTeamsJoinFocused);
    }

    private async Task<bool> WaitForForegroundAsync(nint hwnd)
    {
        var deadline = DateTime.UtcNow + FocusTimeout;
        while (DateTime.UtcNow < deadline)
        {
            if (_readForeground() == hwnd) return true;
            await Task.Delay(FocusPollInterval);
        }

        return _readForeground() == hwnd;
    }
}
