namespace PointerUi.Tests;

public sealed class FakeActionPlannerTests
{
    [Fact]
    public void BackgroundPointOnly_IsRejectedWithoutInvoking()
    {
        var target = BackgroundTarget(SemanticActionKind.Invoke);

        var action = FakeActionPlanner.Plan(target, pointOnly: true);

        Assert.Equal(FakeActionKind.Reject, action.Kind);
        Assert.Contains("foreground", action.Reason);
    }

    [Fact]
    public void BackgroundTargetWithoutSemanticAction_IsRejected()
    {
        var target = BackgroundTarget(SemanticActionKind.None);

        var action = FakeActionPlanner.Plan(target, pointOnly: false);

        Assert.Equal(FakeActionKind.Reject, action.Kind);
        Assert.Contains("semantic", action.Reason);
    }

    private static TargetSnapshot BackgroundTarget(
        SemanticActionKind semanticAction) =>
        new(
            new LogicalTargetId("target-v1-test"),
            "A",
            "background.exe",
            "background.main",
            false,
            96,
            "target",
            "Button",
            "Target",
            new PixelRect(10, 10, 20, 20),
            semanticAction);
}
