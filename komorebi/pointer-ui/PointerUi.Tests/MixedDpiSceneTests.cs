namespace PointerUi.Tests;

public sealed class MixedDpiSceneTests
{
    [Fact]
    public void UiHintLabels_UseTheirWindowDpi()
    {
        var fixture = new DesktopFixture(
            1,
            "mixed-dpi",
            FixtureMode.UiHints,
            new PixelRect(0, 0, 800, 400),
            96,
            null,
            [
                Window(
                    "left",
                    new PixelRect(0, 0, 400, 400),
                    96,
                    new PixelRect(100, 100, 40, 20)),
                Window(
                    "right",
                    new PixelRect(400, 0, 400, 400),
                    192,
                    new PixelRect(500, 100, 40, 20)),
            ],
            null);

        var output = FixturePipeline.Prepare(
            fixture,
            new HintLabelSession());
        var labels = output.Scene.Primitives
            .Where(primitive => primitive.Kind is ScenePrimitiveKind.Text)
            .OrderBy(primitive => primitive.Bounds.X)
            .ToList();

        Assert.Equal(27, labels[0].Bounds.Width);
        Assert.Equal(22, labels[0].Bounds.Height);
        Assert.Equal(
            labels[0].Bounds.Width * 2,
            labels[1].Bounds.Width);
        Assert.Equal(
            labels[0].Bounds.Height * 2,
            labels[1].Bounds.Height);
    }

    private static WindowFixture Window(
        string role,
        PixelRect bounds,
        double dpi,
        PixelRect targetBounds) =>
        new(
            "app.exe",
            role,
            bounds,
            dpi,
            true,
            [
                new TargetFixture(
                    role,
                    "Button",
                    role,
                    [$"Window#{role}", $"Button#{role}"],
                    targetBounds,
                    SemanticActionKind.Invoke),
            ]);
}
