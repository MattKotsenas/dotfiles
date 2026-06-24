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
    public async Task EdgeOverlay_VimiumSafeEscape_EmitsCtrlLeftBracket_WithNoEsc()
    {
        // CAP [ sends Ctrl+[ which Vimium treats as Escape, so it exits insert
        // mode without the page ever seeing a real Esc. The "no Escape"
        // assertion is the whole point: the previous C-l/esc/esc binding leaked
        // literal Esc presses to the page (the bug being fixed).
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput()
                .Layer("base-edge")
                .Tap("caps")
                .Tap("[")
                .Settle());

        // Ctrl is held while [ is pressed, so the browser sees <c-[>.
        Assert.Contains(new KeyEvent("↓", "LCtrl"), output.KeyEvents);
        Assert.Contains(new KeyEvent("↓", "LBracket"), output.KeyEvents);
        Assert.Contains(new KeyEvent("↑", "LCtrl"), output.KeyEvents);
        // Precondition that makes the escape "safe": no literal Esc is emitted.
        Assert.DoesNotContain(
            output.KeyEvents,
            e => e.Key.Equals("Escape", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task EdgeOverlay_AdminReacquire_StillFires()
    {
        // reacquire lives in the wm-admin (CAP a) sub-mode. From Edge overlay
        // context, CAP a r must still fire it — proving the admin sub-mode is
        // reachable through the overlay layer.
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput()
                .Layer("base-edge")
                .Tap("caps")
                .Tap("a").Tap("r")
                .Settle());

        Assert.Contains("wm.window.reacquire", output.Intents);
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

    // ---------------- CodeFlow ----------------

    [Fact]
    public async Task CodeflowOverlay_MarkReviewed_FocusesTree_ThenSpace_ThenDiff()
    {
        // CAP + r in CodeFlow marks the current file reviewed and returns to the diff:
        //   focus file tree (Alt+Shift+T) -> tap Space (the tree's mark key) -> focus diff view (Alt+Shift+D).
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput()
                .Layer("base-codeflow")
                .Tap("caps")
                .Tap("r")
                .Settle());

        var events = output.KeyEvents.ToList();

        var treeIdx = events.FindIndex(e => e.Direction == "↓" && e.Key.Equals("T", StringComparison.OrdinalIgnoreCase));
        var spaceIdx = events.FindIndex(e => e.Direction == "↓" && e.Key == "Space");
        var diffIdx = events.FindIndex(e => e.Direction == "↓" && e.Key.Equals("D", StringComparison.OrdinalIgnoreCase));

        // Sequence order: focus tree, then the literal space, then focus diff.
        Assert.True(treeIdx >= 0, "focus file tree (Alt+Shift+T) must fire first");
        Assert.True(spaceIdx > treeIdx, "Space must follow the focus-tree step");
        Assert.True(diffIdx > spaceIdx, "focus diff view (Alt+Shift+D) must follow the Space");

        // Both focus steps are Alt+Shift chords, not bare t/d.
        Assert.Contains(new KeyEvent("↓", "LAlt"), events);
        Assert.Contains(new KeyEvent("↓", "LShift"), events);

        // Each step fires exactly once. The macro emits one literal Space (not the
        // 'r' trigger), and that Space is OS output that does not re-enter the
        // overlay -- proves no recursion.
        Assert.Equal(1, events.Count(e => e.Direction == "↓" && e.Key.Equals("T", StringComparison.OrdinalIgnoreCase)));
        Assert.Equal(1, events.Count(e => e.Direction == "↓" && e.Key == "Space"));
        Assert.Equal(1, events.Count(e => e.Direction == "↓" && e.Key.Equals("D", StringComparison.OrdinalIgnoreCase)));

        // It's a key macro, not a WM intent.
        Assert.Empty(output.Intents);
    }
}
