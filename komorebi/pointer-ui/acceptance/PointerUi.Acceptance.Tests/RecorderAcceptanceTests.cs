using System.Diagnostics;
using PointerUi.Acceptance.Runner;

namespace PointerUi.Acceptance.Tests;

public sealed class RecorderAcceptanceTests
{
    private static readonly TimeSpan StartupTimeout =
        TimeSpan.FromSeconds(15);
    private static readonly TimeSpan RecorderTimeout =
        TimeSpan.FromSeconds(30);

    [Fact]
    [Trait("Category", "VmAcceptance")]
    public async Task AllWindowsScenario_ProducesKnownFixture()
    {
        var artifactsRoot =
            VmAcceptanceGuard.RequireArtifactsDirectory();
        var artifacts = Path.Combine(
            artifactsRoot,
            "all-windows");
        Directory.CreateDirectory(artifacts);
        var readyFile = Path.Combine(artifacts, "ready.txt");
        var commandFile = Path.Combine(
            artifacts,
            "command.txt");
        var acknowledgementFile = Path.Combine(
            artifacts,
            "ack.txt");
        var firstFixturePath = Path.Combine(
            artifacts,
            "desktop-before.json");
        var secondFixturePath = Path.Combine(
            artifacts,
            "desktop-after.json");
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

        try
        {
            await FileWaiter.WaitForFileAsync(
                readyFile,
                StartupTimeout);
            await RunRecorderAsync(
                pointerUiRoot,
                firstFixturePath,
                "vm-all-windows-before");
            var firstFixture = FixtureLoader.Load(
                firstFixturePath);
            AssertScenario(firstFixture);
            var firstIds = IdsByAutomation(firstFixture);

            var commandTemp = $"{commandFile}.tmp";
            File.WriteAllText(commandTemp, "mutate");
            File.Move(commandTemp, commandFile);
            await FileWaiter.WaitForFileAsync(
                acknowledgementFile,
                StartupTimeout);
            await RunRecorderAsync(
                pointerUiRoot,
                secondFixturePath,
                "vm-all-windows-after");
            var secondFixture = FixtureLoader.Load(
                secondFixturePath);
            AssertScenario(secondFixture);
            AssertStableIds(
                firstIds,
                IdsByAutomation(secondFixture));

            var diagnostics = File.ReadAllText(
                Path.Combine(
                    artifacts,
                    "desktop-before.diagnostics.json"));
            Assert.Contains(
                "ambiguous-logical-target",
                diagnostics);
            Assert.Contains(
                "target-missing-logical-identity",
                diagnostics);

            var output = FixturePipeline.Prepare(
                secondFixture,
                new HintLabelSession());
            File.WriteAllText(
                Path.Combine(artifacts, "scene.json"),
                DiagnosticJson.Serialize(output));
            File.WriteAllBytes(
                Path.Combine(artifacts, "frame.png"),
                WpfSceneRenderer.RenderPng(output.Scene));
        }
        finally
        {
            if (!app.HasExited)
            {
                app.Kill(entireProcessTree: true);
                await app.WaitForExitAsync();
            }
            File.WriteAllText(
                Path.Combine(artifacts, "test-app.log"),
                await appOutput + await appError);
        }
    }

    private static void AssertScenario(
        DesktopFixture fixture)
    {
        Assert.Equal(2, fixture.Windows.Count);
        var primary = Window(
            fixture,
            "acceptance-primary");
        var background = Window(
            fixture,
            "acceptance-background");
        Assert.True(primary.IsForeground);
        Assert.False(background.IsForeground);
        Assert.Contains(
            primary.Targets,
            target => target.AutomationId == "save"
                && target.SemanticAction
                    is SemanticActionKind.Invoke);
        Assert.Contains(
            primary.Targets,
            target => target.AutomationId == "editor"
                && target.SemanticAction
                    is SemanticActionKind.None);
        Assert.Contains(
            primary.Targets,
            target => target.AutomationId == "general-tab"
                && target.SemanticAction
                    is SemanticActionKind.Select);
        Assert.Contains(
            background.Targets,
            target => target.AutomationId == "mute"
                && target.SemanticAction
                    is SemanticActionKind.Toggle);
        Assert.DoesNotContain(
            background.Targets,
            target => target.AutomationId
                == "background-editor");
        Assert.DoesNotContain(
            fixture.Windows.SelectMany(
                window => window.Targets),
            target => target.AutomationId == "duplicate");
    }

    private static Dictionary<string, LogicalTargetId>
        IdsByAutomation(DesktopFixture fixture) =>
        fixture.Windows
            .SelectMany(window => window.Targets.Select(
                target => new
                {
                    Window = window,
                    Target = target,
                }))
            .Where(item =>
                !string.IsNullOrWhiteSpace(
                    item.Target.AutomationId))
            .ToDictionary(
                item => item.Target.AutomationId,
                item => LogicalTargetIdentity.Create(
                    item.Window,
                    item.Target),
                StringComparer.Ordinal);

    private static void AssertStableIds(
        IReadOnlyDictionary<string, LogicalTargetId> expected,
        IReadOnlyDictionary<string, LogicalTargetId> actual)
    {
        Assert.Equal(
            expected.Keys.Order(StringComparer.Ordinal),
            actual.Keys.Order(StringComparer.Ordinal));
        foreach (var key in expected.Keys)
        {
            Assert.Equal(expected[key], actual[key]);
        }
    }

    private static async Task RunRecorderAsync(
        string pointerUiRoot,
        string fixturePath,
        string fixtureName)
    {
        var recorder = await DotnetProcess.RunAsync(
            pointerUiRoot,
            RecorderTimeout,
            "run",
            "--project",
            Path.Combine(
                pointerUiRoot,
                "PointerUi.Recorder",
                "PointerUi.Recorder.csproj"),
            "-c",
            "Release",
            "--no-build",
            "--",
            "--allow-live-desktop-capture",
            "--output",
            fixturePath,
            "--name",
            fixtureName,
            "--process",
            "PointerUi.TestApp.exe",
            "--overwrite");
        Assert.True(
            recorder.ExitCode == 0,
            $"{recorder.Output}{Environment.NewLine}{recorder.Error}");
    }

    private static WindowFixture Window(
        DesktopFixture fixture,
        string automationId) =>
        fixture.Windows.Single(window =>
            window.WindowRole.Contains(
                $"#{automationId}",
                StringComparison.Ordinal));

    private static string PointerUiRoot(
        [System.Runtime.CompilerServices.CallerFilePath]
        string sourceFile = "") =>
        Path.GetFullPath(Path.Combine(
            Path.GetDirectoryName(sourceFile)
                ?? throw new InvalidOperationException(
                    "Acceptance test source path is unavailable."),
            "..",
            ".."));
}
