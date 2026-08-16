namespace PointerUi;

public enum ScenePrimitiveKind
{
    Rectangle,
    Ellipse,
    Text,
}

public sealed record ScenePrimitive(
    ScenePrimitiveKind Kind,
    PixelRect Bounds,
    string? Fill = null,
    string? Stroke = null,
    double StrokeThickness = 0,
    string? Text = null,
    string? TextColor = null,
    double FontSize = 0);

public sealed record OverlayScene(
    string Name,
    int PixelWidth,
    int PixelHeight,
    double Dpi,
    IReadOnlyList<ScenePrimitive> Primitives);

public sealed record TargetSnapshot(
    LogicalTargetId LogicalId,
    string Label,
    string ProcessKey,
    string WindowRole,
    bool IsForeground,
    double WindowDpi,
    string AutomationId,
    string ControlType,
    string Name,
    PixelRect Bounds,
    SemanticActionKind SemanticAction);

public sealed record FixtureOutput(
    OverlayScene Scene,
    IReadOnlyList<TargetSnapshot> Targets);

internal static class RenderingMetrics
{
    public const double DefaultDpi = 96;
}
