namespace EventListeners;

/// <summary>A prejoin window: a meeting waiting for the user to join it.</summary>
/// <param name="Hwnd">The window the join control lives in.</param>
/// <param name="MeetingName">The meeting, for logging.</param>
/// <param name="JoinAutomationIds">Every join control the window offers.</param>
internal sealed record PrejoinWindow(
    nint Hwnd,
    string MeetingName,
    IReadOnlyList<string> JoinAutomationIds);

/// <summary>
/// What the Teams calendar offers. <paramref name="TotalButtons"/> is the
/// plausibility guard: a cold or virtualized Teams window reports an almost
/// empty tree, and a join count taken from one of those is meaningless.
/// </summary>
internal sealed record CalendarWindow(
    nint Hwnd,
    int TotalButtons,
    IReadOnlyList<string> JoinableMeetings);

/// <summary>
/// Everything the strategies need to know about Teams right now.
///
/// <paramref name="Complete"/> is false when the read failed or came back
/// self-evidently partial. That is not the same as finding nothing: acting on a
/// partial read is how a blind chord gets fired at the wrong application, so the
/// strategies refuse instead.
/// </summary>
internal sealed record TeamsSnapshot(
    IReadOnlyList<PrejoinWindow> Prejoins,
    CalendarWindow? Calendar,
    bool Complete = true)
{
    /// <summary>Teams is running but offered nothing. A trustworthy negative.</summary>
    public static TeamsSnapshot Nothing { get; } = new([], null);

    /// <summary>The read failed. Says nothing about what is on screen.</summary>
    public static TeamsSnapshot Failed { get; } = new([], null, Complete: false);
}

/// <summary>What to do about a join request. One of these, never several.</summary>
internal abstract record JoinDecision
{
    /// <summary>Invoke a join control directly. Needs no focus and cannot miss.</summary>
    internal sealed record Invoke(nint Hwnd, string AutomationId, string Because) : JoinDecision;

    /// <summary>
    /// Invoke the calendar join belonging to <paramref name="MeetingName"/>. Carries
    /// the meeting rather than an element so the surface re-resolves the button at
    /// invoke time, after the calendar has had a chance to re-render.
    /// </summary>
    internal sealed record InvokeCalendarJoin(nint Hwnd, string MeetingName) : JoinDecision;

    /// <summary>
    /// Let Teams pick, because several meetings are joinable and Teams does not
    /// expose which one is selected. Requires focus, so it carries the race the
    /// user accepted: focus can move between the check and the keystroke.
    /// </summary>
    internal sealed record FocusThenChord(nint Hwnd, IReadOnlyList<string> Candidates) : JoinDecision;

    /// <summary>Tap the toast chord. Ungated: with no toast it reaches whatever is focused.</summary>
    internal sealed record ToastChord(string Because) : JoinDecision;

    /// <summary>Do nothing, and say why.</summary>
    internal sealed record Refuse(string Because) : JoinDecision;
}

internal static class JoinStrategy
{
    internal const string PrejoinTitlePrefix = "Meeting join |";
    internal const string CalendarTitlePrefix = "Calendar |";

    /// <summary>
    /// Chooses what to do, given what Teams shows and what the user is looking at.
    ///
    /// The foreground window is the strongest evidence of intent and is consulted
    /// first, in both directions: a prejoin the user is looking at is the meeting
    /// they mean, and so is the calendar they are looking at. Only when the user is
    /// elsewhere does a lone prejoin left open count as the answer.
    /// </summary>
    internal static JoinDecision Decide(TeamsSnapshot teams, nint foregroundHwnd)
    {
        if (!teams.Complete)
        {
            return new JoinDecision.Refuse(
                "could not read the Teams window reliably; a partial reading is not " +
                "evidence that there is nothing to join");
        }

        var focusedPrejoin = teams.Prejoins.FirstOrDefault(p => p.Hwnd == foregroundHwnd);
        if (focusedPrejoin is not null)
        {
            return ForPrejoin(focusedPrejoin, "it is focused");
        }

        // A focused calendar outranks a prejoin sitting behind it: that prejoin is as
        // likely a meeting the user walked away from as one they want now.
        if (teams.Calendar is { } calendar && calendar.Hwnd == foregroundHwnd)
        {
            return DecideFromCalendar(calendar);
        }

        if (teams.Prejoins.Count == 1)
        {
            return ForPrejoin(teams.Prejoins[0], "it is the only meeting waiting to be joined");
        }

        if (teams.Prejoins.Count > 1)
        {
            return new JoinDecision.Refuse(
                $"{teams.Prejoins.Count} meetings are waiting to be joined and none is focused: " +
                string.Join(", ", teams.Prejoins.Select(p => $"'{p.MeetingName}'")));
        }

        return DecideFromCalendar(teams.Calendar);
    }

    private static JoinDecision ForPrejoin(PrejoinWindow prejoin, string because)
    {
        // Several join controls means several different joins, such as attendee
        // versus presenter. Picking one would be picking the user's role for them.
        if (prejoin.JoinAutomationIds.Count > 1)
        {
            return new JoinDecision.Refuse(
                $"'{prejoin.MeetingName}' offers more than one way to join " +
                $"({string.Join(", ", prejoin.JoinAutomationIds)}); which one is yours to choose");
        }

        return new JoinDecision.Invoke(
            prejoin.Hwnd,
            prejoin.JoinAutomationIds[0],
            $"'{prejoin.MeetingName}': {because}");
    }

    private static JoinDecision DecideFromCalendar(CalendarWindow? calendar)
    {
        if (calendar is null)
        {
            return new JoinDecision.ToastChord("Teams has no calendar window open");
        }

        // A warm calendar reports over a hundred buttons. Near-zero means the tree
        // had not populated, so its join count says nothing and must not be acted on.
        if (calendar.TotalButtons < MinimumPlausibleButtons)
        {
            return new JoinDecision.Refuse(
                $"the calendar reported only {calendar.TotalButtons} controls, too few to trust; " +
                "treating the scan as incomplete rather than acting on it");
        }

        return calendar.JoinableMeetings.Count switch
        {
            0 => new JoinDecision.ToastChord("no meeting on the calendar is joinable"),
            1 => new JoinDecision.InvokeCalendarJoin(calendar.Hwnd, calendar.JoinableMeetings[0]),
            _ => new JoinDecision.FocusThenChord(calendar.Hwnd, calendar.JoinableMeetings),
        };
    }

    /// <summary>
    /// A warm Teams calendar window carries well over a hundred buttons; a cold one
    /// has been observed reporting none at all. Anything below this is a failed scan
    /// wearing the costume of an empty calendar.
    /// </summary>
    internal const int MinimumPlausibleButtons = 10;
}
