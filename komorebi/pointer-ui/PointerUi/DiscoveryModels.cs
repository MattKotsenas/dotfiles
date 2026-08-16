namespace PointerUi;

public sealed record DesktopCapture(
    PixelRect DesktopBounds,
    IReadOnlyList<WindowCapture> Windows);

public sealed record WindowCapture(
    string SessionKey,
    string ProcessKey,
    PixelRect Bounds,
    double Dpi,
    bool IsForeground,
    ElementCapture Root);

public sealed record ElementCapture(
    string AutomationId,
    string ControlType,
    string Name,
    string ClassName,
    PixelRect Bounds,
    bool IsOffscreen,
    bool IsEnabled,
    bool IsControlElement,
    bool IsKeyboardFocusable,
    SemanticActionKind SemanticAction,
    IReadOnlyList<ElementCapture> Children);

public sealed record ProjectionDiagnostic(
    string Code,
    string Window,
    string Detail);

public sealed record DiscoveryProjection(
    DesktopFixture Fixture,
    IReadOnlyList<ProjectionDiagnostic> Diagnostics);
