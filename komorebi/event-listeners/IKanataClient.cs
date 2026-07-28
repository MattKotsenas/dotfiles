namespace EventListeners;

/// <summary>Outbound interface to kanata's TCP server.</summary>
public interface IKanataClient
{
    /// <summary>Asks kanata to make <paramref name="layerName"/> its default layer.</summary>
    Task SendChangeLayerAsync(string layerName, CancellationToken cancellationToken = default);

    /// <summary>Asks kanata to tap the named virtual key.</summary>
    Task TapVirtualKeyAsync(string virtualKeyName, CancellationToken cancellationToken = default);
}
