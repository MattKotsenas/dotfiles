using Microsoft.Extensions.Logging;
using EventListeners.Models;

namespace EventListeners;

/// <summary>
/// Shows/hides the WM overlay when kanata enters/exits a WM-mode layer, and
/// updates the label as the active mode/sub-mode changes.
/// </summary>
public sealed class LayerIndicatorRule : IEventRule
{
    private readonly ILogger<LayerIndicatorRule> _logger;
    private readonly IWmOverlay _overlay;
    private bool _inWmMode;

    public string Name => "LayerIndicatorRule";

    public LayerIndicatorRule(
        ILogger<LayerIndicatorRule> logger,
        IWmOverlay overlay)
    {
        _logger = logger;
        _overlay = overlay;
    }

    public void ProcessEvent(IEvent evt)
    {
        if (evt is not KanataLayerChangeEvent e) return;

        var label = LabelForLayer(e.NewLayer);

        if (label is null)
        {
            // base-* and other non-wm layers hide the overlay
            if (_inWmMode)
            {
                _logger.LogDebug("Exiting WM mode (layer={Layer})", e.NewLayer);
                _overlay.Hide();
                _inWmMode = false;
            }
            return;
        }

        // Always update the label on a wm-* transition; this covers sub-mode
        // changes within WM mode (e.g., wm-focus -> wm-stack).
        _logger.LogDebug("WM mode label: {Label} (layer={Layer})", label, e.NewLayer);
        _overlay.Show(label);
        _inWmMode = true;
    }

    /// <summary>
    /// Maps a kanata layer name to the label shown in the overlay, or null if
    /// the layer is not a WM-mode layer (i.e. <c>base-*</c>).
    ///
    /// Labels are ALL CAPS for visual consistency across modes, prefixed with
    /// a context emoji. One-shot vs toggle is distinguished with a trailing
    /// " *" (sticky indicator).
    /// </summary>
    internal static string? LabelForLayer(string layerName)
    {
        // Non-WM layers (typing layers): no overlay
        if (!WmLayer.IsWmMode(layerName))
        {
            return null;
        }

        // "wm" alone is the default one-shot WM mode
        if (layerName.Equals("wm", StringComparison.OrdinalIgnoreCase))
        {
            return Decorate("WM", toggle: false);
        }

        // Strip "wm-" prefix
        var body = layerName[3..];

        // "wm-toggle" is sticky default WM mode (no sub-mode/overlay name)
        if (body.Equals("toggle", StringComparison.OrdinalIgnoreCase))
        {
            return Decorate("WM", toggle: true);
        }

        // Detect sticky variant of a sub-mode or overlay
        var toggle = body.EndsWith("-toggle", StringComparison.OrdinalIgnoreCase);
        if (toggle) body = body[..^"-toggle".Length];

        // Pick a label per mode/overlay -- terminal is the only one short enough
        // to abbreviate.
        var (name, _) = body switch
        {
            "terminal"  => ("TERM",      ""),
            "edge"      => ("EDGE",      ""),
            "teams"     => ("TEAMS",     ""),
            "codeflow"  => ("REVIEW",    ""),
            "focus"     => ("FOCUS",     ""),
            "move"      => ("MOVE",      ""),
            "stack"     => ("STACK",     ""),
            "resize"    => ("RESIZE",    ""),
            "admin"     => ("ADMIN",     ""),
            "workspace" => ("WORKSPACE", ""),
            _ => (body.ToUpperInvariant(), ""),
        };

        return Decorate(name, toggle);
    }

    private static string Decorate(string name, bool toggle)
    {
        var emoji = EmojiForLabel(name);
        var core = $"{emoji} {name}";
        return toggle ? core + " \u2022" : core;
    }

    /// <summary>Emoji prefix per label. Picked for compact rendering at small font sizes.</summary>
    private static string EmojiForLabel(string name) => name switch
    {
        "WM"        => "\U0001FA9F",  // 🪟 window
        "TERM"      => "\U0001F4BB",  // 💻 laptop
        "EDGE"      => "\U0001F310",  // 🌐 globe with meridians
        "TEAMS"     => "\U0001F4AC",  // 💬 speech bubble
        "REVIEW"    => "\U0001F50D",  // 🔍 magnifying glass
        "FOCUS"     => "\U0001F3AF",  // 🎯 target
        "MOVE"      => "\U0001F4E6",  // 📦 package
        "STACK"     => "\U0001F4DA",  // 📚 books
        "RESIZE"    => "\U0001F4D0",  // 📐 triangular ruler
        "ADMIN"     => "\U0001F527",  // 🔧 wrench
        "WORKSPACE" => "\U0001F5C2",  // 🗂 card index
        _ => "\u2328",                // ⌨ keyboard (fallback)
    };
}
