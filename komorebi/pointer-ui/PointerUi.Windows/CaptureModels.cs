namespace PointerUi.Windows;

public sealed record CaptureLimits(
    int MaxDepth,
    int MaxElementsPerWindow)
{
    public const int DefaultMaxDepth = 16;
    public const int DefaultMaxElementsPerWindow = 5000;
    public const int MinDepth = 1;
    public const int MaxDepthLimit = 64;
    public const int MinElementsPerWindow = 1;
    public const int MaxElementsPerWindowLimit = 100_000;

    public static CaptureLimits Default { get; } =
        new(DefaultMaxDepth, DefaultMaxElementsPerWindow);

    public void Validate()
    {
        if (MaxDepth is < MinDepth or > MaxDepthLimit)
        {
            throw new ArgumentOutOfRangeException(
                nameof(MaxDepth),
                $"Max depth must be between {MinDepth} and {MaxDepthLimit}.");
        }
        if (MaxElementsPerWindow is
            < MinElementsPerWindow or > MaxElementsPerWindowLimit)
        {
            throw new ArgumentOutOfRangeException(
                nameof(MaxElementsPerWindow),
                $"Max elements must be between {MinElementsPerWindow} and {MaxElementsPerWindowLimit}.");
        }
    }
}

public sealed record DesktopCaptureResult(
    DesktopCapture Capture,
    IReadOnlyList<ProjectionDiagnostic> Diagnostics);

public interface IDesktopCaptureSource
{
    DesktopCaptureResult Capture(CaptureLimits limits);
}
