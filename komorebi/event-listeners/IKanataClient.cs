namespace EventListeners;

/// <summary>
/// Outbound interface to kanata's TCP server. Queued requests made while
/// disconnected are logged and discarded rather than replayed.
/// </summary>
public interface IKanataClient
{
    /// <summary>
    /// Queues a layer change for the current TCP connection without blocking.
    /// </summary>
    void QueueChangeLayer(string layerName);

    /// <summary>
    /// Queues a virtual-key tap for the current TCP connection without blocking.
    /// </summary>
    void QueueVirtualKey(string virtualKeyName);

    /// <summary>
    /// Immediately taps a standalone virtual key and awaits its write. This is
    /// not ordered relative to <see cref="QueueChangeLayer"/> or
    /// <see cref="QueueVirtualKey"/>.
    /// </summary>
    Task TapVirtualKeyAsync(string virtualKeyName, CancellationToken cancellationToken = default);
}
