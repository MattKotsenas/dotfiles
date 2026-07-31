namespace EventListeners;

/// <summary>
/// Reads and drives the Teams UI. Implemented over UI Automation; kept behind an
/// interface so the join strategies can be tested without a running Teams.
/// </summary>
internal interface ITeamsSurface
{
    /// <summary>What Teams offers right now. Never throws; a failed scan reads as empty.</summary>
    TeamsSnapshot Capture();

    /// <summary>Invokes a control by exact AutomationId within one window.</summary>
    bool InvokeById(nint hwnd, string automationId);

    /// <summary>
    /// Invokes the calendar join button belonging to <paramref name="meetingName"/>.
    /// Re-resolved at invoke time rather than held from the capture, because the
    /// calendar re-renders and a stale element would throw or click the wrong row.
    /// </summary>
    bool InvokeCalendarJoin(nint hwnd, string meetingName);
}
