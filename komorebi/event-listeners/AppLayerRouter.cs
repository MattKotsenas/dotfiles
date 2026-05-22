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
/// to support a new app overlay (Phases 4+). Until then the chain is empty and
/// every focus change resolves to BaseDefault.
/// </summary>
public sealed class AppLayerRouter : IEventRule
{
    private readonly ILogger<AppLayerRouter> _logger;
    private readonly Lazy<IKanataClient> _kanata;
    private readonly IReadOnlyList<Func<FocusContext, string?>> _rules;
    private string? _lastLayer;
    private string? _lastExe;

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
    ];

    public void ProcessEvent(IEvent evt)
    {
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

        // Only act on actual exe transitions to avoid spamming kanata.
        if (exe == _lastExe) return;
        _lastExe = exe;

        var ctx = new FocusContext(exe, title, focusedHwnd.Value);
        var targetLayer = Route(ctx);

        if (targetLayer == _lastLayer) return;
        _lastLayer = targetLayer;

        _logger.LogInformation("Focus changed to {Exe} -> ChangeLayer({Layer})", exe, targetLayer);
        // Fire-and-forget; client logs warnings on failure.
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
