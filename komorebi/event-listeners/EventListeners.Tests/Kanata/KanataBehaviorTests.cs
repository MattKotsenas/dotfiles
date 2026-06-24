using EventListeners.Tests.KanataHarness;

namespace EventListeners.Tests.Kanata;

/// <summary>
/// Behavior tests for the production kanata config.
///
/// Each scenario simulates a key sequence and asserts the resulting
/// intents fired. These establish a baseline of current behavior
/// before adding inner navigation (komokana-style app-aware layers).
/// </summary>
[Trait("Category", "KanataHarness")]
public class KanataBehaviorTests
{
    // ============================================================
    // One-shot prefix mode (single CapsLock tap)
    // ============================================================

    [Theory]
    [InlineData("f", "h", "wm.focus.left")]
    [InlineData("f", "j", "wm.focus.down")]
    [InlineData("f", "k", "wm.focus.up")]
    [InlineData("f", "l", "wm.focus.right")]
    public async Task OneShot_FocusSubMod_DispatchesFocusIntent(string subMod, string direction, string expectedIntent)
    {
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput().Tap("caps").Tap(subMod).Tap(direction).Settle());

        Assert.Contains(expectedIntent, output.Intents);
    }

    [Theory]
    [InlineData("h", "wm.move.left")]
    [InlineData("j", "wm.move.down")]
    [InlineData("k", "wm.move.up")]
    [InlineData("l", "wm.move.right")]
    [InlineData("q", "wm.move.promote")]
    public async Task OneShot_MoveSubMod_DispatchesMoveIntent(string direction, string expectedIntent)
    {
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput().Tap("caps").Tap("d").Tap(direction).Settle());

        Assert.Contains(expectedIntent, output.Intents);
    }

    [Theory]
    [InlineData("h", "wm.stack.left")]
    [InlineData("j", "wm.stack.down")]
    [InlineData("k", "wm.stack.up")]
    [InlineData("l", "wm.stack.right")]
    public async Task OneShot_StackSubMod_DispatchesStackIntent(string direction, string expectedIntent)
    {
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput().Tap("caps").Tap("s").Tap(direction).Settle());

        Assert.Contains(expectedIntent, output.Intents);
    }

    [Theory]
    [InlineData("h", "wm.resize.horizontal-decrease")]
    [InlineData("j", "wm.resize.vertical-decrease")]
    [InlineData("k", "wm.resize.vertical-increase")]
    [InlineData("l", "wm.resize.horizontal-increase")]
    public async Task OneShot_ResizeSubMod_DispatchesResizeIntent(string direction, string expectedIntent)
    {
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput().Tap("caps").Tap("e").Tap(direction).Settle());

        Assert.Contains(expectedIntent, output.Intents);
    }

    [Theory]
    [InlineData("p", "wm.stack.cycle-prev")]
    [InlineData("n", "wm.stack.cycle-next")]
    public async Task OneShot_StackCycle_DispatchesStackCycle(string key, string expectedIntent)
    {
        // After Phase 3 reorg, cycle ops live in the consolidated wm-stack
        // sub-mode (was wm-assemble in Phase 2). Keys are n/p not j/k.
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput().Tap("caps").Tap("s").Tap(key).Settle());

        Assert.Contains(expectedIntent, output.Intents);
    }

    [Fact]
    public async Task OneShot_StackUnstack_DispatchesUnstack()
    {
        // Phase 3: unstack moved from wm-assemble (h/l) to wm-stack (u).
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput().Tap("caps").Tap("s").Tap("u").Settle());

        Assert.Contains("wm.stack.unstack", output.Intents);
    }

    // ============================================================
    // Workspaces (1-8 behind w sub-mode after Phase 2)
    // ============================================================

    [Theory]
    [InlineData("1", "wm.workspace.focus.0")]
    [InlineData("2", "wm.workspace.focus.1")]
    [InlineData("3", "wm.workspace.focus.2")]
    [InlineData("4", "wm.workspace.focus.3")]
    [InlineData("5", "wm.workspace.focus.4")]
    [InlineData("6", "wm.workspace.focus.5")]
    [InlineData("7", "wm.workspace.focus.6")]
    [InlineData("8", "wm.workspace.focus.7")]
    public async Task OneShot_WorkspaceSubMod_DispatchesFocusWorkspace(string key, string expectedIntent)
    {
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput().Tap("caps").Tap("w").Tap(key).Settle());

        Assert.Contains(expectedIntent, output.Intents);
    }

    [Theory]
    [InlineData("1", "wm.workspace.move-to.0")]
    [InlineData("3", "wm.workspace.move-to.2")]
    [InlineData("8", "wm.workspace.move-to.7")]
    public async Task OneShot_MoveToWorkspace_DispatchesMoveToWorkspace(string key, string expectedIntent)
    {
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput().Tap("caps").Tap("d").Tap(key).Settle());

        Assert.Contains(expectedIntent, output.Intents);
    }

    // ============================================================
    // Admin sub-mode (CAP a): reacquire / manage / pause / flip.
    // ============================================================

    [Theory]
    [InlineData("r", "wm.window.reacquire")]
    [InlineData("m", "wm.window.manage")]
    [InlineData("p", "wm.layout.toggle-pause")]
    [InlineData("x", "wm.layout.flip-horizontal")]
    [InlineData("y", "wm.layout.flip-vertical")]
    public async Task OneShot_AdminSubMod_DispatchesExpectedIntent(string key, string expectedIntent)
    {
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput().Tap("caps").Tap("a").Tap(key).Settle());

        Assert.Contains(expectedIntent, output.Intents);
    }

    // ============================================================
    // Phase 3: t/m moved from wm-focus to wm-move (window-state ops).
    // ============================================================

    [Theory]
    [InlineData("t", "wm.layout.toggle-float")]
    [InlineData("m", "wm.layout.toggle-monocle")]
    public async Task OneShot_MoveSubMod_WindowStateActions_Dispatch(string key, string expectedIntent)
    {
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput().Tap("caps").Tap("d").Tap(key).Settle());

        Assert.Contains(expectedIntent, output.Intents);
    }

    // ============================================================
    // Phase 2/3: bare keys in wm-base no longer fire intents
    // ============================================================

    [Theory]
    [InlineData("h")]
    [InlineData("j")]
    [InlineData("k")]
    [InlineData("l")]
    [InlineData("1")]
    [InlineData("t")]
    [InlineData("m")]
    [InlineData("r")]  // Phase 3: r moved from wm-base global to wm-admin
    [InlineData("p")]  // Phase 3: p moved from wm-base global to wm-admin
    [InlineData("x")]  // Phase 3: x moved from wm-focus to wm-admin
    [InlineData("y")]  // Phase 3: y moved from wm-focus to wm-admin
    public async Task OneShot_BareKey_NotInWmBase_FiresNoIntent(string key)
    {
        // After the Phase 2/3 reorg, wm-base only retains tab and / as globals.
        // Pressing other keys inside one-shot WM mode without a sub-mode is a
        // deadkey (no-op).
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput().Tap("caps").Tap(key).Settle());

        Assert.Empty(output.Intents);
    }

    [Fact]
    public async Task OneShot_Cheatsheet_DispatchesIntent()
    {
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput().Tap("caps").Tap("/").Settle());

        Assert.Contains("system.cheatsheet", output.Intents);
    }

    [Fact]
    public async Task OneShot_Tab_DispatchesLastWorkspaceIntent()
    {
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput().Tap("caps").Tap("tab").Settle());

        Assert.Contains("wm.focus.last-workspace", output.Intents);
    }

    // ============================================================
    // Sticky mode: a second CAP locks one-shot WM into sticky (no
    // timing window -- it is a plain CAP re-press, not a fast double-tap).
    // ============================================================

    [Fact]
    public async Task ToggleMode_MoveSticky_ConsecutiveMovesFire()
    {
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput()
                .Tap("caps").Tap("caps")  // enter toggle mode
                .Tap("d")                  // enter move sub-layer (sticky)
                .Tap("h")                  // move left
                .Tap("l")                  // move right (no need to re-enter d)
                .Tap("caps")               // exit
                .Settle());

        // Both moves should fire
        var moves = output.Intents.Where(i => i.StartsWith("wm.move.")).ToList();
        Assert.Contains("wm.move.left", moves);
        Assert.Contains("wm.move.right", moves);
    }

    [Fact]
    public async Task ToggleMode_SubModSwitching_DandSChangeContext()
    {
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput()
                .Tap("caps").Tap("caps")  // toggle
                .Tap("d").Tap("h")        // move left
                .Tap("s").Tap("l")        // switch to stack mode, stack right
                .Tap("caps")              // exit
                .Settle());

        Assert.Contains("wm.move.left", output.Intents);
        Assert.Contains("wm.stack.right", output.Intents);
    }

    // ============================================================
    // CAP cycle: CAP toggles one-shot <-> sticky. Odd presses = one-shot
    // (auto-exits after one action), even = sticky. An action or ESC
    // returns to typing; CAP itself never lands in typing.
    //
    // Discriminator: the two-action sequence f h f l fires BOTH focus.left
    // and focus.right when sticky, but only focus.left when one-shot (the
    // one-shot exits to typing after the first action, so the trailing f/l
    // type as literal keys).
    // ============================================================

    [Theory]
    [InlineData(1, false)]  // odd  -> one-shot
    [InlineData(2, true)]   // even -> sticky
    [InlineData(3, false)]  // odd  -> one-shot (CAP from sticky returns to one-shot)
    [InlineData(4, true)]   // even -> sticky
    public async Task CapCycle_OddPressesOneShot_EvenPressesSticky(int capPresses, bool sticky)
    {
        var input = new SimInput();
        for (var i = 0; i < capPresses; i++) input.Tap("caps");
        input.Tap("f").Tap("h").Tap("f").Tap("l").Settle();

        var output = await KanataSimulator.RunAsync(TestPaths.ProductionConfig, input);

        Assert.Contains("wm.focus.left", output.Intents);
        if (sticky)
            Assert.Contains("wm.focus.right", output.Intents);
        else
            Assert.DoesNotContain("wm.focus.right", output.Intents);
    }

    [Fact]
    public async Task CapCycle_LockAfterLongGap_StillSticky()
    {
        // No timing window: a CAP a full second after the first still locks.
        // (The old tap-dance required the second tap within ~250ms.)
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput()
                .Tap("caps").Wait(1000).Tap("caps")
                .Tap("f").Tap("h").Tap("f").Tap("l")
                .Settle());

        Assert.Contains("wm.focus.left", output.Intents);
        Assert.Contains("wm.focus.right", output.Intents);
    }

    [Fact]
    public async Task CapCycle_FromSticky_ReturnsToOneShot_NotTyping()
    {
        // Seeded into sticky wm-toggle, CAP returns to ONE-SHOT (not typing):
        // focus.left firing proves we are in a WM layer (in typing, f/h would
        // type literally); focus.right NOT firing proves the one-shot was
        // consumed by the first action. Contrast: capPresses=2 above fires both.
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput()
                .Layer("wm-toggle")
                .Tap("caps")
                .Tap("f").Tap("h").Tap("f").Tap("l")
                .Settle());

        Assert.Contains("wm.focus.left", output.Intents);
        Assert.DoesNotContain("wm.focus.right", output.Intents);
    }

    // ============================================================
    // Outside WM mode: keys pass through
    // ============================================================

    [Fact]
    public async Task NotInWmMode_KeyTypingPassesThrough()
    {
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput().Tap("h").Tap("e").Tap("l").Tap("l").Tap("o").Settle());

        // No intents should fire when just typing
        Assert.Empty(output.Intents);
    }

    // ============================================================
    // ESC = "panic button" exit from any wm-* layer back to a base layer.
    // Verified by checking that a subsequent letter passes through to the OS;
    // inside wm-* layers, unbound letters deadkey via ___ XX, so a letter
    // making it out proves we're back in a base layer.
    // ============================================================

    [Fact]
    public async Task EscFromStickyWmToggle_ExitsToBaseDefault()
    {
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput()
                .Tap("caps").Tap("caps")  // sticky wm-toggle
                .Tap("esc")                // exit
                .Tap("h")                  // h must pass through to OS
                .Settle());

        // No intent fired and h reached the OS = we're back in base-default.
        Assert.Empty(output.Intents);
        Assert.Contains(output.KeyEvents, e => e.Direction == "↓" && e.Key.Equals("H", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task EscFromOneShotWm_ExitsToBaseDefault()
    {
        // Single-tap CAP enters one-shot wm (held layer). Pressing ESC should
        // explicitly exit to base-default (instead of just waiting for the
        // one-shot to expire).
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput()
                .Tap("caps")
                .Tap("esc")
                .Tap("h")
                .Settle());

        Assert.Empty(output.Intents);
        Assert.Contains(output.KeyEvents, e => e.Direction == "↓" && e.Key.Equals("H", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task EscFromStickySubModeToggle_ExitsToBaseDefault()
    {
        // CAPCAP f enters sticky wm-focus-toggle. ESC should land us back in
        // base-default (the shared sub-mode exit; bridge restores overlay).
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput()
                .Tap("caps").Tap("caps")
                .Tap("f")          // enter wm-focus-toggle
                .Tap("esc")        // exit
                .Tap("h")          // h must pass through to OS
                .Settle());

        // h passing through proves we exited the sub-mode toggle. We should
        // NOT have fired wm.focus.left (which would be the wm-focus-toggle
        // binding for h).
        Assert.DoesNotContain("wm.focus.left", output.Intents);
        Assert.Contains(output.KeyEvents, e => e.Direction == "↓" && e.Key.Equals("H", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task EscIsInactiveOutsideWmMode_PassesThroughToApp()
    {
        // In base-default (no wm mode), ESC must not be intercepted; it should
        // reach the focused app so Vim, dialogs, etc. still work.
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput().Tap("esc").Settle());

        // The literal ESC keystroke should have been emitted to the OS.
        Assert.Contains(output.KeyEvents, e => e.Direction == "↓" && e.Key.Equals("Escape", StringComparison.OrdinalIgnoreCase));
        Assert.Empty(output.Intents);
    }
}
