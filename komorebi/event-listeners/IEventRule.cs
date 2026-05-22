using EventListeners.Models;
namespace EventListeners;

/// <summary>
/// Interface for rules that process events from any source (Komorebi, Kanata, etc.).
/// </summary>
public interface IEventRule
{
    /// <summary>
    /// Display name for logging purposes.
    /// </summary>
    string Name { get; }

    /// <summary>
    /// Process an event. Implementations should pattern-match on the event type
    /// and return early for events they don't handle.
    /// </summary>
    void ProcessEvent(IEvent evt);
}
