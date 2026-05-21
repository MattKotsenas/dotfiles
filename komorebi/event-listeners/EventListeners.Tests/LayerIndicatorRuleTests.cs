using Microsoft.Extensions.Logging.Abstractions;

namespace EventListeners.Tests;

public class LayerIndicatorRuleTests
{
    private static LayerIndicatorRule CreateRule(out FakeWindowAction action, out FakeWmOverlay overlay)
    {
        action = new FakeWindowAction();
        overlay = new FakeWmOverlay();
        return new LayerIndicatorRule(NullLogger<LayerIndicatorRule>.Instance, action, overlay);
    }

    [Theory]
    [InlineData("wm")]
    [InlineData("wm-focus")]
    [InlineData("wm-move")]
    [InlineData("wm-stack")]
    [InlineData("wm-resize")]
    public void WmLayer_ShowsOverlay(string layerName)
    {
        var rule = CreateRule(out _, out var overlay);

        rule.ProcessEvent(new KanataLayerChangeEvent(layerName));

        Assert.True(overlay.IsVisible);
    }

    [Fact]
    public void BaseLayer_AfterWm_HidesOverlay()
    {
        var rule = CreateRule(out _, out var overlay);

        rule.ProcessEvent(new KanataLayerChangeEvent("wm"));
        Assert.True(overlay.IsVisible, "precondition: overlay should be visible");

        rule.ProcessEvent(new KanataLayerChangeEvent("base"));

        Assert.False(overlay.IsVisible);
    }

    [Fact]
    public void BaseLayer_WhenAlreadyInBase_IsNoOp()
    {
        var rule = CreateRule(out _, out var overlay);

        rule.ProcessEvent(new KanataLayerChangeEvent("base"));

        Assert.Equal(0, overlay.ShowCount);
        Assert.Equal(0, overlay.HideCount);
    }

    [Fact]
    public void SubLayerChanges_WithinWm_DoNotToggleOverlay()
    {
        var rule = CreateRule(out _, out var overlay);

        rule.ProcessEvent(new KanataLayerChangeEvent("wm"));
        var showCountAfterEntry = overlay.ShowCount;

        rule.ProcessEvent(new KanataLayerChangeEvent("wm-focus"));
        rule.ProcessEvent(new KanataLayerChangeEvent("wm"));
        rule.ProcessEvent(new KanataLayerChangeEvent("wm-stack"));

        Assert.Equal(showCountAfterEntry, overlay.ShowCount);
        Assert.Equal(0, overlay.HideCount);
    }

    [Fact]
    public void KomorebiEvent_IsIgnored()
    {
        var rule = CreateRule(out _, out var overlay);

        rule.ProcessEvent(new KomorebiWindowEvent("Show", null, null));

        Assert.Equal(0, overlay.ShowCount);
    }
}

internal sealed class FakeWmOverlay : IWmOverlay
{
    public int ShowCount { get; private set; }
    public int HideCount { get; private set; }
    public bool IsVisible { get; private set; }

    public void Show() { ShowCount++; IsVisible = true; }
    public void Hide() { HideCount++; IsVisible = false; }
}
