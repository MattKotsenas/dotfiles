using System.Diagnostics;
using Interop.UIAutomationClient;
using Microsoft.Extensions.Logging;

namespace EventListeners;

/// <summary>
/// Reads the Teams UI through UI Automation.
///
/// Every lookup is scoped to one top-level Teams window, and every AutomationId is
/// matched exactly: Teams ships neighbours like <c>hangup-button-more-options</c>
/// that a prefix match would hit instead.
///
/// Works with Teams in the background, so nothing here steals focus.
/// </summary>
internal sealed class TeamsUiaSurface(ILogger<TeamsUiaSurface> logger) : ITeamsSurface
{
    private const string TeamsProcessName = "ms-teams";
    private const string CalendarJoinButtonName = "Join Teams meeting";

    private static readonly string[] PrejoinJoinIds =
    [
        "prejoin-join-button",
        "prejoin-join-event-as-attendee-button",
        "join-broadcast-as-attendee-button",
        "prejoin-join-button-event-etm",
        "prejoin-join-button-broadcast-etm",
    ];

    private readonly IUIAutomation _automation = new CUIAutomation();

    public TeamsSnapshot Capture()
    {
        try
        {
            var prejoins = new List<PrejoinWindow>();
            CalendarWindow? calendar = null;
            var complete = true;

            foreach (var (element, hwnd, title) in TeamsWindows())
            {
                if (title.StartsWith(JoinStrategy.PrejoinTitlePrefix, StringComparison.Ordinal))
                {
                    var joins = FindPrejoinJoins(element);
                    if (joins.Count > 0)
                    {
                        prejoins.Add(new PrejoinWindow(hwnd, MeetingNameFrom(title), joins));
                    }
                    else
                    {
                        // The title says a meeting is waiting, so a join control exists
                        // and we simply could not see it: still rendering, or an id this
                        // build uses that we do not know. Either way the reading is
                        // partial, and "nothing to join" would be a lie.
                        logger.LogDebug("'{Title}' looks like a prejoin but offers no join control", title);
                        complete = false;
                    }
                }
                else if (title.StartsWith(JoinStrategy.CalendarTitlePrefix, StringComparison.Ordinal))
                {
                    calendar = CaptureCalendar(element, hwnd);
                }
            }

            return new TeamsSnapshot(prejoins, calendar, complete);
        }
        catch (Exception ex)
        {
            // A window torn down mid-scan throws. What was on screen is now unknown,
            // which is different from knowing there was nothing.
            logger.LogWarning(ex, "Reading the Teams UI failed");
            return TeamsSnapshot.Failed;
        }
    }

    public bool InvokeById(nint hwnd, string automationId)
    {
        try
        {
            var window = WindowElement(hwnd);
            var element = window?.FindFirst(TreeScope.TreeScope_Descendants, ByAutomationId(automationId));
            return InvokeElement(element, automationId);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Invoking {AutomationId} failed", automationId);
            return false;
        }
    }

    public ControlSearch InvokeUniqueInAnyWindow(string automationId)
    {
        try
        {
            var matches = new List<(IUIAutomationElement Element, string Title)>();
            foreach (var (element, _, title) in TeamsWindows())
            {
                var found = element.FindFirst(
                    TreeScope.TreeScope_Descendants, ByAutomationId(automationId));
                if (found is not null)
                {
                    matches.Add((found, title));
                }
            }

            if (matches.Count == 0)
            {
                return ControlSearch.NotFound;
            }

            // Teams shows a minimized call in a second, smaller call-monitor window,
            // so two matches routinely mean one call in two windows. Both hang up the
            // same call, so only distinct meetings are genuinely ambiguous.
            var meetings = matches.Select(m => m.Title).Distinct(StringComparer.Ordinal).ToList();
            if (meetings.Count > 1)
            {
                logger.LogInformation(
                    "{Count} different Teams calls offer {AutomationId}: {Meetings}",
                    meetings.Count, automationId, string.Join(", ", meetings));
                return ControlSearch.Ambiguous;
            }

            return InvokeElement(matches[0].Element, automationId)
                ? ControlSearch.Invoked
                : ControlSearch.Failed;
        }
        catch (Exception ex)
        {
            // A window torn down mid-scan throws. Whether the control was there is
            // now unknown, which is not the same as knowing it was not.
            logger.LogWarning(ex, "Looking for {AutomationId} failed", automationId);
            return ControlSearch.Failed;
        }
    }

    public bool InvokeCalendarJoin(nint hwnd, string meetingName)
    {
        try
        {
            var window = WindowElement(hwnd);
            if (window is null) return false;

            var condition = _automation.CreateAndCondition(
                ButtonCondition(),
                _automation.CreatePropertyCondition(
                    UIA_PropertyIds.UIA_NamePropertyId, CalendarJoinButtonName));
            var found = window.FindAll(TreeScope.TreeScope_Descendants, condition);

            var walker = _automation.ControlViewWalker;
            for (var i = 0; i < (found?.Length ?? 0); i++)
            {
                var join = found!.GetElement(i);
                if (walker.GetParentElement(join)?.CurrentName == meetingName)
                {
                    return InvokeElement(join, $"join for '{meetingName}'");
                }
            }

            logger.LogWarning("'{Meeting}' no longer offers a join button", meetingName);
            return false;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Invoking the calendar join for '{Meeting}' failed", meetingName);
            return false;
        }
    }

    /// <summary>
    /// Reads the calendar from a single traversal, so the plausibility count and the
    /// join buttons describe the same moment. Two traversals could pair a healthy
    /// count with a join scan taken while Teams re-rendered, and that combination
    /// passes the guard while being exactly what the guard exists to catch.
    /// </summary>
    private CalendarWindow CaptureCalendar(IUIAutomationElement window, nint hwnd)
    {
        var buttons = window.FindAll(TreeScope.TreeScope_Descendants, ButtonCondition());
        if (buttons is null)
        {
            return new CalendarWindow(hwnd, 0, []);
        }

        var walker = _automation.ControlViewWalker;
        var meetings = new List<string>();

        for (var i = 0; i < buttons.Length; i++)
        {
            var button = buttons.GetElement(i);
            if (button.CurrentName != CalendarJoinButtonName) continue;

            // Join with an ID is a nearby button whose name also contains "Join";
            // it opens a dialog rather than joining, and exposes no invoke pattern.
            if (!SupportsInvoke(button)) continue;

            var owner = walker.GetParentElement(button)?.CurrentName;
            if (!string.IsNullOrEmpty(owner))
            {
                meetings.Add(owner);
            }
        }

        return new CalendarWindow(hwnd, buttons.Length, meetings);
    }

    /// <summary>Every join control the window offers, in the order they are known.</summary>
    private List<string> FindPrejoinJoins(IUIAutomationElement window)
    {
        var found = new List<string>();
        foreach (var id in PrejoinJoinIds)
        {
            var element = window.FindFirst(TreeScope.TreeScope_Descendants, ByAutomationId(id));
            if (element is not null && SupportsInvoke(element))
            {
                found.Add(id);
            }
        }

        return found;
    }

    private IEnumerable<(IUIAutomationElement Element, nint Hwnd, string Title)> TeamsWindows()
    {
        var teamsPids = Process.GetProcessesByName(TeamsProcessName).Select(p => p.Id).ToHashSet();
        if (teamsPids.Count == 0) yield break;

        var walker = _automation.ControlViewWalker;
        var child = walker.GetFirstChildElement(_automation.GetRootElement());

        while (child is not null)
        {
            var current = child;
            child = walker.GetNextSiblingElement(child);

            string title;
            nint hwnd;
            try
            {
                if (!teamsPids.Contains(current.CurrentProcessId)) continue;
                title = current.CurrentName ?? string.Empty;
                hwnd = current.CurrentNativeWindowHandle;
            }
            catch (Exception ex)
            {
                logger.LogDebug(ex, "Skipping a window that vanished mid-enumeration");
                continue;
            }

            yield return (current, hwnd, title);
        }
    }

    private bool InvokeElement(IUIAutomationElement? element, string description)
    {
        if (element is null)
        {
            logger.LogWarning("Could not find {Description}", description);
            return false;
        }

        if (element.GetCurrentPattern(UIA_PatternIds.UIA_InvokePatternId)
            is not IUIAutomationInvokePattern pattern)
        {
            logger.LogWarning("{Description} cannot be invoked", description);
            return false;
        }

        pattern.Invoke();
        return true;
    }

    private bool SupportsInvoke(IUIAutomationElement element) =>
        element.GetCurrentPattern(UIA_PatternIds.UIA_InvokePatternId) is IUIAutomationInvokePattern;

    private IUIAutomationElement? WindowElement(nint hwnd) =>
        TeamsWindows().FirstOrDefault(w => w.Hwnd == hwnd).Element;

    private IUIAutomationCondition ByAutomationId(string automationId) =>
        _automation.CreatePropertyCondition(UIA_PropertyIds.UIA_AutomationIdPropertyId, automationId);

    private IUIAutomationCondition ButtonCondition() =>
        _automation.CreatePropertyCondition(
            UIA_PropertyIds.UIA_ControlTypePropertyId, UIA_ControlTypeIds.UIA_ButtonControlTypeId);

    /// <summary>Pulls the meeting out of a <c>Meeting join | name | Microsoft Teams</c> title.</summary>
    internal static string MeetingNameFrom(string windowTitle)
    {
        var parts = windowTitle.Split('|', StringSplitOptions.TrimEntries);
        return parts.Length >= 2 ? parts[1] : windowTitle;
    }
}
