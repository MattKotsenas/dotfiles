namespace EventListeners.Models;

/// <summary>
/// Emitted when kanata broadcasts a push-msg action via TCP.
/// </summary>
public sealed record KanataMessageEvent(string Message) : IEvent;
