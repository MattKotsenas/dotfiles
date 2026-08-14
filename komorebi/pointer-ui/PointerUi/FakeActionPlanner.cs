namespace PointerUi;

public enum FakeActionKind
{
    InvokeSemantic,
    MovePointer,
    CoordinateClick,
    Reject,
}

public sealed record FakeAction(
    FakeActionKind Kind,
    LogicalTargetId LogicalTargetId,
    string Label,
    SemanticActionKind SemanticAction,
    PixelPoint? Point,
    string? Reason);

public sealed record ActionTargetSnapshot(
    string ProcessKey,
    string Name,
    bool IsForeground);

public sealed record ActionPolicySnapshot(
    ActionTargetSnapshot Target,
    FakeAction Activate,
    FakeAction PointOnly);

public static class FakeActionPlanner
{
    public static FakeAction Plan(
        TargetSnapshot target,
        bool pointOnly)
    {
        if (!target.IsForeground && pointOnly)
        {
            return Reject(
                target,
                "Point-only placement is restricted to the foreground window.");
        }

        if (!target.IsForeground)
        {
            return target.SemanticAction is not SemanticActionKind.None
                ? Invoke(target)
                : Reject(
                    target,
                    "Background targets require a semantic UI Automation action.");
        }

        if (pointOnly)
        {
            return new FakeAction(
                FakeActionKind.MovePointer,
                target.LogicalId,
                target.Label,
                target.SemanticAction,
                target.Bounds.Center,
                null);
        }

        return target.SemanticAction is not SemanticActionKind.None
            ? Invoke(target)
            : new FakeAction(
                FakeActionKind.CoordinateClick,
                target.LogicalId,
                target.Label,
                SemanticActionKind.None,
                target.Bounds.Center,
                null);
    }

    private static FakeAction Invoke(TargetSnapshot target) =>
        new(
            FakeActionKind.InvokeSemantic,
            target.LogicalId,
            target.Label,
            target.SemanticAction,
            null,
            null);

    private static FakeAction Reject(
        TargetSnapshot target,
        string reason) =>
        new(
            FakeActionKind.Reject,
            target.LogicalId,
            target.Label,
            target.SemanticAction,
            null,
            reason);
}
