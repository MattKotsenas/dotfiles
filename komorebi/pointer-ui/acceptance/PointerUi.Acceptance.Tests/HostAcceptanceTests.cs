using System.Diagnostics;
using System.IO.Pipes;
using PointerUi.Acceptance.Runner;
using PointerUi.Protocol;
using PointerUi.Windows;

namespace PointerUi.Acceptance.Tests;

public sealed class HostAcceptanceTests
{
    private static readonly TimeSpan StartupTimeout =
        TimeSpan.FromSeconds(15);
    private static readonly TimeSpan CommandTimeout =
        TimeSpan.FromSeconds(30);

    [Fact]
    [Trait("Category", "VmAcceptance")]
    public async Task Host_EndToEndLifecycleRendersTracksAndRecovers()
    {
        var artifacts = Path.Combine(
            VmAcceptanceGuard.RequireArtifactsDirectory(),
            "host");
        Directory.CreateDirectory(artifacts);
        var readyFile = Path.Combine(artifacts, "ready.txt");
        var commandFile = Path.Combine(
            artifacts,
            "command.txt");
        var acknowledgementFile = Path.Combine(
            artifacts,
            "ack.txt");
        var pointerUiRoot = PointerUiRoot();
        using var app = DotnetProcess.Start(
            pointerUiRoot,
            "run",
            "--project",
            Path.Combine(
                pointerUiRoot,
                "acceptance",
                "PointerUi.TestApp",
                "PointerUi.TestApp.csproj"),
            "-c",
            "Release",
            "--no-build",
            "--",
            "--scenario",
            "all-windows",
            "--ready-file",
            readyFile,
            "--command-file",
            commandFile,
            "--ack-file",
            acknowledgementFile);
        var appOutput = app.StandardOutput.ReadToEndAsync();
        var appError = app.StandardError.ReadToEndAsync();
        using var host = StartHost(
            Path.Combine(
                pointerUiRoot,
                "PointerUi.Host",
                "bin",
                "Release",
                "net10.0-windows",
                "PointerUi.Host.exe"),
            pointerUiRoot);
        var hostOutput = host.StandardOutput.ReadToEndAsync();
        var hostError = host.StandardError.ReadToEndAsync();
        PixelPoint? originalPointer = null;

        try
        {
            await FileWaiter.WaitForFileAsync(
                readyFile,
                StartupTimeout);
            await using var pipe = await ConnectAsync();
            var layout = WindowsDesktopLayout.Capture();
            originalPointer = layout.Pointer;
            var expectedBounds = layout
                .Monitors
                .Select(monitor => monitor.Bounds)
                .OrderBy(bounds => bounds.X)
                .ThenBy(bounds => bounds.Y)
                .ToList();
            var foreground =
                HostWindowCatalog.ForegroundWindow();
            Assert.NotEqual(nint.Zero, foreground);
            var captured = new WindowsDesktopCaptureSource()
                .Capture(CaptureLimits.Default);
            var projection = DiscoveryProjector.Project(
                captured.Capture,
                "host-acceptance-ui",
                new WindowRoleSession());
            var uiOutput = FixturePipeline.Prepare(
                projection.Fixture,
                new HintLabelSession());
            var save = uiOutput.Targets.First(
                target => target.AutomationId == "save");
            var uiPrimitive = uiOutput.Scene.Primitives.First(
                primitive =>
                    primitive.Kind is ScenePrimitiveKind.Text
                    && primitive.Text == save.Label);
            var uiBounds = ToScreen(
                projection.Fixture.DesktopBounds,
                uiPrimitive.Bounds);
            var uiBaseline =
                HostWindowCatalog.ScreenChecksum(uiBounds);
            var uiSample = new PixelPoint(
                uiBounds.X + 2,
                uiBounds.Y + 2);
            Assert.True(
                Luminance(
                    HostWindowCatalog.ScreenColor(
                        uiSample)) > 150);
            var gridScene = FixturePipeline.Prepare(
                new DesktopFixture(
                    1,
                    "host-acceptance-grid",
                    FixtureMode.GridHints,
                    layout.VirtualBounds,
                    96,
                    null,
                    [],
                    new GridFixture(4, 8)),
                new HintLabelSession()).Scene;
            var gridPrimitive = gridScene.Primitives
                .Skip(1)
                .First(primitive =>
                    primitive.Kind
                        is ScenePrimitiveKind.Rectangle);
            var gridBounds = ToScreen(
                layout.VirtualBounds,
                gridPrimitive.Bounds);
            var gridBaseline =
                HostWindowCatalog.ScreenChecksum(gridBounds);
            var gridLine = gridBounds.Center;
            var gridAdjacent = gridLine with
            {
                X = gridLine.X + 4,
            };
            Assert.Equal(
                HostWindowCatalog.ScreenColor(gridLine),
                HostWindowCatalog.ScreenColor(
                    gridAdjacent));

            var sequence = 0L;
            var pointerMonitor = layout.Monitors.First(
                monitor =>
                    layout.Pointer.X >= monitor.Bounds.X
                    && layout.Pointer.X
                        < monitor.Bounds.X
                            + monitor.Bounds.Width
                    && layout.Pointer.Y >= monitor.Bounds.Y
                    && layout.Pointer.Y
                        < monitor.Bounds.Y
                            + monitor.Bounds.Height);
            var ringRadius = 24 * pointerMonitor.Dpi / 96;
            var oldRing = new PixelPoint(
                layout.Pointer.X + ringRadius,
                layout.Pointer.Y);
            var newPointer = new PixelPoint(
                layout.Pointer.X + 120 + ringRadius
                    < pointerMonitor.Bounds.X
                        + pointerMonitor.Bounds.Width
                    ? layout.Pointer.X + 120
                    : layout.Pointer.X - 120,
                layout.Pointer.Y);
            var newRing = new PixelPoint(
                newPointer.X + ringRadius,
                newPointer.Y);
            var oldBaseline =
                HostWindowCatalog.ScreenChecksum(oldRing);
            var newBaseline =
                HostWindowCatalog.ScreenChecksum(newRing);
            var indicator = await SendAsync(
                ++sequence,
                PointerUiMode.Indicator,
                pipe);
            Assert.True(indicator.Applied);
            Assert.Null(indicator.Error);
            Assert.Equal(
                expectedBounds.Count,
                indicator.OverlayWindowCount);
            await WaitUntilAsync(
                () => HostWindowCatalog.ScreenChecksum(
                    oldRing) != oldBaseline);
            HostWindowCatalog.SetPointer(newPointer);
            await WaitUntilAsync(
                () =>
                    HostWindowCatalog.ScreenChecksum(
                        oldRing) == oldBaseline
                    && HostWindowCatalog.ScreenChecksum(
                        newRing) != newBaseline);

            foreach (var mode in new[]
            {
                PointerUiMode.UiHints,
                PointerUiMode.GridHints,
            })
            {
                var response = await SendAsync(
                    ++sequence,
                    mode,
                    pipe);
                Assert.True(response.Applied);
                Assert.Null(response.Error);
                Assert.Equal(
                    expectedBounds.Count,
                    response.OverlayWindowCount);
                var windows = HostWindowCatalog
                    .Enumerate(host.Id);
                Assert.Equal(
                    expectedBounds,
                    windows
                        .Select(window => window.Bounds)
                        .OrderBy(bounds => bounds.X)
                        .ThenBy(bounds => bounds.Y));
                Assert.All(
                    windows,
                    window =>
                    {
                        Assert.NotEqual(
                            0,
                            window.ExtendedStyle
                                & HostWindowCatalog.Transparent);
                        Assert.NotEqual(
                            0,
                            window.ExtendedStyle
                                & HostWindowCatalog.ToolWindow);
                        Assert.NotEqual(
                            0,
                            window.ExtendedStyle
                                & HostWindowCatalog.NoActivate);
                        Assert.True(window.IsPerMonitorV2);
                    });
                Assert.Equal(
                    foreground,
                    HostWindowCatalog.ForegroundWindow());
                var changed = mode switch
                {
                    PointerUiMode.UiHints =>
                        HostWindowCatalog.ScreenChecksum(
                            uiBounds) != uiBaseline,
                    PointerUiMode.GridHints =>
                        HostWindowCatalog.ScreenChecksum(
                            gridBounds) != gridBaseline,
                    _ => false,
                };
                Assert.True(changed);
                if (mode is PointerUiMode.UiHints)
                {
                    Assert.True(
                        Luminance(
                            HostWindowCatalog.ScreenColor(
                                uiSample)) < 100);
                }
                else
                {
                    Assert.NotEqual(
                        HostWindowCatalog.ScreenColor(
                            gridAdjacent),
                        HostWindowCatalog.ScreenColor(
                            gridLine));
                }
            }

            await pipe.DisposeAsync();
            await WaitUntilAsync(
                () => HostWindowCatalog
                    .Enumerate(host.Id).Count == 0);
            Assert.Equal(
                foreground,
                HostWindowCatalog.ForegroundWindow());

            await using var reconnected =
                await ConnectAsync();
            var visibleAgain = await SendAsync(
                ++sequence,
                PointerUiMode.GridHints,
                reconnected);
            Assert.True(visibleAgain.Applied);
            Assert.Equal(
                expectedBounds.Count,
                visibleAgain.OverlayWindowCount);
            await reconnected.WriteAsync(
                new byte[] { 1, 0 });
            await reconnected.FlushAsync();
            await WaitUntilAsync(
                () => HostWindowCatalog
                    .Enumerate(host.Id).Count == 0);

            await using var afterTimeout =
                await ConnectAsync();
            var hidden = await SendAsync(
                ++sequence,
                PointerUiMode.Hidden,
                afterTimeout);
            Assert.True(hidden.Applied);
            Assert.Null(hidden.Error);
            Assert.Equal(0, hidden.OverlayWindowCount);
            Assert.Empty(
                HostWindowCatalog.Enumerate(host.Id));
            Assert.Equal(
                foreground,
                HostWindowCatalog.ForegroundWindow());
        }
        finally
        {
            if (originalPointer is { } pointer)
            {
                HostWindowCatalog.SetPointer(pointer);
            }
            await StopAsync(host);
            await StopAsync(app);
            File.WriteAllText(
                Path.Combine(artifacts, "pointer-ui-host.log"),
                await hostOutput + await hostError);
            File.WriteAllText(
                Path.Combine(artifacts, "test-app.log"),
                await appOutput + await appError);
        }
    }

    private static async Task<PointerUiResponse> SendAsync(
        long sequence,
        PointerUiMode mode,
        Stream stream)
    {
        var request = new PointerUiRequest(
            PointerUiProtocol.CurrentVersion,
            sequence,
            mode);
        await PointerUiProtocol.WriteAsync(
            stream,
            request);
        var response =
            await PointerUiProtocol.ReadResponseAsync(
                stream)
            .WaitAsync(CommandTimeout);
        Assert.Equal(sequence, response.Sequence);
        Assert.Equal(mode, response.Mode);
        return response;
    }

    private static PixelRect ToScreen(
        PixelRect desktop,
        PixelRect local) =>
        local with
        {
            X = desktop.X + local.X,
            Y = desktop.Y + local.Y,
        };

    private static double Luminance(uint color)
    {
        var red = color & 0xFF;
        var green = (color >> 8) & 0xFF;
        var blue = (color >> 16) & 0xFF;
        return 0.2126 * red
            + 0.7152 * green
            + 0.0722 * blue;
    }

    private static async Task<NamedPipeClientStream>
        ConnectAsync()
    {
        var pipe = new NamedPipeClientStream(
            ".",
            PointerUiPipe.ForSession(
                Process.GetCurrentProcess().SessionId),
            PipeDirection.InOut,
            PipeOptions.Asynchronous
                | PipeOptions.CurrentUserOnly);
        try
        {
            await pipe.ConnectAsync(
                StartupTimeout,
                CancellationToken.None);
            return pipe;
        }
        catch
        {
            await pipe.DisposeAsync();
            throw;
        }
    }

    private static async Task WaitUntilAsync(
        Func<bool> condition)
    {
        using var timeout = new CancellationTokenSource(
            CommandTimeout);
        using var timer = new PeriodicTimer(
            TimeSpan.FromMilliseconds(16));
        while (!condition())
        {
            await timer.WaitForNextTickAsync(
                timeout.Token);
        }
    }

    private static async Task StopAsync(Process process)
    {
        if (!process.HasExited)
        {
            process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync();
        }
    }

    private static Process StartHost(
        string executable,
        string workingDirectory)
    {
        var startInfo = new ProcessStartInfo(executable)
        {
            WorkingDirectory = workingDirectory,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        return Process.Start(startInfo)
            ?? throw new InvalidOperationException(
                "Pointer UI host did not start.");
    }

    private static string PointerUiRoot() =>
        Path.GetFullPath(
            Path.Combine(
                AppContext.BaseDirectory,
                "..",
                "..",
                "..",
                "..",
                ".."));
}
