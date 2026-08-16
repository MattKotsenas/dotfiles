namespace PointerUi.Windows;

public sealed class WindowsDesktopCaptureSource : IDesktopCaptureSource
{
    private readonly UiaTreeReader _uia = new();

    public DesktopCaptureResult Capture(
        CaptureLimits limits,
        string? processKey = null)
    {
        limits.Validate();
        var windows = new List<WindowCapture>();
        var native = NativeWindowCatalog.Enumerate(processKey);
        var diagnostics = native.Diagnostics.ToList();
        foreach (var nativeWindow in native.Windows)
        {
            var windowKey = $"0x{nativeWindow.Hwnd:X}";
            try
            {
                var uia = _uia.ReadWindow(nativeWindow.Hwnd, limits);
                windows.Add(new WindowCapture(
                    SessionKey(nativeWindow),
                    nativeWindow.ProcessKey,
                    nativeWindow.Bounds,
                    nativeWindow.Dpi,
                    nativeWindow.IsForeground,
                    uia.Root));
                diagnostics.AddRange(uia.Diagnostics);
            }
            catch (Exception exception)
                when (!ExceptionPolicy.IsFatal(exception))
            {
                diagnostics.Add(new ProjectionDiagnostic(
                    "uia-window-failed",
                    windowKey,
                    exception.Message));
            }
        }

        return new DesktopCaptureResult(
            new DesktopCapture(
                NativeWindowCatalog.VirtualDesktopBounds(),
                windows),
            diagnostics);
    }

    private static string SessionKey(
        NativeWindowCandidate window) =>
        $"{window.ProcessId}:{window.ProcessStartTimeUtcTicks}:0x{window.Hwnd:X}";
}
