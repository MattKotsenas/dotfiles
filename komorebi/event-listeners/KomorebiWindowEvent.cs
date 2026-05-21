using System.Text.Json;

namespace EventListeners;

/// <summary>
/// A Komorebi event received from the named pipe subscription.
/// </summary>
public sealed record KomorebiWindowEvent(
    string EventType,
    JsonElement? Content,
    JsonElement? State) : IEvent;
