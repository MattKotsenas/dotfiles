namespace EventListeners.Models;

/// <summary>Signals a new kanata TCP connection so rules can resynchronize layer state.</summary>
public sealed record KanataConnectedEvent : IEvent;
