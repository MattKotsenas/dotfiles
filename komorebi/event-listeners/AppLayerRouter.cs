using EventListeners.Generated;
using EventListeners.Models;
using Microsoft.Extensions.Logging;

namespace EventListeners;

/// <summary>
/// Watches komorebi focus events and asks kanata to change its base layer to
/// match the focused app's overlay (or to <see cref="LayerCatalog.BaseDefault"/>
/// when no rule matches).
///
/// Routing rules are plain C# code in <see cref="DefaultRules"/>; add a new rule
/// to support a new app overlay.
///
/// Cache discipline: <c>_lastLayer</c> only updates from kanata's own
/// <c>LayerChange</c> echo (filtered to base-* layers), never optimistically
/// from a sent ChangeLayer. This makes the router self-healing -- if a send
/// silently fails (kanata TCP write error, mid-reconnect), no echo arrives,
/// the cache stays stale, and the next focus event re-sends instead of
/// short-circuiting at a falsely-confirmed guard.
/// </summary>
public sealed class AppLayerRouter : IEventRule
{
    private readonly ILogger<AppLayerRouter> _logger;
    private readonly Lazy<IKanataClient> _kanata;
    private readonly IReadOnlyList<Func<FocusContext, string?>> _rules;
    // volatile: Komorebi and Kanata listener threads both call ProcessEvent.
    // _lastLayer mirrors what kanata reported via LayerChange echo (truth),
    // not what we asked for, so we self-heal if a send silently fails.
    private volatile string? _lastLayer;

    public string Name => "AppLayerRouter";

    public AppLayerRouter(ILogger<AppLayerRouter> logger, Lazy<IKanataClient> kanata)
        : this(logger, kanata, DefaultRules)
    { }

    /// <summary>Test constructor: inject custom routing rules.</summary>
    internal AppLayerRouter(
        ILogger<AppLayerRouter> logger,
        Lazy<IKanataClient> kanata,
        IReadOnlyList<Func<FocusContext, string?>> rules)
    {
        _logger = logger;
        _kanata = kanata;
        _rules = rules;
    }

    /// <summary>
    /// Routing rules. Each rule inspects the focus context and returns a layer
    /// name to switch to, or null to defer to the next rule. Order matters --
    /// list more specific rules before more general ones.
    /// </summary>
    internal static readonly IReadOnlyList<Func<FocusContext, string?>> DefaultRules =
    [
        // Windows Terminal: route to terminal overlay for psmux pane navigation.
        ctx => ctx.Exe == "WindowsTerminal.exe" ? LayerCatalog.BaseTerminal : null,
        // Microsoft Edge: tab management + vimium reset live in the overlay.
        ctx => ctx.Exe == "msedge.exe" ? LayerCatalog.BaseEdge : null,
        // Microsoft Teams (new). One overlay covers both main and in-meeting:
        // meeting-only shortcuts are no-ops outside meetings, which is fine.
        // Detection-by-title isn't reliable since users name meetings freely.
        ctx => ctx.Exe == "ms-teams.exe" ? LayerCatalog.BaseTeams : null,
        // Microsoft CodeFlow code review tool.
        ctx => ctx.Exe == "CodeFlow.exe" ? LayerCatalog.BaseCodeflow : null,
    ];

    public void ProcessEvent(IEvent evt)
    {
        // Track kanata's actual base layer from its LayerChange echoes (which
        // arrive after a successful ChangeLayer write, or any external change).
        // Sub-mode layers (wm-*) are ignored so _lastLayer always reflects the
        // last confirmed *base* state. If a send fails, no echo arrives, the
        // cache stays stale, and the next focus event re-sends -- self-healing.
        if (evt is KanataLayerChangeEvent layerEvt)
        {
            if (layerEvt.NewLayer.StartsWith("base-", StringComparison.Ordinal))
            {
                _lastLayer = layerEvt.NewLayer;
            }
            return;
        }

        if (evt is not KomorebiWindowEvent komorebiEvt) return;
        if (komorebiEvt.State is null) return;

        var focusedHwnd = komorebiEvt.State.Value.GetFocusedHwnd();
        if (focusedHwnd is null) return;

        string? exe = null;
        string? title = null;
        foreach (var window in komorebiEvt.State.Value.EnumerateAllWindows())
        {
            if (window.Hwnd == focusedHwnd.Value)
            {
                exe = window.Exe;
                title = window.Title;
                break;
            }
        }

        var ctx = new FocusContext(exe, title, focusedHwnd.Value);
        var targetLayer = Route(ctx);

        // Don't spam kanata when the confirmed layer already matches.
        if (targetLayer == _lastLayer) return;

        _logger.LogInformation("Focus changed to {Exe} -> ChangeLayer({Layer})", exe, targetLayer);
        // Fire-and-forget. Cache updates only when kanata echoes LayerChange
        // back; that way a failed send leaves the cache stale and we retry
        // on the next focus event instead of getting stuck.
        _ = _kanata.Value.SendChangeLayerAsync(targetLayer);
    }

    /// <summary>Pure function: run the rule chain to resolve a layer for a focus context.</summary>
    internal string Route(FocusContext context)
    {
        foreach (var rule in _rules)
        {
            var result = rule(context);
            if (result is not null) return result;
        }
        return LayerCatalog.BaseDefault;
    }
}

/// <summary>Information about the currently focused window for routing rules.</summary>
public sealed record FocusContext(string? Exe, string? Title, long Hwnd);
