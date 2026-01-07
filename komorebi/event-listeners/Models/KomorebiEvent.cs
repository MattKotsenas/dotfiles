using System.Text.Json;

namespace EventListeners.Models;

/// <summary>
/// Represents a Komorebi event message containing the event details and current state.
/// </summary>
public sealed class KomorebiEvent
{
    public KomorebiEventType? Event { get; set; }
    public JsonElement? State { get; set; }
}
