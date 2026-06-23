using CliWrap;
using Microsoft.Extensions.Logging.Abstractions;

namespace EventListeners.Tests;

public class IntentDispatchRuleTests
{
    private static IntentDispatchRule CreateRule(out RecordingCommandRunner runner)
    {
        runner = new RecordingCommandRunner();
        return new IntentDispatchRule(NullLogger<IntentDispatchRule>.Instance, runner);
    }

    [Theory]
    // Focus
    [InlineData("wm.focus.left", "komorebic", "focus left")]
    [InlineData("wm.focus.down", "komorebic", "focus down")]
    [InlineData("wm.focus.up", "komorebic", "focus up")]
    [InlineData("wm.focus.right", "komorebic", "focus right")]
    [InlineData("wm.focus.cycle-next", "komorebic", "cycle-focus next")]
    [InlineData("wm.focus.last-workspace", "komorebic", "focus-last-workspace")]
    // Move
    [InlineData("wm.move.left", "komorebic", "move left")]
    [InlineData("wm.move.down", "komorebic", "move down")]
    [InlineData("wm.move.up", "komorebic", "move up")]
    [InlineData("wm.move.right", "komorebic", "move right")]
    [InlineData("wm.move.promote", "komorebic", "promote")]
    // Stack
    [InlineData("wm.stack.left", "komorebic", "stack left")]
    [InlineData("wm.stack.down", "komorebic", "stack down")]
    [InlineData("wm.stack.up", "komorebic", "stack up")]
    [InlineData("wm.stack.right", "komorebic", "stack right")]
    [InlineData("wm.stack.unstack", "komorebic", "unstack")]
    [InlineData("wm.stack.cycle-prev", "komorebic", "cycle-stack previous")]
    [InlineData("wm.stack.cycle-next", "komorebic", "cycle-stack next")]
    // Resize
    [InlineData("wm.resize.horizontal-decrease", "komorebic", "resize-axis horizontal decrease")]
    [InlineData("wm.resize.horizontal-increase", "komorebic", "resize-axis horizontal increase")]
    [InlineData("wm.resize.vertical-decrease", "komorebic", "resize-axis vertical decrease")]
    [InlineData("wm.resize.vertical-increase", "komorebic", "resize-axis vertical increase")]
    // Layout
    [InlineData("wm.layout.flip-horizontal", "komorebic", "flip-layout horizontal")]
    [InlineData("wm.layout.flip-vertical", "komorebic", "flip-layout vertical")]
    [InlineData("wm.layout.toggle-float", "komorebic", "toggle-float")]
    [InlineData("wm.layout.toggle-monocle", "komorebic", "toggle-monocle")]
    [InlineData("wm.layout.toggle-pause", "komorebic", "toggle-pause")]
    [InlineData("wm.layout.retile", "komorebic", "retile")]
    // Window
    [InlineData("wm.window.manage", "komorebic", "manage")]
    // System
    [InlineData("wm.system.reload", "wpmctl", "restart komorebi komorebi-bar-1 komorebi-bar-2")]
    public void KnownIntent_DispatchesExpectedCommand(string intent, string expectedExe, string expectedArgs)
    {
        var rule = CreateRule(out var runner);

        rule.ProcessEvent(new KanataMessageEvent(intent));

        var cmd = Assert.Single(runner.Commands);
        Assert.Equal(expectedExe, cmd.TargetFilePath);
        Assert.Equal(expectedArgs, cmd.Arguments);
        Assert.Equal(CommandResultValidation.None, cmd.Validation);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    [InlineData(5)]
    [InlineData(6)]
    [InlineData(7)]
    public void WorkspaceFocus_DispatchesCorrectIndex(int index)
    {
        var rule = CreateRule(out var runner);

        rule.ProcessEvent(new KanataMessageEvent($"wm.workspace.focus.{index}"));

        var cmd = Assert.Single(runner.Commands);
        Assert.Equal("komorebic", cmd.TargetFilePath);
        Assert.Equal($"focus-workspaces {index}", cmd.Arguments);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(7)]
    public void WorkspaceMoveTo_DispatchesCorrectIndex(int index)
    {
        var rule = CreateRule(out var runner);

        rule.ProcessEvent(new KanataMessageEvent($"wm.workspace.move-to.{index}"));

        var cmd = Assert.Single(runner.Commands);
        Assert.Equal("komorebic", cmd.TargetFilePath);
        Assert.Equal($"move-to-workspace {index}", cmd.Arguments);
    }

    [Fact]
    public void CheatsheetIntent_OpensWtWithGlow()
    {
        var rule = CreateRule(out var runner);
        // komorebic configuration is queried first to locate the config home.
        runner.BufferedStandardOutput = "C:\\home\\.config\\komorebi\\komorebi.json\r\n";

        rule.ProcessEvent(new KanataMessageEvent("system.cheatsheet"));

        Assert.Contains(runner.Commands,
            c => c.TargetFilePath == "komorebic" && c.Arguments == "configuration");

        var cmd = runner.Commands.Last();
        Assert.Equal("wt.exe", cmd.TargetFilePath);
        Assert.Contains("glow", cmd.Arguments);
        // Derived as the sibling of komorebi's config home, not a hard-coded %USERPROFILE%.
        Assert.Contains("\\home\\.config\\keyboard\\KEYMAP.md", cmd.Arguments);
    }

    [Theory]
    [InlineData("unknown.intent")]
    [InlineData("")]
    [InlineData("komorebic focus left")] // old-style command string (should not match)
    public void UnknownIntent_NoCommandExecuted(string intent)
    {
        var rule = CreateRule(out var runner);

        rule.ProcessEvent(new KanataMessageEvent(intent));

        Assert.Empty(runner.Commands);
    }

    [Fact]
    public void KomorebiEvent_Ignored()
    {
        var rule = CreateRule(out var runner);

        rule.ProcessEvent(new KomorebiWindowEvent("Show", null, null));

        Assert.Empty(runner.Commands);
    }

    [Fact]
    public void KanataLayerChangeEvent_Ignored()
    {
        var rule = CreateRule(out var runner);

        rule.ProcessEvent(new KanataLayerChangeEvent("wm"));

        Assert.Empty(runner.Commands);
    }
}
