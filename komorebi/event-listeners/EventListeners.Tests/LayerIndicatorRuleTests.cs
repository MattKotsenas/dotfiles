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
    [InlineData("wm", "\U0001FA9F WM")]
    [InlineData("wm-toggle", "\U0001FA9F WM \u2022")]
    [InlineData("wm-focus", "\U0001F3AF FOCUS")]
    [InlineData("wm-focus-toggle", "\U0001F3AF FOCUS \u2022")]
    [InlineData("wm-stack", "\U0001F4DA STACK")]
    [InlineData("wm-stack-toggle", "\U0001F4DA STACK \u2022")]
    [InlineData("wm-resize", "\U0001F4D0 RESIZE")]
    [InlineData("wm-move", "\U0001F4E6 MOVE")]
    [InlineData("wm-assemble", "\u2328 ASSEMBLE")]   // wm-assemble was removed in Phase 3 reorg; falls back to the generic ⌨ keyboard emoji
    [InlineData("wm-admin", "\U0001F527 ADMIN")]
    [InlineData("wm-admin-toggle", "\U0001F527 ADMIN \u2022")]
    [InlineData("wm-workspace", "\U0001F5C2 WORKSPACE")]
    [InlineData("wm-terminal", "\U0001F4BB TERM")]
    [InlineData("wm-terminal-toggle", "\U0001F4BB TERM \u2022")]
    [InlineData("wm-edge", "\U0001F310 EDGE")]
    [InlineData("wm-teams", "\U0001F4AC TEAMS")]
    [InlineData("wm-codeflow", "\U0001F50D REVIEW")]
    [InlineData("wm-codeflow-toggle", "\U0001F50D REVIEW \u2022")]
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
        Assert.Contains("WM", overlay.CurrentLabel);

        rule.ProcessEvent(new KanataLayerChangeEvent("wm-focus"));
        Assert.Contains("FOCUS", overlay.CurrentLabel);

        rule.ProcessEvent(new KanataLayerChangeEvent("wm-stack"));
        Assert.Contains("STACK", overlay.CurrentLabel);

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
