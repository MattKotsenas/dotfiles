using PointerUi.Recorder;

namespace PointerUi.Discovery.Tests;

public sealed class RecorderOptionsTests
{
    [Fact]
    public void MissingLiveCaptureFlag_IsRejected()
    {
        var result = RecorderParseResult.Parse(
        [
            "--output", "capture.json",
            "--name", "capture",
        ]);

        Assert.Null(result.Options);
        Assert.Contains(
            "--allow-live-desktop-capture",
            result.Error);
    }

    [Fact]
    public void ExplicitOptions_AreParsed()
    {
        var result = RecorderParseResult.Parse(
        [
            "--allow-live-desktop-capture",
            "--output", "captures\\desktop.json",
            "--name", "desktop",
            "--max-depth", "12",
            "--max-elements-per-window", "2400",
            "--overwrite",
        ]);

        var options = Assert.IsType<RecorderOptions>(
            result.Options);
        Assert.True(options.Overwrite);
        Assert.Equal("desktop", options.FixtureName);
        Assert.Equal(12, options.Limits.MaxDepth);
        Assert.Equal(2400, options.Limits.MaxElementsPerWindow);
        Assert.EndsWith(
            "desktop.diagnostics.json",
            options.DiagnosticsPath,
            StringComparison.Ordinal);
    }
}
