namespace PointerUi.Tests;

public sealed class HintInputSessionTests
{
    [Fact]
    public void SingleKey_CompletesSemanticTarget()
    {
        var session = new HintInputSession(
            Targets(3));

        var result = session.Press("a", pointOnly: false);

        Assert.Equal(HintInputStatus.Completed, result.Status);
        Assert.Equal("A", result.Prefix);
        Assert.Equal("A", result.Target?.Label);
        Assert.Equal(
            FakeActionKind.InvokeSemantic,
            result.Action?.Kind);
    }

    [Fact]
    public void MoreThanAlphabet_UsesPrefixFreeLabels()
    {
        var session = new HintInputSession(
            Targets(27));

        var prefix = session.Press(
            "a",
            pointOnly: false);
        var completed = session.Press(
            "a",
            pointOnly: false);

        Assert.Equal(HintInputStatus.Active, prefix.Status);
        Assert.Equal("A", prefix.Prefix);
        Assert.Equal(
            HintInputStatus.Completed,
            completed.Status);
        Assert.Equal("AA", completed.Target?.Label);
    }

    [Fact]
    public void InvalidContinuation_DoesNotLosePrefix()
    {
        var targets = Targets(27);
        var session = new HintInputSession(targets);
        session.Press("s", pointOnly: false);

        var rejected = session.Press(
            "m",
            pointOnly: false);

        Assert.False(rejected.Accepted);
        Assert.Equal("S", rejected.Prefix);
    }

    [Fact]
    public void Backspace_RemovesLastPrefixKey()
    {
        var session = new HintInputSession(
            Targets(27));
        session.Press("a", pointOnly: false);

        var result = session.Backspace();

        Assert.True(result.Accepted);
        Assert.Equal(string.Empty, result.Prefix);
    }

    [Fact]
    public void PointOnly_PlansPointerPlacement()
    {
        var session = new HintInputSession(
            Targets(1));

        var result = session.Press("a", pointOnly: true);

        Assert.Equal(
            FakeActionKind.MovePointer,
            result.Action?.Kind);
    }

    [Fact]
    public void Cancel_EndsSession()
    {
        var session = new HintInputSession(
            Targets(1));

        var result = session.Cancel();

        Assert.Equal(HintInputStatus.Cancelled, result.Status);
        Assert.Throws<InvalidOperationException>(
            () => session.Press("a", pointOnly: false));
    }

    [Fact]
    public void Completion_RejectsFurtherInput()
    {
        var session = new HintInputSession(
            Targets(1));
        session.Press("a", pointOnly: false);

        Assert.Throws<InvalidOperationException>(
            () => session.Press("a", pointOnly: false));
        Assert.Throws<InvalidOperationException>(
            session.Backspace);
        Assert.Throws<InvalidOperationException>(
            session.Cancel);
    }

    private static IReadOnlyList<TargetSnapshot> Targets(
        int count)
    {
        var labels = HintLabelSequence.Generate(
                HintLabelSequence.RequiredLength(count))
            .Take(count)
            .ToList();
        return labels.Select((label, index) =>
            new TargetSnapshot(
                new LogicalTargetId(
                    $"target-v1-{index:D16}"),
                label,
                "test",
                "window",
                true,
                96,
                $"target-{index}",
                "Button",
                $"Target {index}",
                new PixelRect(
                    index * 10,
                    0,
                    10,
                    10),
                SemanticActionKind.Invoke))
            .ToList();
    }
}
