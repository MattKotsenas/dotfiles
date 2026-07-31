namespace EventListeners;

/// <summary>The outcome of looking for a single control across Teams' windows.</summary>
internal enum ControlSearch
{
    /// <summary>Found exactly one, and pressed it.</summary>
    Invoked,

    /// <summary>Read Teams successfully; the control is not there.</summary>
    NotFound,

    /// <summary>Several windows offer it, so which one the user meant is unknown.</summary>
    Ambiguous,

    /// <summary>The read failed. Says nothing about whether the control exists.</summary>
    Failed,
}

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
    /// Presses a control by exact AutomationId, but only if exactly one Teams window
    /// offers it. Used where the window is defined by the control rather than the
    /// other way round: a call window is simply the one with a hangup button.
    ///
    /// Refuses when several windows match, because Teams can hold one call while
    /// another is active and enumeration order says nothing about which the user
    /// means.
    /// </summary>
    ControlSearch InvokeUniqueInAnyWindow(string automationId);

    /// <summary>
    /// Invokes the calendar join button belonging to <paramref name="meetingName"/>.
    /// Re-resolved at invoke time rather than held from the capture, because the
    /// calendar re-renders and a stale element would throw or click the wrong row.
    /// </summary>
    bool InvokeCalendarJoin(nint hwnd, string meetingName);
}
