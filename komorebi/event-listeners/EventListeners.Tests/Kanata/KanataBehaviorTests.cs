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
    [InlineData("j", "wm.stack.cycle-prev")]
    [InlineData("k", "wm.stack.cycle-next")]
    public async Task OneShot_AssembleCycle_DispatchesStackCycle(string direction, string expectedIntent)
    {
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput().Tap("caps").Tap("a").Tap(direction).Settle());

        Assert.Contains(expectedIntent, output.Intents);
    }

    // ============================================================
    // Workspaces (1-8 in WM layer)
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
    public async Task OneShot_WorkspaceNumber_DispatchesFocusWorkspace(string key, string expectedIntent)
    {
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput().Tap("caps").Tap(key).Settle());

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
    // Standalone actions (single key in WM layer)
    // ============================================================

    [Theory]
    [InlineData("t", "wm.layout.toggle-float")]
    [InlineData("m", "wm.layout.toggle-monocle")]
    [InlineData("r", "wm.layout.retile")]
    [InlineData("q", "wm.move.promote")]
    [InlineData("x", "wm.layout.flip-horizontal")]
    [InlineData("y", "wm.layout.flip-vertical")]
    [InlineData("p", "wm.layout.toggle-pause")]
    [InlineData("g", "wm.focus.cycle-next")]
    public async Task OneShot_StandaloneAction_DispatchesExpectedIntent(string key, string expectedIntent)
    {
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput().Tap("caps").Tap(key).Settle());

        Assert.Contains(expectedIntent, output.Intents);
    }

    [Theory]
    [InlineData("[", "wm.stack.cycle-prev")]
    [InlineData("]", "wm.stack.cycle-next")]
    [InlineData(@"\", "wm.stack.unstack")]
    public async Task OneShot_StackKeys_DispatchesStackIntent(string key, string expectedIntent)
    {
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput().Tap("caps").Tap(key).Settle());

        Assert.Contains(expectedIntent, output.Intents);
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
    // Toggle mode (double CapsLock tap)
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
}
