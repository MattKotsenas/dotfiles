using PointerUi.Windows;
using System.Runtime.InteropServices;

namespace PointerUi.Discovery.Tests;

public sealed class WindowEligibilityTests
{
    [Fact]
    public void VisibleCurrentDesktopWindow_IsEligible() =>
        Assert.True(WindowEligibility.IsEligible(Window()));

    [Theory]
    [InlineData(true, false, false, false, false, false, "minimized")]
    [InlineData(false, true, false, false, false, false, "cloaked")]
    [InlineData(false, false, true, false, false, false, "other desktop")]
    [InlineData(false, false, false, true, false, false, "tool window")]
    [InlineData(false, false, false, false, true, false, "no-activate")]
    [InlineData(false, false, false, false, false, true, "child")]
    public void NonInteractiveOrHiddenWindow_IsRejected(
        bool minimized,
        bool cloaked,
        bool otherDesktop,
        bool toolWindow,
        bool noActivate,
        bool child,
        string reason)
    {
        var window = Window(
            minimized: minimized,
            cloaked: cloaked,
            onCurrentDesktop: !otherDesktop,
            toolWindow: toolWindow,
            noActivate: noActivate,
            child: child);

        Assert.False(WindowEligibility.IsEligible(window), reason);
    }

    [Fact]
    public void InvisibleWindow_IsRejected() =>
        Assert.False(WindowEligibility.IsEligible(
            Window(visible: false)));

    [Theory]
    [InlineData(31, 600)]
    [InlineData(800, 31)]
    public void TinyWindow_IsRejected(double width, double height) =>
        Assert.False(WindowEligibility.IsEligible(
            Window(bounds: new PixelRect(0, 0, width, height))));

    [Theory]
    [InlineData("Progman")]
    [InlineData("WorkerW")]
    public void DesktopShellWindow_IsRejected(string className) =>
        Assert.False(WindowEligibility.IsEligible(
            Window(className: className)));

    [Fact]
    public void DesktopQueryFailure_SkipsWindowAndContinues()
    {
        var windows = new List<NativeWindowCandidate>();
        var diagnostics = new List<ProjectionDiagnostic>();

        var shouldContinue = NativeWindowCatalog.TryCollectWindow(
            (nint)123,
            static () => throw new ArgumentException(
                "The window handle is invalid."),
            windows,
            diagnostics);

        Assert.True(shouldContinue);
        Assert.Empty(windows);
        var diagnostic = Assert.Single(diagnostics);
        Assert.Equal("desktop-query-failed", diagnostic.Code);
    }

    private static NativeWindowCandidate Window(
        bool visible = true,
        bool minimized = false,
        bool cloaked = false,
        bool onCurrentDesktop = true,
        bool toolWindow = false,
        bool noActivate = false,
        bool child = false,
        PixelRect? bounds = null,
        string className = "AppWindow") =>
        new(
            (nint)123,
            42,
            "app.exe",
            1234,
            bounds ?? new PixelRect(0, 0, 800, 600),
            96,
            true,
            visible,
            minimized,
            cloaked,
            onCurrentDesktop,
            toolWindow,
            noActivate,
            child,
            className);
}
