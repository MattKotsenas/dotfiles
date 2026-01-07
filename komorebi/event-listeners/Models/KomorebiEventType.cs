using System.Text.Json;

namespace EventListeners.Models;

/// <summary>
/// Represents the event type information in a Komorebi event.
/// The content can be either a string, an array, or an object depending on the event type.
/// </summary>
public sealed class KomorebiEventType
{
    public string? Type { get; set; }
    public JsonElement? Content { get; set; }
}
