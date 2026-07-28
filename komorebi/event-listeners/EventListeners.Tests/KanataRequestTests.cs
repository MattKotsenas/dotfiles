using EventListeners.Generated;

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
}
