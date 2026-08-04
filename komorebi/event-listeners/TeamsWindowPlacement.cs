using System.Text.Json;
using EventListeners.Models;
using Microsoft.Extensions.Logging;

namespace EventListeners;

/// <summary>
/// Puts each newly shown Teams window in the external monitor's largest tile, once.
///
/// <para>
/// Teams opens call and chat windows on whichever monitor Windows picks. This drops
/// one where the user is going to work with it: the largest tile of the external
/// monitor when that monitor is attached, or of the monitor it opened on when it is
/// not. Each window is placed at most once, so one the user moves afterwards stays
/// moved.
/// </para>
/// </summary>
public sealed class TeamsWindowPlacement : IEventRule
{
    private const string TeamsExe = "ms-teams.exe";

    /// <summary>
    /// The monitor new Teams windows belong on while it is attached. When it is not,
    /// the window is promoted where it stands.
    /// </summary>
    internal const int ExternalMonitorIndex = 1;

    /// <summary>
    /// How long after a window appears its placement stays available. Teams can open
    /// a window behind everything else, and one first focused hours later is not the
    /// new window this places.
    /// </summary>
    internal static readonly TimeSpan PlacementWindow = TimeSpan.FromSeconds(10);

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true
    };

    private readonly ILogger<TeamsWindowPlacement> _logger;
    private readonly IWindowAction _windowAction;
    private readonly IMonitorTopology _topology;
    private readonly TimeProvider _time;

    // Komorebi events arrive on the pipe reader thread, but IEventRule is also called
    // from the kanata reader thread, so this state is guarded.
    private readonly object _gate = new();

    // Handles that must not start another placement, whether this rule placed them,
    // refused to, or found them already open at startup.
    private readonly HashSet<long> _knownWindows = [];
    // Witnessed a Show, still waiting for the focus that lets us act, and the reading
    // of the monotonic clock when it appeared.
    private readonly Dictionary<long, long> _awaitingPlacement = [];

    private bool _seeded;

    // komorebic acts on whatever holds focus, so placements run one at a time; a
    // window that arrives during one forfeits its attempt rather than queueing behind
    // focus that has since moved on.
    private bool _placing;

    /// <summary>
    /// Test seam: the placement kicked off by the most recent focus event, so a test
    /// can await it instead of racing a fire-and-forget task on a timeout.
    /// </summary>
    internal Task? LastPlacement { get; private set; }

    public TeamsWindowPlacement(
        ILogger<TeamsWindowPlacement> logger,
        IWindowAction windowAction,
        IMonitorTopology topology,
        TimeProvider time)
    {
        _logger = logger;
        _windowAction = windowAction;
        _topology = topology;
        _time = time;
    }

    public string Name => "TeamsWindowPlacement";

    public void ProcessEvent(IEvent evt)
    {
        if (evt is not KomorebiWindowEvent e) return;

        SeedAlreadyOpenWindows(e.State);

        // Only the three events below carry a window. komorebi sends plenty that
        // do not, and parsing those as one turns every workspace change into a
        // logged failure.
        if (e.EventType is not ("Show" or "FocusChange" or "Destroy")) return;

        var window = ParseWindow(e.Content);
        if (window is null) return;

        switch (e.EventType)
        {
            case "Show" when IsTeams(window.Exe):
                OnShow(window);
                return;
            case "FocusChange":
                OnFocusChange(window, e.State);
                return;
            case "Destroy":
                Forget(window.Hwnd);
                return;
            default:
                return;
        }
    }

    /// <summary>
    /// Records every Teams window komorebi already knows about, so only windows that
    /// appear from here on are candidates. komorebi reports a window that opened and
    /// one that was unminimised alike, as Show, so without this a long-open window
    /// restored from the tray would be relocated.
    ///
    /// <para>
    /// Runs off the first event carrying state, so a window that opened in that very
    /// event is seeded too and never placed.
    /// </para>
    /// </summary>
    private void SeedAlreadyOpenWindows(JsonElement? state)
    {
        if (state is not { } value) return;

        lock (_gate)
        {
            if (_seeded) return;
            _seeded = true;

            foreach (var window in value.EnumerateAllWindows())
            {
                if (IsTeams(window.Exe))
                {
                    _knownWindows.Add(window.Hwnd);
                }
            }
        }
    }

    private void OnShow(KomorebiWindow window)
    {
        lock (_gate)
        {
            if (!_knownWindows.Add(window.Hwnd)) return;
            _awaitingPlacement[window.Hwnd] = _time.GetTimestamp();
        }

        _logger.LogDebug("New Teams window {Hwnd}; awaiting focus to place it", window.Hwnd);
    }

    private void OnFocusChange(KomorebiWindow window, JsonElement? state)
    {
        lock (_gate)
        {
            // Removed whether or not placement follows: one attempt per window.
            if (!_awaitingPlacement.Remove(window.Hwnd, out var shownAt)) return;

            if (_time.GetElapsedTime(shownAt) > PlacementWindow)
            {
                _logger.LogInformation(
                    "Teams window {Hwnd} was focused too long after it appeared; leaving it alone",
                    window.Hwnd);
                return;
            }

            if (_placing)
            {
                _logger.LogInformation(
                    "Another placement is in flight; leaving Teams window {Hwnd} alone",
                    window.Hwnd);
                return;
            }

            if (state is null)
            {
                _logger.LogWarning("No state on the focus event for Teams window {Hwnd}; not placing it", window.Hwnd);
                return;
            }

            // komorebic moves the focused window, so a disagreement here means the
            // move would land on somebody else's window. This is also what keeps the
            // Teams screen-sharing toolbar out: it is a tool window komorebi never
            // manages, so it can never be the focused managed window.
            var focused = state.Value.GetFocusedHwnd();
            if (focused != window.Hwnd)
            {
                _logger.LogInformation(
                    "Teams window {Hwnd} is not the focused managed window ({Focused}); not placing it",
                    window.Hwnd, focused);
                return;
            }

            _placing = true;
        }

        LastPlacement = PlaceAsync(window.Hwnd, ResolveDestination(state!.Value));
    }

    /// <summary>
    /// Windows reuses handles, so a handle that dies has to lose its history or the
    /// next window given it is mistaken for one already dealt with.
    /// </summary>
    private void Forget(long hwnd)
    {
        lock (_gate)
        {
            _knownWindows.Remove(hwnd);
            _awaitingPlacement.Remove(hwnd);
        }
    }

    /// <summary>
    /// The monitor index to move to, or null to leave the window on its current
    /// monitor. Null covers komorebi having no such monitor, remembering one that is
    /// no longer attached, and listing it with bounds another monitor also claims.
    /// </summary>
    internal int? ResolveDestination(JsonElement state)
    {
        var monitors = state.GetMonitorBounds();
        if (ExternalMonitorIndex >= monitors.Count ||
            monitors[ExternalMonitorIndex] is not { } target)
        {
            return null;
        }

        // Bounds are the only handle on whether a listed monitor is real, so bounds
        // that two monitors share identify neither. Refuse rather than guess.
        if (monitors.Count(m => m == target) > 1)
        {
            _logger.LogInformation(
                "Monitor {Index} shares its bounds with another komorebi lists; promoting in place",
                ExternalMonitorIndex);
            return null;
        }

        return _topology.IsAttached(target) ? ExternalMonitorIndex : null;
    }

    private async Task PlaceAsync(long hwnd, int? monitorIndex)
    {
        try
        {
            if (monitorIndex is int index)
            {
                if (!StillHoldsForeground(hwnd, "move")) return;

                _logger.LogInformation("Placing Teams window {Hwnd} on monitor {Monitor}", hwnd, index);

                if (!await _windowAction.MoveToMonitorAsync(index))
                {
                    // Promoting now would pull whatever holds focus into the largest
                    // tile of the monitor the window failed to leave.
                    _logger.LogWarning(
                        "Move of Teams window {Hwnd} to monitor {Monitor} failed; not promoting",
                        hwnd, index);
                    return;
                }
            }
            else
            {
                _logger.LogInformation("Placing Teams window {Hwnd} on its current monitor", hwnd);
            }

            if (!StillHoldsForeground(hwnd, "promote")) return;

            // The move appends to the end of the target workspace, which on a BSP
            // layout is the smallest tile; promote is what lands it in the largest.
            await _windowAction.PromoteAsync();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to place Teams window {Hwnd}", hwnd);
        }
        finally
        {
            lock (_gate)
            {
                _placing = false;
            }
        }
    }

    /// <summary>
    /// Each komorebic command acts on the foreground window at the moment it runs, so
    /// the window has to be rechecked before every one. Abandoning a half-placed
    /// window leaves it in a worse tile; acting anyway moves somebody else's.
    /// </summary>
    private bool StillHoldsForeground(long hwnd, string next)
    {
        var foreground = _windowAction.GetForegroundWindow();
        if (foreground == hwnd) return true;

        _logger.LogInformation(
            "Teams window {Hwnd} lost the foreground to {Foreground} before {Next}; stopping",
            hwnd, foreground, next);
        return false;
    }

    private static bool IsTeams(string? exe) =>
        string.Equals(exe, TeamsExe, StringComparison.OrdinalIgnoreCase);

    private KomorebiWindow? ParseWindow(JsonElement? content)
    {
        // Window events carry a [reason, window] tuple, e.g.
        // ["ObjectShow", { hwnd, title, exe, class, rect }].
        if (content is not { } value ||
            value.ValueKind != JsonValueKind.Array ||
            value.GetArrayLength() < 2)
        {
            return null;
        }

        try
        {
            return value[1].Deserialize<KomorebiWindow>(JsonOptions);
        }
        catch (JsonException ex)
        {
            _logger.LogWarning(ex, "Failed to parse window content in a window event");
            return null;
        }
    }
}
