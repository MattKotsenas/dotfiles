namespace PointerUi.Tests;

public sealed class HintLabelSessionTests
{
    [Fact]
    public void Rescan_PreservesLabelsWhenOrderAndCountChange()
    {
        var fixture = LoadUiHints();
        var session = new HintLabelSession();
        var first = PrepareCandidates(fixture);
        var firstLabels = session.Assign(first)
            .ToDictionary(target => target.LogicalId, target => target.Label);

        var addedTarget = new TargetFixture(
            "participants-button",
            "Button",
            "Participants",
            ["Root", "MeetingControls", "Participants"],
            new PixelRect(710, 438, 52, 40),
            SemanticActionKind.Invoke);
        var changedWindows = fixture.Windows
            .Reverse()
            .Select(window => window.WindowRole == "teams.main"
                ? window with
                {
                    Targets = window.Targets
                        .Prepend(addedTarget)
                        .ToList(),
                }
                : window)
            .ToList();
        var rescanned = PrepareCandidates(
            fixture with { Windows = changedWindows });
        var secondLabels = session.Assign(rescanned)
            .ToDictionary(target => target.LogicalId, target => target.Label);

        foreach (var existing in firstLabels)
        {
            Assert.Equal(existing.Value, secondLabels[existing.Key]);
        }
        Assert.Equal(
            firstLabels.Count + 1,
            secondLabels.Count);
    }

    [Fact]
    public void Identity_IgnoresGeometryAndMutableNameWhenAutomationIdExists()
    {
        var fixture = LoadUiHints();
        var window = fixture.Windows[0];
        var target = window.Targets[0];
        var original = LogicalTargetIdentity.Create(window, target);
        var changed = LogicalTargetIdentity.Create(
            window with
            {
                Bounds = new PixelRect(100, 100, 700, 500),
                Dpi = 192,
            },
            target with
            {
                Name = "PowerShell (Administrator)",
                Bounds = new PixelRect(200, 200, 220, 50),
            });

        Assert.Equal(original, changed);
    }

    [Fact]
    public void Identity_UsesSemanticFallbackWhenAutomationIdIsMissing()
    {
        var fixture = LoadUiHints();
        var window = fixture.Windows[0];
        var target = window.Targets.Single(
            candidate => candidate.AutomationId.Length == 0);
        var original = LogicalTargetIdentity.Create(window, target);
        var renamed = LogicalTargetIdentity.Create(
            window,
            target with { Name = "Different document" });

        Assert.NotEqual(original, renamed);
    }

    [Fact]
    public void Identity_DistinguishesReusedAutomationIdsByHierarchy()
    {
        var fixture = LoadUiHints();
        var window = fixture.Windows[0];
        var target = window.Targets[0];
        var original = LogicalTargetIdentity.Create(window, target);
        var sibling = LogicalTargetIdentity.Create(
            window,
            target with
            {
                Hierarchy = ["Root", "OtherTabRow", "PowerShell"],
            });

        Assert.NotEqual(original, sibling);
    }

    private static IReadOnlyList<TargetCandidate> PrepareCandidates(
        DesktopFixture fixture) =>
        fixture.Windows
            .SelectMany(window => window.Targets.Select(target =>
                new TargetCandidate(
                    window,
                    target,
                    LogicalTargetIdentity.Create(window, target))))
            .ToList();

    private static DesktopFixture LoadUiHints() =>
        FixtureLoader.Load(Path.Combine(
            AppContext.BaseDirectory,
            "Fixtures",
            "ui-hints.json"));
}
