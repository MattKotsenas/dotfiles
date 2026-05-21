using Microsoft.Extensions.Logging.Abstractions;

namespace EventListeners.Tests;

public class LayerIndicatorRuleTests
{
    private static LayerIndicatorRule CreateRule(out FakeWindowAction action)
    {
        action = new FakeWindowAction();
        return new LayerIndicatorRule(NullLogger<LayerIndicatorRule>.Instance, action);
    }

    [Theory]
    [InlineData("wm")]
    [InlineData("wm-focus")]
    [InlineData("wm-move")]
    [InlineData("wm-stack")]
    [InlineData("wm-resize")]
    public void WmLayer_SetsSaturatedBorderColors(string layerName)
    {
        var rule = CreateRule(out var action);

        rule.ProcessEvent(new KanataLayerChangeEvent(layerName));

        var colors = action.BorderColours.ToList();
        Assert.Equal(3, colors.Count);
        Assert.Contains(colors, c => c.Kind == "single" && c.R == 50 && c.G == 210 && c.B == 248);
        Assert.Contains(colors, c => c.Kind == "stack" && c.R == 180 && c.G == 120 && c.B == 250);
        Assert.Contains(colors, c => c.Kind == "unfocused" && c.R == 80 && c.G == 85 && c.B == 110);
    }

    [Fact]
    public void BaseLayer_RevertsToNormalBorderColors()
    {
        var rule = CreateRule(out var action);

        rule.ProcessEvent(new KanataLayerChangeEvent("base"));

        var colors = action.BorderColours.ToList();
        Assert.Equal(3, colors.Count);
        Assert.Contains(colors, c => c.Kind == "single" && c.R == 116 && c.G == 199 && c.B == 236);
        Assert.Contains(colors, c => c.Kind == "stack" && c.R == 203 && c.G == 166 && c.B == 247);
        Assert.Contains(colors, c => c.Kind == "unfocused" && c.R == 69 && c.G == 71 && c.B == 90);
    }

    [Fact]
    public void KomorebiEvent_IsIgnored()
    {
        var rule = CreateRule(out var action);

        rule.ProcessEvent(new KomorebiWindowEvent("Show", null, null));

        Assert.Empty(action.BorderColours);
    }
}
