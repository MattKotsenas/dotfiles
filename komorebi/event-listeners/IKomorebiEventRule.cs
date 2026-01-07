using System.Text.Json;

namespace EventListeners;

/// <summary>
/// Interface for rules that process Komorebi events.
/// </summary>
public interface IKomorebiEventRule
{
    /// <summary>
    /// Display name for logging purposes.
    /// </summary>
    string Name { get; }

    /// <summary>
    /// Process an event received from Komorebi.
    /// </summary>
    /// <param name="eventType">The event type (e.g., "Show", "TitleUpdate", "FocusChange")</param>
    /// <param name="content">The event content as a JsonElement, structure varies by event type</param>
    /// <param name="state">The full Komorebi state as a JsonElement</param>
    /// <remarks>
    /// Implementations should handle their own exceptions where possible.
    /// Unhandled exceptions will be caught by the service and logged, but will not stop other rules from processing.
    /// </remarks>
    void ProcessEvent(string eventType, JsonElement? content, JsonElement? state);
}
