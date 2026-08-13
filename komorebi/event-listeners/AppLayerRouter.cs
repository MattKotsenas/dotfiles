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
/// <para>
/// Cache discipline and deferred restore: the router tracks two pieces of state
/// behind <see cref="_stateLock"/>:
/// <list type="bullet">
///   <item><c>_currentLayer</c> — whatever kanata last echoed (any layer,
///     including <c>wm-*</c> sub-modes and toggles).</item>
///   <item><c>_desiredBaseLayer</c> — the base layer that should be active
///     when kanata returns to a base context, based on the latest focus event.</item>
/// </list>
/// </para>
///
/// <para>
/// Decisions:
/// <list type="bullet">
///   <item>On a focus event, we update <c>_desiredBaseLayer</c>. If kanata is
///     currently in a base layer (or its current layer is unknown), we send
///     <c>ChangeLayer(target)</c> immediately. If kanata is in a <c>wm-*</c>
///     layer (the user is mid-WM-mode), we DEFER — sending a base ChangeLayer
///     would kick the user out of WM mode.</item>
///   <item>On a kanata <c>LayerChange</c> echo for a base layer that doesn't
///     match <c>_desiredBaseLayer</c>, we send a corrective ChangeLayer. This
///     handles two cases: (a) the user exits a shared sub-mode toggle that
///     unconditionally exits to <c>base-default</c> regardless of overlay
///     context; (b) deferred focus changes accumulated during WM mode.</item>
/// </list>
/// </para>
///
/// <para>
/// Self-healing: if a send fails silently (TCP write error mid-reconnect), no
/// echo arrives, <c>_currentLayer</c> stays stale, and the next focus event
/// re-evaluates and re-sends.
/// </para>
/// </summary>
public sealed class AppLayerRouter : IEventRule
{
    private readonly ILogger<AppLayerRouter> _logger;
    private readonly Lazy<IKanataClient> _kanata;
    private readonly IReadOnlyList<Func<FocusContext, string?>> _rules;
    // Guards _currentLayer + _desiredBaseLayer atomic transitions. Two background
    // threads (Komorebi pipe listener, Kanata TCP listener) both call ProcessEvent;
    // the lock keeps "compare current vs desired then decide to send" race-free.
    // QueueChangeLayer is nonblocking and runs inside the lock, so event order
    // and queued layer order share one linearization point. The TCP service
    // preserves that order and performs I/O asynchronously.
    private readonly object _stateLock = new();
    private string? _currentLayer;
    private string? _desiredBaseLayer;
    private bool _pointerActive;
    private bool _awaitingKanataLayer;

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
        if (evt is KanataConnectedEvent)
        {
            lock (_stateLock)
            {
                _currentLayer = null;
                _pointerActive = false;
                _awaitingKanataLayer = true;
            }
            return;
        }

        if (evt is KanataLayerChangeEvent layerEvt)
        {
            HandleLayerChange(layerEvt.NewLayer);
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
        HandleFocusChange(ctx);
    }

    private void HandleFocusChange(FocusContext ctx)
    {
        var target = Route(ctx);
        string? toSend;
        bool deferred;
        bool awaitingKanataLayer;

        lock (_stateLock)
        {
            _desiredBaseLayer = target;
            var current = _currentLayer;

            if (_awaitingKanataLayer)
            {
                awaitingKanataLayer = true;
                deferred = false;
                toSend = null;
            }
            else if (_pointerActive)
            {
                awaitingKanataLayer = false;
                deferred = false;
                var pointerTarget = LayerCatalog.PointerForBase(target);
                toSend = current == pointerTarget ? null : pointerTarget;
            }
            else if (current is not null
                && LayerCatalog.IsPointerDepartureLayer(current))
            {
                awaitingKanataLayer = false;
                deferred = false;
                toSend = target;
            }
            // Defer when kanata is mid-WM-mode (any non-base-* layer). Sending
            // a base ChangeLayer here would yank the user out of their active
            // wm-focus-toggle / wm-stack-toggle / etc.
            else if (current is not null && !IsBaseLayer(current))
            {
                awaitingKanataLayer = false;
                deferred = true;
                toSend = null;
            }
            // current == null on startup before any echo. Allow the send so
            // the initial focus context routes; if kanata happens to be in WM
            // mode at startup, the next user CAP press will recover.
            else if (current == target)
            {
                awaitingKanataLayer = false;
                deferred = false;
                toSend = null;
            }
            else
            {
                awaitingKanataLayer = false;
                deferred = false;
                toSend = target;
            }

            if (toSend is not null)
            {
                _kanata.Value.QueueChangeLayer(toSend);
            }
        }

        if (awaitingKanataLayer)
        {
            _logger.LogDebug(
                "Focus changed to {Exe}: waiting for kanata's current layer",
                ctx.Exe);
            return;
        }

        if (deferred)
        {
            _logger.LogDebug(
                "Focus changed to {Exe}: deferring ChangeLayer({Layer}) (kanata is in WM mode)",
                ctx.Exe, target);
            return;
        }

        if (toSend is null) return;

        _logger.LogInformation("Focus changed to {Exe} -> ChangeLayer({Layer})", ctx.Exe, toSend);
    }

    private void HandleLayerChange(string newLayer)
    {
        string? toSend = null;
        string? virtualKey = null;

        lock (_stateLock)
        {
            _currentLayer = newLayer;
            _awaitingKanataLayer = false;

            if (LayerCatalog.IsPointerLayer(newLayer))
            {
                virtualKey = LayerCatalog.VirtualKeyPointerIndicatorOn;
                _pointerActive = true;
                if (_desiredBaseLayer is not null)
                {
                    var target = LayerCatalog.PointerForBase(
                        _desiredBaseLayer);
                    if (newLayer != target)
                    {
                        toSend = target;
                    }
                }
            }
            else if (LayerCatalog.IsPointerDepartureLayer(newLayer))
            {
                virtualKey = PointerDepartureVirtualKey(newLayer);
                _pointerActive = false;
                toSend = _desiredBaseLayer;
            }
            else if (_pointerActive)
            {
                toSend = LayerCatalog.PointerForBase(
                    _desiredBaseLayer ?? LayerCatalog.BaseDefault);
            }
            // Corrective restore: any time kanata lands on a base layer that
            // doesn't match the desired one, push the desired. This recovers
            // from (a) shared sub-mode toggles whose CAPS exits to base-default
            // regardless of overlay context, and (b) deferred focus changes
            // that accumulated during WM mode.
            else if (IsBaseLayer(newLayer)
                && _desiredBaseLayer is not null
                && _desiredBaseLayer != newLayer)
            {
                toSend = _desiredBaseLayer;
            }

            if (virtualKey is not null)
            {
                _kanata.Value.QueueVirtualKey(virtualKey);
            }

            if (toSend is not null)
            {
                _kanata.Value.QueueChangeLayer(toSend);
            }
        }

        if (toSend is null) return;

        _logger.LogInformation(
            "Layer echo {Echo} -> ChangeLayer({Layer})",
            newLayer, toSend);
    }

    private static bool IsBaseLayer(string layerName) =>
        layerName.StartsWith("base-", StringComparison.Ordinal);

    private static string PointerDepartureVirtualKey(string layerName) =>
        layerName switch
        {
            var layer when LayerCatalog.IsPointerExitLayer(layer) =>
                LayerCatalog.VirtualKeyPointerIndicatorOff,
            var layer when LayerCatalog.IsPointerUiHintLayer(layer) =>
                LayerCatalog.VirtualKeyPointerHintUi,
            var layer when LayerCatalog.IsPointerGridHintLayer(layer) =>
                LayerCatalog.VirtualKeyPointerHintGrid,
            _ => throw new ArgumentOutOfRangeException(
                nameof(layerName),
                layerName,
                "Layer is not a pointer departure."),
        };

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
