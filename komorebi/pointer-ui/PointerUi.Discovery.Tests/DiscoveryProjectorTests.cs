namespace PointerUi.Discovery.Tests;

public sealed class DiscoveryProjectorTests
{
    [Fact]
    public void Project_UsesSemanticBackgroundPolicyAndPerWindowDpi()
    {
        var foreground = Window(
            "foreground",
            "terminal.exe",
            144,
            isForeground: true,
            Element(
                "root",
                "Window",
                "Terminal",
                "TerminalClass",
                children:
                [
                    Element(
                        "",
                        "Document",
                        "Terminal content",
                        "DocumentClass",
                        keyboardFocusable: true),
                ]));
        var background = Window(
            "background",
            "teams.exe",
            192,
            isForeground: false,
            Element(
                "root",
                "Window",
                "Teams",
                "TeamsClass",
                children:
                [
                    Element(
                        "mute",
                        "Button",
                        "Mute",
                        "ButtonClass",
                        semanticAction: SemanticActionKind.Toggle),
                    Element(
                        "",
                        "Document",
                        "Transcript",
                        "DocumentClass",
                        keyboardFocusable: true),
                ]));

        var projection = DiscoveryProjector.Project(
            Capture(foreground, background),
            "all-windows",
            new WindowRoleSession());

        Assert.Empty(projection.Diagnostics);
        var windows = projection.Fixture.Windows
            .ToDictionary(window => window.ProcessKey);
        Assert.Equal(144, windows["terminal.exe"].Dpi);
        Assert.Equal(192, windows["teams.exe"].Dpi);
        Assert.Single(windows["terminal.exe"].Targets);
        Assert.Equal(
            "Terminal content",
            windows["terminal.exe"].Targets[0].Name);
        Assert.Single(windows["teams.exe"].Targets);
        Assert.Equal("Mute", windows["teams.exe"].Targets[0].Name);
    }

    [Fact]
    public void Project_ExcludesAmbiguousLogicalTargets()
    {
        var duplicate = Element(
            "duplicate",
            "Button",
            "Same",
            "ButtonClass",
            semanticAction: SemanticActionKind.Invoke);
        var window = Window(
            "window",
            "app.exe",
            96,
            isForeground: true,
            Element(
                "root",
                "Window",
                "App",
                "AppClass",
                children: [duplicate, duplicate]));

        var projection = DiscoveryProjector.Project(
            Capture(window),
            "ambiguous",
            new WindowRoleSession());

        Assert.Empty(projection.Fixture.Windows[0].Targets);
        var diagnostic = Assert.Single(projection.Diagnostics);
        Assert.Equal("ambiguous-logical-target", diagnostic.Code);
        Assert.Contains("Excluded 2", diagnostic.Detail);
    }

    [Fact]
    public void Project_ExcludesNamelessActionableTarget()
    {
        var window = Window(
            "window",
            "app.exe",
            96,
            isForeground: true,
            Element(
                "root",
                "Window",
                "App",
                "AppClass",
                children:
                [
                    Element(
                        "",
                        "Button",
                        "",
                        "ButtonClass",
                        semanticAction: SemanticActionKind.Invoke),
                ]));

        var projection = DiscoveryProjector.Project(
            Capture(window),
            "nameless",
            new WindowRoleSession());

        Assert.Empty(projection.Fixture.Windows[0].Targets);
        var diagnostic = Assert.Single(projection.Diagnostics);
        Assert.Equal(
            "target-missing-logical-identity",
            diagnostic.Code);
    }

    [Fact]
    public void WindowRoles_SurviveRescanOrderAndDuplicateWindows()
    {
        var first = Window(
            "session-b",
            "app.exe",
            96,
            false,
            Element("main", "Window", "App", "AppClass"));
        var second = Window(
            "session-a",
            "app.exe",
            96,
            true,
            Element("main", "Window", "App", "AppClass"));
        var session = new WindowRoleSession();

        var initial = session.Assign([first, second])
            .ToDictionary();
        var rescanned = session.Assign([second, first])
            .ToDictionary();

        Assert.Equal(initial["session-a"], rescanned["session-a"]);
        Assert.Equal(initial["session-b"], rescanned["session-b"]);
        Assert.NotEqual(
            initial["session-a"],
            initial["session-b"]);
        Assert.DoesNotContain(
            initial.Values,
            role => role.EndsWith("@1", StringComparison.Ordinal));
    }

    [Fact]
    public void RootTitleChange_DoesNotChangeTargetIdentity()
    {
        var session = new WindowRoleSession();
        var first = DiscoveryProjector.Project(
            Capture(Window(
                "session",
                "app.exe",
                96,
                true,
                Element(
                    "root",
                    "Window",
                    "Document A",
                    "AppClass",
                    children:
                    [
                        Element(
                            "save",
                            "Button",
                            "Save",
                            "ButtonClass",
                            semanticAction:
                                SemanticActionKind.Invoke),
                    ]))),
            "first",
            session);
        var second = DiscoveryProjector.Project(
            Capture(Window(
                "session",
                "app.exe",
                96,
                true,
                Element(
                    "root",
                    "Window",
                    "Document B",
                    "AppClass",
                    children:
                    [
                        Element(
                            "save",
                            "Button",
                            "Save",
                            "ButtonClass",
                            semanticAction:
                                SemanticActionKind.Invoke),
                    ]))),
            "second",
            session);

        var firstWindow = first.Fixture.Windows[0];
        var secondWindow = second.Fixture.Windows[0];
        Assert.Equal(
            LogicalTargetIdentity.Create(
                firstWindow,
                firstWindow.Targets[0]),
            LogicalTargetIdentity.Create(
                secondWindow,
                secondWindow.Targets[0]));
    }

    private static DesktopCapture Capture(
        params WindowCapture[] windows) =>
        new(
            new PixelRect(0, 0, 1920, 1080),
            windows);

    private static WindowCapture Window(
        string sessionKey,
        string processKey,
        double dpi,
        bool isForeground,
        ElementCapture root) =>
        new(
            sessionKey,
            processKey,
            new PixelRect(0, 0, 800, 600),
            dpi,
            isForeground,
            root);

    private static ElementCapture Element(
        string automationId,
        string controlType,
        string name,
        string className,
        bool keyboardFocusable = false,
        SemanticActionKind semanticAction = SemanticActionKind.None,
        IReadOnlyList<ElementCapture>? children = null) =>
        new(
            automationId,
            controlType,
            name,
            className,
            new PixelRect(10, 10, 100, 40),
            false,
            true,
            true,
            keyboardFocusable,
            semanticAction,
            children ?? []);
}
