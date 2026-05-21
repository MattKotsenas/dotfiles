using Microsoft.Extensions.Logging;

namespace EventListeners;

/// <summary>
/// Shifts komorebi border colors when kanata enters/exits the WM layer.
/// </summary>
public sealed class LayerIndicatorRule : IEventRule
{
    private readonly ILogger<LayerIndicatorRule> _logger;
    private readonly IWindowAction _windowAction;

    public string Name => "LayerIndicatorRule";

    public LayerIndicatorRule(ILogger<LayerIndicatorRule> logger, IWindowAction windowAction)
    {
        _logger = logger;
        _windowAction = windowAction;
    }

    public void ProcessEvent(IEvent evt)
    {
        if (evt is not KanataLayerChangeEvent e) return;

        if (e.NewLayer.StartsWith("wm", StringComparison.OrdinalIgnoreCase))
        {
            _logger.LogDebug("WM layer active, setting saturated borders");
            _windowAction.SetBorderColour("single",    50, 210, 248);
            _windowAction.SetBorderColour("stack",    180, 120, 250);
            _windowAction.SetBorderColour("unfocused", 80,  85, 110);
        }
        else
        {
            _logger.LogDebug("Base layer active, reverting borders");
            _windowAction.SetBorderColour("single",   116, 199, 236);
            _windowAction.SetBorderColour("stack",    203, 166, 247);
            _windowAction.SetBorderColour("unfocused", 69,  71,  90);
        }
    }
}
