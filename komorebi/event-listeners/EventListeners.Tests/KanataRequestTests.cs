using EventListeners.Generated;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

namespace EventListeners.Tests;

public class KanataRequestTests
{
    // Kanata parses these verbatim; the harness proves the keymap, but nothing
    // proves the wire format except this.
    [Fact]
    public void ActOnFakeKeyRequest_TapsTheNamedVirtualKey() =>
        Assert.Equal(
            "{\"ActOnFakeKey\":{\"name\":\"teams-join-focused\",\"action\":\"Tap\"}}\n",
            KanataEventListenerService.ActOnFakeKeyRequest(
                LayerCatalog.VirtualKeyTeamsJoinFocused));

    [Fact]
    public void ChangeLayerRequest_NamesTheNewLayer() =>
        Assert.Equal(
            "{\"ChangeLayer\":{\"new\":\"base-terminal\"}}\n",
            KanataEventListenerService.ChangeLayerRequest(LayerCatalog.BaseTerminal));

    [Fact]
    public void RequestQueue_PreservesLayerAndVirtualKeyOrder()
    {
        var service = new KanataEventListenerService(
            NullLogger<KanataEventListenerService>.Instance,
            [],
            new ConfigurationBuilder().Build());
        using var epoch = service.OpenRequestEpoch();

        service.QueueChangeLayer(LayerCatalog.PointerEdge);
        service.QueueVirtualKey(LayerCatalog.VirtualKeyPointerIndicatorOn);
        service.QueueChangeLayer(LayerCatalog.BaseEdge);

        Assert.True(epoch.Reader.TryRead(out var pointerLayer));
        Assert.Equal(
            KanataEventListenerService.ChangeLayerRequest(
                LayerCatalog.PointerEdge),
            pointerLayer!.Json);
        Assert.True(epoch.Reader.TryRead(out var indicator));
        Assert.Equal(
            KanataEventListenerService.ActOnFakeKeyRequest(
                LayerCatalog.VirtualKeyPointerIndicatorOn),
            indicator!.Json);
        Assert.True(epoch.Reader.TryRead(out var baseLayer));
        Assert.Equal(
            KanataEventListenerService.ChangeLayerRequest(
                LayerCatalog.BaseEdge),
            baseLayer!.Json);
        Assert.False(epoch.Reader.TryRead(out _));
    }

    [Fact]
    public void RequestQueue_DoesNotReplayAcrossConnectionEpochs()
    {
        var service = new KanataEventListenerService(
            NullLogger<KanataEventListenerService>.Instance,
            [],
            new ConfigurationBuilder().Build());

        using (var firstEpoch = service.OpenRequestEpoch())
        {
            service.QueueVirtualKey(
                LayerCatalog.VirtualKeyPointerIndicatorOn);
            Assert.True(firstEpoch.Reader.TryRead(out _));
        }

        service.QueueVirtualKey(
            LayerCatalog.VirtualKeyPointerHintUi);

        using var secondEpoch = service.OpenRequestEpoch();
        Assert.False(secondEpoch.Reader.TryRead(out _));
    }
}
