namespace EventListeners.Models;

/// <summary>
/// Emitted when kanata switches to a different keyboard layer.
/// </summary>
public sealed record KanataLayerChangeEvent(string NewLayer) : IEvent;
