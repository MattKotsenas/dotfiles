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
    /// One-shot vs toggle is distinguished with a trailing " *" (sticky indicator).
    /// </summary>
    internal static string? LabelForLayer(string layerName)
    {
        // Non-WM layers (typing layers): no overlay
        if (!layerName.Equals("wm", StringComparison.OrdinalIgnoreCase)
            && !layerName.StartsWith("wm-", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        // "wm" alone is the default one-shot WM mode
        if (layerName.Equals("wm", StringComparison.OrdinalIgnoreCase))
        {
            return "WM";
        }

        // Strip "wm-" prefix
        var body = layerName[3..];

        // "wm-toggle" is sticky default WM mode (no sub-mode/overlay name)
        if (body.Equals("toggle", StringComparison.OrdinalIgnoreCase))
        {
            return "WM \u2022";
        }

        // Detect sticky variant of a sub-mode or overlay
        var toggle = body.EndsWith("-toggle", StringComparison.OrdinalIgnoreCase);
        if (toggle) body = body[..^"-toggle".Length];

        var label = body switch
        {
            "terminal" => "Term",
            "workspace" => "Workspace",
            "focus" => "Focus",
            "move" => "Move",
            "stack" => "Stack",
            "resize" => "Resize",
            "assemble" => "Assemble",
            _ => Capitalize(body),
        };

        return toggle ? label + " \u2022" : label;
    }

    private static string Capitalize(string s)
    {
        if (string.IsNullOrEmpty(s)) return s;
        return char.ToUpperInvariant(s[0]) + s[1..];
    }
}
