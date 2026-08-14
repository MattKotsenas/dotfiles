using EventListeners.Tests.KanataHarness;

namespace EventListeners.Tests;

public sealed class MousemasterTransportTests
{
    private static string Properties =>
        File.ReadAllText(Path.Combine(
            TestPaths.RepoRoot,
            "mousemaster",
            "mousemaster.properties"));

    [Fact]
    public void PrivateF14Mode_IsIndicatorOnly()
    {
        var properties = Properties;

        Assert.Contains("idle-mode.to.kanata-mode=+f14", properties);
        Assert.Contains("kanata-mode.to.kanata-mode=+f14", properties);
        Assert.Contains("kanata-mode.to.idle-mode=+f15", properties);
        Assert.Contains("kanata-mode.to.ui-hint-mode=+f16", properties);
        Assert.Contains("kanata-mode.to.hint1-mode=+f17", properties);
        Assert.Contains("kanata-mode.indicator.enabled=true", properties);
        Assert.DoesNotContain("kanata-mode.start-move.", properties);
        Assert.DoesNotContain("kanata-mode.start-wheel.", properties);
        Assert.DoesNotContain("kanata-mode.press.", properties);
    }

    [Theory]
    [InlineData("hint1")]
    [InlineData("hint2")]
    [InlineData("ui-hint")]
    [InlineData("click-after-ui-hint")]
    [InlineData("begin-alt-tab")]
    [InlineData("end-alt-tab")]
    [InlineData("center-on-active-window")]
    public void PrivateTransport_CanResynchronizeEveryReachableMode(string mode)
    {
        var properties = Properties;

        Assert.Contains($"{mode}-mode.to.kanata-mode=+f14", properties);
        var transitions = properties
            .Split(
                ['\r', '\n'],
                StringSplitOptions.RemoveEmptyEntries)
            .Where(line => line.StartsWith(
                $"{mode}-mode.to.idle-mode=",
                StringComparison.Ordinal));
        Assert.Contains(
            transitions,
            transition => transition.Contains(
                "+f15",
                StringComparison.Ordinal));
    }

    [Fact]
    public void FullMousemasterPointerMode_IsRemoved()
    {
        var properties = Properties;
        var lines = properties.Split(
            ['\r', '\n'],
            StringSplitOptions.RemoveEmptyEntries);

        Assert.DoesNotContain("f13", properties, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(
            lines,
            line => line.StartsWith("normal-mode.", StringComparison.Ordinal));
        Assert.DoesNotContain(
            lines,
            line => line.StartsWith("grid-mode.", StringComparison.Ordinal));
        Assert.DoesNotContain(
            lines,
            line => line.StartsWith("window-mode.", StringComparison.Ordinal));
        Assert.DoesNotContain(
            lines,
            line => line.StartsWith(
                "screen-selection-mode.",
                StringComparison.Ordinal));
    }

    [Fact]
    public void PrivateHintTransports_DoNotDependOnVisibleFKey()
    {
        var properties = Properties;

        Assert.Contains("idle-mode.to.ui-hint-mode=+f16", properties);
        Assert.Contains("idle-mode.to.hint1-mode=+f17", properties);
    }

    [Theory]
    [InlineData("hint1-mode.to.idle-mode=+f15 | +esc | +backspace")]
    [InlineData("hint2-mode.to.idle-mode=+f15 | +esc | _{none | hint2mod | gridhintmod} +extendedhint1key")]
    [InlineData("ui-hint-mode.to.idle-mode=+f15 | +esc | +backspace | _{rightalt} +hint1key")]
    [InlineData("click-after-ui-hint-mode.to.idle-mode=+f15 | ^{hint1key}")]
    public void HintCompletion_ReturnsToIdle(string transition)
    {
        Assert.Contains(transition, Properties);
    }
}
