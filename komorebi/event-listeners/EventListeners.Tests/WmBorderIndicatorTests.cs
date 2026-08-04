using Microsoft.Extensions.Logging.Abstractions;

namespace EventListeners.Tests;

public class WmBorderIndicatorTests
{
    private static readonly BorderWindowKind[] AllKinds =
        [BorderWindowKind.Single, BorderWindowKind.Stack, BorderWindowKind.Monocle, BorderWindowKind.Floating];

    private static WmBorderIndicator CreateRule(out FakeWindowAction action)
    {
        action = new FakeWindowAction();
        return new WmBorderIndicator(NullLogger<WmBorderIndicator>.Instance, action);
    }

    private static Task Settle(WmBorderIndicator rule) => rule.LastRecolour ?? Task.CompletedTask;

    private static void Layer(WmBorderIndicator rule, string layer) =>
        rule.ProcessEvent(new KanataLayerChangeEvent(layer));

    /// <summary>Every arrangement painted the WM colour, sorted: Task.WhenAll does not order them.</summary>
    private static IEnumerable<string> PaintedWm() =>
        AllKinds.Select(k => Write(k, WmBorderIndicator.WmColour)).Order();

    /// <summary>Every arrangement painted back to its own resting colour.</summary>
    private static IEnumerable<string> PaintedResting() =>
        AllKinds.Select(k => Write(k, WmBorderIndicator.RestingColour(k))).Order();

    private static string Write(BorderWindowKind kind, BorderColour c) => $"{kind} {c.R},{c.G},{c.B}";

    [Fact]
    public async Task EnteringAWmMode_PaintsEveryArrangement()
    {
        var rule = CreateRule(out var action);
        Assert.Empty(action.BorderWrites); // precondition: nothing painted yet

        Layer(rule, "wm");
        await Settle(rule);

        // Stacking, monocling or floating mid-mode must not reveal an unpainted border.
        Assert.Equal(PaintedWm(), action.BorderWrites.Order());
    }

    [Fact]
    public async Task LeavingWmMode_RestoresEachArrangementToItsOwnColour()
    {
        // komorebi gives each arrangement a different resting colour. Writing one
        // colour to all of them would leave stacked and monocled windows wrong
        // until the configuration is reloaded.
        var rule = CreateRule(out var action);

        Layer(rule, "wm");
        await Settle(rule);
        Assert.Equal(PaintedWm(), action.BorderWrites.Order()); // precondition

        Layer(rule, "base-default");
        await Settle(rule);

        Assert.Equal(PaintedResting(), action.BorderWrites.Skip(AllKinds.Length).Order());
    }

    [Fact]
    public void EveryArrangementRestsOnADistinctColour()
    {
        // If two shared one, restoring could not be told apart from miscolouring.
        var resting = AllKinds.Select(WmBorderIndicator.RestingColour).ToList();

        Assert.Equal(resting.Count, resting.Distinct().Count());
        Assert.DoesNotContain(WmBorderIndicator.WmColour, resting);
    }

    [Fact]
    public async Task TheFirstLayerChangeAlwaysPaints_EvenWhenItIsATypingLayer()
    {
        // A restart can leave komorebi holding a mode colour this process never set.
        var rule = CreateRule(out var action);

        Layer(rule, "base-default");
        await Settle(rule);

        Assert.Equal(PaintedResting(), action.BorderWrites.Order());
    }

    [Fact]
    public async Task RepeatedLayerChangesOfTheSameColour_PaintOnce()
    {
        // Layer changes land on every CAP press; most do not move the border.
        var rule = CreateRule(out var action);

        Layer(rule, "wm-focus");
        await Settle(rule);
        Assert.Equal(AllKinds.Length, action.BorderWrites.Count); // precondition: painted once

        Layer(rule, "wm-move");
        await Settle(rule);
        Layer(rule, "wm-stack");
        await Settle(rule);

        Assert.Equal(AllKinds.Length, action.BorderWrites.Count);
    }

    [Fact]
    public async Task ABurstOfLayerChanges_SkipsTheColoursNoLongerWanted()
    {
        // Replaying every intermediate colour would flash the resting colour while
        // the keyboard is already back in a WM mode.
        var rule = CreateRule(out var action);
        action.BlockBorder = new TaskCompletionSource();

        Layer(rule, "wm");
        var loop = rule.LastRecolour!;
        Assert.False(loop.IsCompleted); // precondition: the first paint is in flight

        Layer(rule, "base-default");
        Layer(rule, "wm-focus");

        action.BlockBorder.SetResult();
        await loop;

        // The intermediate resting paint is dropped: the screen already agrees.
        Assert.Equal(PaintedWm(), action.BorderWrites.Order());
    }

    [Fact]
    public async Task AFailedPaint_IsRetriedOnTheNextLayerChange()
    {
        // Treating a failed write as done would strand a WM colour on screen while
        // the user is typing.
        var rule = CreateRule(out var action);
        action.BorderWriteSucceeds = false;

        Layer(rule, "wm");
        await Settle(rule);
        Assert.Equal(PaintedWm(), action.BorderWrites.Order()); // precondition: attempted once

        action.BorderWriteSucceeds = true;
        Layer(rule, "wm-focus");
        await Settle(rule);

        Assert.Equal(PaintedWm(), action.BorderWrites.Skip(AllKinds.Length).Order());
    }

    [Theory]
    [InlineData("wm")]
    [InlineData("wm-focus")]
    [InlineData("wm-move")]
    [InlineData("wm-stack")]
    [InlineData("wm-resize")]
    [InlineData("wm-workspace")]
    [InlineData("wm-edge")]
    [InlineData("wm-toggle")]
    [InlineData("wm-focus-toggle")]
    public async Task AWmLayer_PaintsTheWmColour(string layer)
    {
        var rule = CreateRule(out var action);

        Layer(rule, layer);
        await Settle(rule);

        Assert.Equal(PaintedWm(), action.BorderWrites.Order());
    }

    [Theory]
    [InlineData("base-default")]
    [InlineData("base-terminal")]
    [InlineData("base-edge")]
    [InlineData("base-teams")]
    [InlineData("base-edge-toggle")]
    public async Task ATypingLayer_PaintsTheRestingColours(string layer)
    {
        var rule = CreateRule(out var action);

        Layer(rule, layer);
        await Settle(rule);

        Assert.Equal(PaintedResting(), action.BorderWrites.Order());
    }

    [Fact]
    public async Task ANonLayerEvent_PaintsNothing()
    {
        var rule = CreateRule(out var action);

        rule.ProcessEvent(new KomorebiWindowEvent("FocusChange", null, null));
        await Settle(rule);

        Assert.Empty(action.BorderWrites);
    }
}
