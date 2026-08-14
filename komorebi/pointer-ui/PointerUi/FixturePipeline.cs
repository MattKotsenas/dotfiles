namespace PointerUi;

public static class FixturePipeline
{
    public static FixtureOutput Prepare(
        DesktopFixture fixture,
        HintLabelSession labelSession)
    {
        var candidates = fixture.Windows
            .SelectMany(window => window.Targets
                .Where(target => window.IsForeground
                    || target.SemanticAction is not SemanticActionKind.None)
                .Select(target =>
                    new TargetCandidate(
                        window,
                        target,
                        LogicalTargetIdentity.Create(window, target))))
            .ToList();
        var labeledTargets = labelSession.Assign(candidates);
        var scene = OverlaySceneBuilder.Build(fixture, labeledTargets);
        var targets = labeledTargets
            .Select(target => new TargetSnapshot(
                target.LogicalId,
                target.Label,
                target.Window.ProcessKey,
                target.Window.WindowRole,
                target.Window.IsForeground,
                target.Target.AutomationId,
                target.Target.ControlType,
                target.Target.Name,
                target.Target.Bounds,
                target.Target.SemanticAction))
            .OrderBy(target => target.Label, StringComparer.Ordinal)
            .ToList();

        return new FixtureOutput(scene, targets);
    }
}
