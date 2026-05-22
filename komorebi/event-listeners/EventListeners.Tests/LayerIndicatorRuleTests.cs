using Microsoft.Extensions.Logging.Abstractions;

namespace EventListeners.Tests;

public class LayerIndicatorRuleTests
{
    private static LayerIndicatorRule CreateRule(out FakeWmOverlay overlay)
    {
        overlay = new FakeWmOverlay();
        return new LayerIndicatorRule(NullLogger<LayerIndicatorRule>.Instance, overlay);
    }

    [Theory]
    [InlineData("wm", "WM")]
    [InlineData("wm-toggle", "WM \u2022")]
    [InlineData("wm-focus", "Focus")]
    [InlineData("wm-focus-toggle", "Focus \u2022")]
    [InlineData("wm-stack", "Stack")]
    [InlineData("wm-stack-toggle", "Stack \u2022")]
    [InlineData("wm-resize", "Resize")]
    [InlineData("wm-resize-toggle", "Resize \u2022")]
    [InlineData("wm-move", "Move")]
    [InlineData("wm-move-toggle", "Move \u2022")]
    [InlineData("wm-assemble", "Assemble")]
    [InlineData("wm-workspace", "Workspace")]
    [InlineData("wm-terminal", "Term")]
    [InlineData("wm-terminal-toggle", "Term \u2022")]
    public void LabelForLayer_KnownLayers_ReturnsLabel(string layer, string expected)
    {
        Assert.Equal(expected, LayerIndicatorRule.LabelForLayer(layer));
    }

    [Theory]
    [InlineData("base-default")]
    [InlineData("base-terminal")]
    [InlineData("base-edge")]
    public void LabelForLayer_BaseLayers_ReturnsNull(string layer)
    {
        Assert.Null(LayerIndicatorRule.LabelForLayer(layer));
    }

    [Theory]
    [InlineData("wm")]
    [InlineData("wm-focus")]
    [InlineData("wm-move")]
    [InlineData("wm-stack")]
    [InlineData("wm-resize")]
    public void WmLayer_ShowsOverlayWithLabel(string layerName)
    {
        var rule = CreateRule(out var overlay);

        rule.ProcessEvent(new KanataLayerChangeEvent(layerName));

        Assert.True(overlay.IsVisible);
        Assert.NotNull(overlay.CurrentLabel);
    }

    [Theory]
    [InlineData("base-default")]
    [InlineData("base-terminal")]
    [InlineData("base-edge")]
    public void BaseContextLayer_DoesNotShowOverlay(string layerName)
    {
        var rule = CreateRule(out var overlay);

        rule.ProcessEvent(new KanataLayerChangeEvent(layerName));

        Assert.False(overlay.IsVisible);
        Assert.Equal(0, overlay.ShowCount);
    }

    [Fact]
    public void BaseLayer_AfterWm_HidesOverlay()
    {
        var rule = CreateRule(out var overlay);

        rule.ProcessEvent(new KanataLayerChangeEvent("wm"));
        Assert.True(overlay.IsVisible, "precondition: overlay should be visible");

        rule.ProcessEvent(new KanataLayerChangeEvent("base-default"));

        Assert.False(overlay.IsVisible);
    }

    [Fact]
    public void BaseLayer_WhenAlreadyInBase_IsNoOp()
    {
        var rule = CreateRule(out var overlay);

        rule.ProcessEvent(new KanataLayerChangeEvent("base-default"));

        Assert.Equal(0, overlay.ShowCount);
        Assert.Equal(0, overlay.HideCount);
    }

    [Fact]
    public void SubLayerChanges_WithinWm_UpdateLabelEachTime()
    {
        var rule = CreateRule(out var overlay);

        rule.ProcessEvent(new KanataLayerChangeEvent("wm"));
        Assert.Equal("WM", overlay.CurrentLabel);

        rule.ProcessEvent(new KanataLayerChangeEvent("wm-focus"));
        Assert.Equal("Focus", overlay.CurrentLabel);

        rule.ProcessEvent(new KanataLayerChangeEvent("wm-stack"));
        Assert.Equal("Stack", overlay.CurrentLabel);

        // Still visible -- never hidden during sub-layer transitions
        Assert.True(overlay.IsVisible);
        Assert.Equal(0, overlay.HideCount);
    }

    [Fact]
    public void KomorebiEvent_IsIgnored()
    {
        var rule = CreateRule(out var overlay);

        rule.ProcessEvent(new KomorebiWindowEvent("Show", null, null));

        Assert.Equal(0, overlay.ShowCount);
    }
}

internal sealed class FakeWmOverlay : IWmOverlay
{
    public int ShowCount { get; private set; }
    public int HideCount { get; private set; }
    public bool IsVisible { get; private set; }
    public string? CurrentLabel { get; private set; }

    public void Show(string label) { ShowCount++; IsVisible = true; CurrentLabel = label; }
    public void Hide() { HideCount++; IsVisible = false; }
}
