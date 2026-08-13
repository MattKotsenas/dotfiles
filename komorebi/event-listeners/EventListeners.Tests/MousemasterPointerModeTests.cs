using EventListeners.Tests.KanataHarness;

namespace EventListeners.Tests;

public sealed class MousemasterPointerModeTests
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
        Assert.Contains("kanata-mode.indicator=normal-mode.indicator", properties);
        Assert.DoesNotContain("kanata-mode.start-move.", properties);
        Assert.DoesNotContain("kanata-mode.start-wheel.", properties);
        Assert.DoesNotContain("kanata-mode.press.", properties);
    }

    [Theory]
    [InlineData("normal")]
    [InlineData("grid")]
    [InlineData("window")]
    [InlineData("hint1")]
    [InlineData("hint2")]
    [InlineData("screen-selection")]
    [InlineData("ui-hint")]
    [InlineData("click-after-ui-hint")]
    [InlineData("begin-alt-tab")]
    [InlineData("end-alt-tab")]
    [InlineData("center-on-active-window")]
    public void PrivateTransport_CanResynchronizeEveryReachableMode(string mode)
    {
        var properties = Properties;

        Assert.Contains($"{mode}-mode.to.kanata-mode=+f14", properties);
        var transition = properties
            .Split(
                ['\r', '\n'],
                StringSplitOptions.RemoveEmptyEntries)
            .Single(line => line.StartsWith(
                $"{mode}-mode.to.idle-mode=",
                StringComparison.Ordinal));
        Assert.Contains("+f15", transition);
    }

    [Fact]
    public void F13ActivatesMousemasterPointerMode()
    {
        Assert.Contains(
            "idle-mode.to.normal-mode=+enablemod +enablekey | _{enablemod} +enablekey | +f13",
            Properties);
    }

    [Fact]
    public void PrivateHintTransports_DoNotDependOnVisibleFKey()
    {
        var properties = Properties;

        Assert.Contains("idle-mode.to.ui-hint-mode=+f16", properties);
        Assert.Contains("idle-mode.to.hint1-mode=+f17", properties);
    }
}
