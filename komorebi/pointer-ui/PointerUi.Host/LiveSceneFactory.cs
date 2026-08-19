using PointerUi.Windows;

namespace PointerUi.Host;

internal sealed record LiveOverlayFrame(
    OverlayScene Scene,
    PixelRect VirtualBounds,
    IReadOnlyList<MonitorSnapshot> Monitors,
    IReadOnlyList<TargetSnapshot> Targets);

internal sealed class LiveSceneFactory
{
    public LiveOverlayFrame Create(PointerUi.Protocol.PointerUiMode mode)
    {
        var layout = WindowsDesktopLayout.Capture();
        var output = mode switch
        {
            PointerUi.Protocol.PointerUiMode.Indicator =>
                Indicator(layout),
            PointerUi.Protocol.PointerUiMode.UiHints =>
                UiHints(),
            PointerUi.Protocol.PointerUiMode.GridHints =>
                Grid(layout),
            _ => throw new ArgumentOutOfRangeException(
                nameof(mode),
                mode,
                "Mode does not produce an overlay."),
        };

        return new LiveOverlayFrame(
            output.Scene,
            layout.VirtualBounds,
            layout.Monitors,
            output.Targets);
    }

    private static FixtureOutput Indicator(
        DesktopLayoutSnapshot layout)
    {
        var dpi = PointerMonitor(layout).Dpi;
        return FixturePipeline.Prepare(
            new DesktopFixture(
                1,
                "live-indicator",
                FixtureMode.Indicator,
                layout.VirtualBounds,
                dpi,
                layout.Pointer,
                [],
                null),
            new HintLabelSession());
    }

    private FixtureOutput UiHints()
    {
        var captured = new WindowsDesktopCaptureSource()
            .Capture(CaptureLimits.Default);
        var projection = DiscoveryProjector.Project(
            captured.Capture,
            "live-ui-hints",
            new WindowRoleSession());
        foreach (var diagnostic in captured.Diagnostics
            .Concat(projection.Diagnostics))
        {
            Console.Error.WriteLine(
                $"Pointer UI discovery {diagnostic.Code} "
                + $"[{diagnostic.Window}]: {diagnostic.Detail}");
        }
        return FixturePipeline.Prepare(
            projection.Fixture,
            new HintLabelSession());
    }

    private static FixtureOutput Grid(
        DesktopLayoutSnapshot layout)
    {
        return FixturePipeline.Prepare(
            new DesktopFixture(
                1,
                "live-grid-hints",
                FixtureMode.GridHints,
                layout.VirtualBounds,
                96,
                null,
                [],
                new GridFixture(4, 8)),
            new HintLabelSession());
    }

    private static MonitorSnapshot PointerMonitor(
        DesktopLayoutSnapshot layout) =>
        layout.Monitors.FirstOrDefault(
            monitor =>
                layout.Pointer.X >= monitor.Bounds.X
                && layout.Pointer.X
                    < monitor.Bounds.X + monitor.Bounds.Width
                && layout.Pointer.Y >= monitor.Bounds.Y
                && layout.Pointer.Y
                    < monitor.Bounds.Y + monitor.Bounds.Height)
        ?? layout.Monitors[0];
}
