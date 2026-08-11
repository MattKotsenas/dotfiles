using EventListeners.Tests.KanataHarness;

namespace EventListeners.Tests.Kanata;

[Trait("Category", "KanataHarness")]
public sealed class KanataNativePointerSimulatorTests
{
    private static string ConfigPath => Path.Combine(
        TestPaths.RepoRoot,
        "komorebi",
        "event-listeners",
        "EventListeners.Tests",
        "Kanata",
        "kanata-native-pointer.kbd");

    [Theory]
    [InlineData("h", "j", "Left", "Down")]
    [InlineData("h", "k", "Left", "Up")]
    [InlineData("l", "j", "Right", "Down")]
    [InlineData("l", "k", "Right", "Up")]
    [InlineData("j", "h", "Down", "Left")]
    [InlineData("k", "h", "Up", "Left")]
    [InlineData("j", "l", "Down", "Right")]
    [InlineData("k", "l", "Up", "Right")]
    public async Task Diagonal_ComposesAndReleasesAxesIndependently(
        string firstKey,
        string secondKey,
        string firstDirection,
        string secondDirection)
    {
        var output = await KanataSimulator.RunAsync(
            ConfigPath,
            new SimInput()
                .Down(firstKey)
                .Wait(120)
                .Down(secondKey)
                .Tap("q")
                .Wait(160)
                .Tap("b")
                .Up(firstKey)
                .Tap("c")
                .Wait(120)
                .Up(secondKey)
                .Tap("g")
                .Wait(80));

        var bothHeld = Between(output.RawStdout, "out:↓F20", "out:↓F24");
        var afterFirstRelease = Between(
            output.RawStdout,
            "out:↓F23",
            "out:↓F22");
        var afterFullRelease = output.RawStdout[
            output.RawStdout.IndexOf("out:↓F22", StringComparison.Ordinal)..];
        Assert.Contains(
            $"out🖰:move {firstDirection},",
            bothHeld,
            StringComparison.Ordinal);
        Assert.Contains(
            $"out🖰:move {secondDirection},",
            bothHeld,
            StringComparison.Ordinal);
        Assert.Contains(
            $"out🖰:move {secondDirection},",
            afterFirstRelease,
            StringComparison.Ordinal);
        Assert.DoesNotContain(
            $"out🖰:move {firstDirection},",
            afterFirstRelease,
            StringComparison.Ordinal);
        Assert.DoesNotContain(
            "out🖰:move",
            afterFullRelease,
            StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("h", "Left")]
    [InlineData("j", "Down")]
    [InlineData("k", "Up")]
    [InlineData("l", "Right")]
    public async Task HeldMotion_Accelerates(
        string key,
        string direction)
    {
        var output = await KanataSimulator.RunAsync(
            ConfigPath,
            new SimInput()
                .Down(key)
                .Wait(500)
                .Up(key)
                .Wait(80));
        var distances = output.MouseMoves
            .Where(move => move.Direction == direction)
            .Select(move => move.Distance)
            .ToArray();

        Assert.NotEmpty(distances);
        Assert.Equal(1, distances[0]);
        Assert.True(distances[^1] > distances[0]);
        Assert.True(distances.SequenceEqual(distances.Order()));
    }

    [Theory]
    [InlineData("u", "Left")]
    [InlineData("i", "Down")]
    [InlineData("o", "Up")]
    [InlineData("p", "Right")]
    public async Task WheelRepeatsAndStopsOnRelease(
        string key,
        string direction)
    {
        var output = await KanataSimulator.RunAsync(
            ConfigPath,
            new SimInput()
                .Down(key)
                .Wait(180)
                .Up(key)
                .Tap("g")
                .Wait(80));

        Assert.True(output.MouseScrolls.Count >= 3);
        Assert.All(
            output.MouseScrolls,
            scroll =>
            {
                Assert.Equal(direction, scroll.Direction);
                Assert.Equal(120, scroll.Distance);
            });
        var afterRelease = output.RawStdout[
            output.RawStdout.IndexOf("out:↓F22", StringComparison.Ordinal)..];
        Assert.DoesNotContain("scroll:", afterRelease, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ButtonTapsAreAtomic()
    {
        var output = await KanataSimulator.RunAsync(
            ConfigPath,
            new SimInput()
                .Down("n")
                .Tap("b")
                .Wait(80)
                .Up("n")
                .Down("m")
                .Tap("c")
                .Wait(80)
                .Up("m")
                .Wait(80));

        Assert.Equal(
        [
            new MouseButtonEvent("↓", "Left"),
            new MouseButtonEvent("↑", "Left"),
            new MouseButtonEvent("↓", "Right"),
            new MouseButtonEvent("↑", "Right"),
        ],
            output.MouseButtons);

        var leftDown = output.RawStdout.IndexOf("out🖰:↓Left", StringComparison.Ordinal);
        var leftUp = output.RawStdout.IndexOf("out🖰:↑Left", StringComparison.Ordinal);
        var leftMarker = output.RawStdout.IndexOf("out:↓F24", StringComparison.Ordinal);
        var rightDown = output.RawStdout.IndexOf("out🖰:↓Right", StringComparison.Ordinal);
        var rightUp = output.RawStdout.IndexOf("out🖰:↑Right", StringComparison.Ordinal);
        var rightMarker = output.RawStdout.IndexOf("out:↓F23", StringComparison.Ordinal);
        Assert.True(leftDown < leftUp && leftUp < leftMarker);
        Assert.True(rightDown < rightUp && rightUp < rightMarker);
    }

    private static string Between(
        string text,
        string startMarker,
        string endMarker)
    {
        var start = text.IndexOf(startMarker, StringComparison.Ordinal);
        var end = text.IndexOf(endMarker, start, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Missing marker: {startMarker}");
        Assert.True(end > start, $"Missing marker after {startMarker}: {endMarker}");
        return text[start..end];
    }
}
