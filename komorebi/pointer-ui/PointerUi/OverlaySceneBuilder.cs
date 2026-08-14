using System.IO;

namespace PointerUi;

public static class OverlaySceneBuilder
{
    private const string MochaBase = "#331E1E2E";
    private const string MochaSurface = "#E61E1E2E";
    private const string MochaBorder = "#FF45475A";
    private const string MochaText = "#FFCBA6F7";
    private const string MochaForeground = "#FFCDD6F4";
    private const string MochaSubtle = "#665B6078";

    public static OverlayScene Build(
        DesktopFixture fixture,
        IReadOnlyList<LabeledTarget> targets)
    {
        var primitives = fixture.Mode switch
        {
            FixtureMode.Indicator => BuildIndicator(fixture),
            FixtureMode.UiHints => BuildUiHints(fixture, targets),
            FixtureMode.GridHints => BuildGridHints(fixture),
            _ => throw new ArgumentOutOfRangeException(
                nameof(fixture),
                fixture.Mode,
                "Unknown fixture mode."),
        };

        return new OverlayScene(
            fixture.Name,
            checked((int)fixture.DesktopBounds.Width),
            checked((int)fixture.DesktopBounds.Height),
            fixture.Dpi,
            primitives);
    }

    private static IReadOnlyList<ScenePrimitive> BuildIndicator(
        DesktopFixture fixture)
    {
        var pointer = fixture.Pointer
            ?? throw new InvalidDataException(
                $"Indicator fixture '{fixture.Name}' has no pointer.");
        var scale = fixture.Dpi / RenderingMetrics.DefaultDpi;
        var diameter = 48 * scale;
        return
        [
            new ScenePrimitive(
                ScenePrimitiveKind.Ellipse,
                new PixelRect(
                    pointer.X - fixture.DesktopBounds.X - diameter / 2,
                    pointer.Y - fixture.DesktopBounds.Y - diameter / 2,
                    diameter,
                    diameter),
                Stroke: MochaText,
                StrokeThickness: 3 * scale),
        ];
    }

    private static IReadOnlyList<ScenePrimitive> BuildUiHints(
        DesktopFixture fixture,
        IReadOnlyList<LabeledTarget> targets)
    {
        var scale = fixture.Dpi / RenderingMetrics.DefaultDpi;
        var primitives = new List<ScenePrimitive>
        {
            new(
                ScenePrimitiveKind.Rectangle,
                new PixelRect(
                    0,
                    0,
                    fixture.DesktopBounds.Width,
                    fixture.DesktopBounds.Height),
                Fill: MochaBase),
        };

        foreach (var window in fixture.Windows)
        {
            primitives.Add(new ScenePrimitive(
                ScenePrimitiveKind.Rectangle,
                ToLocal(fixture, window.Bounds),
                Stroke: MochaSubtle,
                StrokeThickness: scale));
        }

        foreach (var target in targets.OrderBy(
            target => target.Label,
            StringComparer.Ordinal))
        {
            var center = ToLocal(fixture, target.Target.Bounds).Center;
            var width = (18 + target.Label.Length * 9) * scale;
            var height = 22 * scale;
            var bounds = Clamp(
                new PixelRect(
                    center.X - width / 2,
                    center.Y - height / 2,
                    width,
                    height),
                fixture.DesktopBounds.Width,
                fixture.DesktopBounds.Height);
            primitives.Add(new ScenePrimitive(
                ScenePrimitiveKind.Rectangle,
                bounds,
                Fill: MochaSurface,
                Stroke: MochaBorder,
                StrokeThickness: scale));
            primitives.Add(new ScenePrimitive(
                ScenePrimitiveKind.Text,
                bounds,
                Text: target.Label,
                TextColor: MochaText,
                FontSize: 11 * scale));
        }

        return primitives;
    }

    private static IReadOnlyList<ScenePrimitive> BuildGridHints(
        DesktopFixture fixture)
    {
        var grid = fixture.Grid
            ?? throw new InvalidDataException(
                $"Grid fixture '{fixture.Name}' has no grid.");
        if (grid.Rows <= 0 || grid.Columns <= 0)
        {
            throw new InvalidDataException(
                $"Grid fixture '{fixture.Name}' has invalid dimensions.");
        }

        var scale = fixture.Dpi / RenderingMetrics.DefaultDpi;
        var width = fixture.DesktopBounds.Width;
        var height = fixture.DesktopBounds.Height;
        var cellWidth = width / grid.Columns;
        var cellHeight = height / grid.Rows;
        var primitives = new List<ScenePrimitive>
        {
            new(
                ScenePrimitiveKind.Rectangle,
                new PixelRect(0, 0, width, height),
                Fill: MochaBase),
        };

        for (var column = 1; column < grid.Columns; column++)
        {
            primitives.Add(new ScenePrimitive(
                ScenePrimitiveKind.Rectangle,
                new PixelRect(column * cellWidth, 0, scale, height),
                Fill: MochaSubtle));
        }
        for (var row = 1; row < grid.Rows; row++)
        {
            primitives.Add(new ScenePrimitive(
                ScenePrimitiveKind.Rectangle,
                new PixelRect(0, row * cellHeight, width, scale),
                Fill: MochaSubtle));
        }

        using var labels = HintLabelSequence.Generate().GetEnumerator();
        for (var row = 0; row < grid.Rows; row++)
        {
            for (var column = 0; column < grid.Columns; column++)
            {
                if (!labels.MoveNext())
                {
                    throw new InvalidOperationException(
                        "The grid exceeds the hint label space.");
                }
                primitives.Add(new ScenePrimitive(
                    ScenePrimitiveKind.Text,
                    new PixelRect(
                        column * cellWidth,
                        row * cellHeight,
                        cellWidth,
                        cellHeight),
                    Text: labels.Current,
                    TextColor: MochaForeground,
                    FontSize: 12 * scale));
            }
        }

        return primitives;
    }

    private static PixelRect ToLocal(
        DesktopFixture fixture,
        PixelRect bounds) =>
        bounds with
        {
            X = bounds.X - fixture.DesktopBounds.X,
            Y = bounds.Y - fixture.DesktopBounds.Y,
        };

    private static PixelRect Clamp(
        PixelRect bounds,
        double width,
        double height) =>
        bounds with
        {
            X = Math.Clamp(bounds.X, 0, Math.Max(0, width - bounds.Width)),
            Y = Math.Clamp(bounds.Y, 0, Math.Max(0, height - bounds.Height)),
        };
}
