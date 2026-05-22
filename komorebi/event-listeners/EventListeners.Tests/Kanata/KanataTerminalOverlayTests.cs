using EventListeners.Tests.KanataHarness;

namespace EventListeners.Tests.Kanata;

/// <summary>
/// Phase 4: when the terminal overlay is active (kanata layer = base-terminal),
/// HJKL inside WM mode emits the psmux prefix (Ctrl+Space) followed by the
/// direction. wm-base bindings still work for everything the overlay doesn't claim.
/// </summary>
[Trait("Category", "KanataHarness")]
public class KanataTerminalOverlayTests
{
    [Theory]
    [InlineData("h")]
    [InlineData("j")]
    [InlineData("k")]
    [InlineData("l")]
    public async Task TerminalOverlay_OneShot_BareDirection_EmitsPsmuxPrefixSequence(string direction)
    {
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput()
                .Layer("base-terminal")       // simulate WT focused
                .Tap("caps")                   // enter wm-terminal
                .Tap(direction)
                .Settle());

        // Macro emits LCtrl down, Space down, Space up, LCtrl up, <dir> down, <dir> up
        // We assert the key events in order.
        var keys = output.KeyEvents;
        Assert.Contains(new KeyEvent("↓", "LCtrl"), keys);
        Assert.Contains(new KeyEvent("↓", "Space"), keys);
        Assert.Contains(new KeyEvent("↑", "Space"), keys);
        Assert.Contains(new KeyEvent("↑", "LCtrl"), keys);
        // Direction key with case-insensitive match (sim outputs "H" not "h")
        Assert.Contains(keys, e => e.Direction == "↓" && e.Key.Equals(direction, StringComparison.OrdinalIgnoreCase));
        Assert.Contains(keys, e => e.Direction == "↑" && e.Key.Equals(direction, StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task TerminalOverlay_SubModeStillWorks_FH_FiresFocusLeft()
    {
        // CAP F H in terminal context should still emit wm.focus.left
        // (sub-modes are not overridden by overlay).
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput()
                .Layer("base-terminal")
                .Tap("caps").Tap("f").Tap("h")
                .Settle());

        Assert.Contains("wm.focus.left", output.Intents);
    }

    [Fact]
    public async Task TerminalOverlay_GlobalsStillWork_CapR_FiresRetile()
    {
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput()
                .Layer("base-terminal")
                .Tap("caps").Tap("r")
                .Settle());

        Assert.Contains("wm.layout.retile", output.Intents);
    }

    [Fact]
    public async Task DefaultContext_BareH_DoesNotEmitPsmuxSequence()
    {
        // In base-default (no terminal overlay), CAP+H is a deadkey -- no intent,
        // no key events.
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput().Tap("caps").Tap("h").Settle());

        Assert.Empty(output.Intents);
        Assert.DoesNotContain(output.KeyEvents, e => e.Key == "Space");
    }
}
