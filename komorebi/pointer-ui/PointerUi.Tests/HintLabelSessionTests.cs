namespace PointerUi.Tests;

public sealed class HintLabelSessionTests
{
    [Fact]
    public void Rescan_PreservesLabelsWhenLabelLengthIsUnchanged()
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
        Assert.Equal(
            HintLabelSequence.RequiredLength(first.Count),
            HintLabelSequence.RequiredLength(
                rescanned.Count));
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
    public void Rescan_ReleasesAbsentLabelAtExactCapacity()
    {
        var session = new HintLabelSession();
        var first = Candidates(26, start: 0);
        var second = first
            .Skip(1)
            .Append(Candidate(26))
            .ToList();

        var original = session.Assign(first);
        var rescanned = session.Assign(second);

        Assert.Equal(26, original.Count);
        Assert.Equal(26, rescanned.Count);
        Assert.All(
            rescanned,
            target => Assert.Single(target.Label));
    }

    [Fact]
    public void Assign_UsesFixedLengthAcrossAlphabetBoundary()
    {
        var session = new HintLabelSession();

        var labels26 = session.Assign(
            Candidates(26, start: 0));
        var labels27 = session.Assign(
            Candidates(27, start: 0));

        Assert.All(
            labels26,
            target => Assert.Single(target.Label));
        Assert.All(
            labels27,
            target => Assert.Equal(2, target.Label.Length));
        Assert.Equal(
            labels27.Count,
            labels27
                .Select(target => target.Label)
                .Distinct()
                .Count());
    }

    [Fact]
    public void LabelSequence_ExtendsPastTwoCharacters()
    {
        var labels = HintLabelSequence.Generate()
            .Take(703)
            .ToList();

        Assert.Equal(703, labels.Distinct().Count());
        Assert.Equal(2, labels[701].Length);
        Assert.Equal(3, labels[702].Length);
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

    private static IReadOnlyList<TargetCandidate> Candidates(
        int count,
        int start) =>
        Enumerable.Range(start, count)
            .Select(Candidate)
            .ToList();

    private static TargetCandidate Candidate(int index)
    {
        var window = new WindowFixture(
            "test",
            "test.window",
            new PixelRect(0, 0, 100, 100),
            96,
            true,
            []);
        var target = new TargetFixture(
            $"target-{index}",
            "Button",
            $"Target {index}",
            ["Window", $"Button#{index}"],
            new PixelRect(0, 0, 10, 10),
            SemanticActionKind.Invoke);
        return new TargetCandidate(
            window,
            target,
            LogicalTargetIdentity.Create(window, target));
    }

    private static DesktopFixture LoadUiHints() =>
        FixtureLoader.Load(Path.Combine(
            AppContext.BaseDirectory,
            "Fixtures",
            "ui-hints.json"));
}
