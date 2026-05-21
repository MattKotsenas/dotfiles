using Microsoft.Extensions.Logging;

namespace EventListeners;

/// <summary>
/// Shows/hides the WM overlay when kanata enters/exits the WM layer.
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

        var isWm = e.NewLayer.StartsWith("wm", StringComparison.OrdinalIgnoreCase);

        // Only change on wm↔base transitions, not on sub-layer changes
        if (isWm == _inWmMode) return;
        _inWmMode = isWm;

        if (isWm)
        {
            _logger.LogDebug("WM layer active");
            _overlay.Show();
        }
        else
        {
            _logger.LogDebug("Base layer active");
            _overlay.Hide();
        }
    }
}
