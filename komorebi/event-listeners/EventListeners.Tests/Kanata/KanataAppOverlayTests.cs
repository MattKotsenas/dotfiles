using EventListeners.Tests.KanataHarness;

namespace EventListeners.Tests.Kanata;

/// <summary>
/// Phase 6/7: overlays for Edge and Teams emit macros to the focused window.
/// </summary>
[Trait("Category", "KanataHarness")]
public class KanataAppOverlayTests
{
    // ---------------- Edge ----------------

    [Fact]
    public async Task EdgeOverlay_NewTab_EmitsCtrlT()
    {
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput()
                .Layer("base-edge")
                .Tap("caps")
                .Tap("t")
                .Settle());

        // Chord: Ctrl down, T down, T up, Ctrl up
        Assert.Contains(new KeyEvent("↓", "LCtrl"), output.KeyEvents);
        Assert.Contains(output.KeyEvents, e => e.Direction == "↓" && e.Key.Equals("T", StringComparison.OrdinalIgnoreCase));
        Assert.Contains(new KeyEvent("↑", "LCtrl"), output.KeyEvents);
    }

    [Fact]
    public async Task EdgeOverlay_VimiumReset_EmitsCtrlLEscEsc()
    {
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput()
                .Layer("base-edge")
                .Tap("caps")
                .Tap("v")
                .Settle());

        // Ctrl+L chord, then esc x 2
        Assert.Contains(new KeyEvent("↓", "LCtrl"), output.KeyEvents);
        Assert.Contains(output.KeyEvents, e => e.Direction == "↓" && e.Key.Equals("L", StringComparison.OrdinalIgnoreCase));
        Assert.Equal(2, output.KeyEvents.Count(e => e.Direction == "↓" && e.Key.Equals("Escape", StringComparison.OrdinalIgnoreCase)));
    }

    [Fact]
    public async Task EdgeOverlay_GlobalRetile_StillFires()
    {
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput()
                .Layer("base-edge")
                .Tap("caps")
                .Tap("r")
                .Settle());

        Assert.Contains("wm.layout.retile", output.Intents);
    }

    // ---------------- Teams ----------------

    [Fact]
    public async Task TeamsOverlay_Mute_EmitsCtrlShiftM()
    {
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput()
                .Layer("base-teams")
                .Tap("caps")
                .Tap("m")
                .Settle());

        Assert.Contains(new KeyEvent("↓", "LCtrl"), output.KeyEvents);
        Assert.Contains(new KeyEvent("↓", "LShift"), output.KeyEvents);
        Assert.Contains(output.KeyEvents, e => e.Direction == "↓" && e.Key.Equals("M", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task TeamsOverlay_TabJump3_EmitsCtrl3()
    {
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput()
                .Layer("base-teams")
                .Tap("caps")
                .Tap("3")
                .Settle());

        Assert.Contains(new KeyEvent("↓", "LCtrl"), output.KeyEvents);
        Assert.Contains(new KeyEvent("↓", "Kb3"), output.KeyEvents);
    }

    [Fact]
    public async Task TeamsOverlay_SubModeStillWorks_FH_FiresFocusLeft()
    {
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput()
                .Layer("base-teams")
                .Tap("caps").Tap("f").Tap("h")
                .Settle());

        Assert.Contains("wm.focus.left", output.Intents);
    }

    [Fact]
    public async Task FocusSubMode_CycleNext_NowReachableViaG()
    {
        // 'g' moved from wm-base global to wm-focus sub-mode.
        // CAP g (bare) now does nothing; CAP f g cycles focus.
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput().Tap("caps").Tap("f").Tap("g").Settle());

        Assert.Contains("wm.focus.cycle-next", output.Intents);
    }
}
