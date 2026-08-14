namespace PointerUi.Tests;

public sealed class OverlaySnapshotTests
{
    [Fact]
    public Task IndicatorScene_MatchesApprovedContract() =>
        VerifySceneAsync("indicator.json", "IndicatorScene");

    [Fact]
    public Task IndicatorFrame_MatchesApprovedRendering() =>
        VerifyFrameAsync("indicator.json", "IndicatorFrame");

    [Fact]
    public Task UiHintScene_MatchesApprovedContract() =>
        VerifySceneAsync("ui-hints.json", "UiHintScene");

    [Fact]
    public Task UiHintFrame_MatchesApprovedRendering() =>
        VerifyFrameAsync("ui-hints.json", "UiHintFrame");

    [Fact]
    public Task GridHintScene_MatchesApprovedContract() =>
        VerifySceneAsync("grid-hints.json", "GridHintScene");

    [Fact]
    public Task GridHintFrame_MatchesApprovedRendering() =>
        VerifyFrameAsync("grid-hints.json", "GridHintFrame");

    [Fact]
    public Task UiHintActions_MatchApprovedSafetyPolicy()
    {
        var output = Prepare("ui-hints.json");
        var actions = output.Targets
            .Select(target => new ActionPolicySnapshot(
                new ActionTargetSnapshot(
                    target.ProcessKey,
                    target.Name,
                    target.IsForeground),
                FakeActionPlanner.Plan(target, pointOnly: false),
                FakeActionPlanner.Plan(target, pointOnly: true)))
            .ToList();

        return Verifier.Verify(
                DiagnosticJson.Serialize(actions),
                "json")
            .UseFileName("UiHintActions");
    }

    private static Task VerifySceneAsync(
        string fixtureName,
        string snapshotName) =>
        Verifier.Verify(
                DiagnosticJson.Serialize(Prepare(fixtureName)),
                "json")
            .UseFileName(snapshotName);

    private static Task VerifyFrameAsync(
        string fixtureName,
        string snapshotName)
    {
        var output = Prepare(fixtureName);
        var png = WpfSceneRenderer.RenderPng(output.Scene);
        return Verifier.Verify(new MemoryStream(png), "png")
            .UseFileName(snapshotName);
    }

    private static FixtureOutput Prepare(string fixtureName)
    {
        var fixture = FixtureLoader.Load(Path.Combine(
            AppContext.BaseDirectory,
            "Fixtures",
            fixtureName));
        return FixturePipeline.Prepare(fixture, new HintLabelSession());
    }
}
