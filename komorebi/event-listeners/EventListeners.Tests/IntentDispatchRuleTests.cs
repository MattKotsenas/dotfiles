using CliWrap;
using Microsoft.Extensions.Logging.Abstractions;

namespace EventListeners.Tests;

public class IntentDispatchRuleTests
{
    private static IntentDispatchRule CreateRule(
        out RecordingCommandRunner runner,
        out RecordingKeyboardSender keyboard,
        out AppFocusTracker focus)
    {
        runner = new RecordingCommandRunner();
        keyboard = new RecordingKeyboardSender();
        focus = new AppFocusTracker(NullLogger<AppFocusTracker>.Instance);
        return new IntentDispatchRule(
            NullLogger<IntentDispatchRule>.Instance, runner, keyboard, focus);
    }

    private static IntentDispatchRule CreateRule(out RecordingCommandRunner runner)
    {
        return CreateRule(out runner, out _, out _);
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

        rule.ProcessEvent(new KanataMessageEvent("system.cheatsheet"));

        var cmd = Assert.Single(runner.Commands);
        Assert.Equal("wt.exe", cmd.TargetFilePath);
        Assert.Contains("KEYMAP.md", cmd.Arguments);
        Assert.Contains("glow", cmd.Arguments);
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

    // ============================================================
    // Nav intents - context-sensitive dispatch
    // ============================================================

    [Theory]
    [InlineData("nav.left", 0x48)]  // VK_H
    [InlineData("nav.down", 0x4A)]  // VK_J
    [InlineData("nav.up", 0x4B)]    // VK_K
    [InlineData("nav.right", 0x4C)] // VK_L
    public void NavIntent_InTerminal_SendsPsmuxPrefixAndDirection(string intent, byte expectedDirectionVk)
    {
        var rule = CreateRule(out var runner, out var keyboard, out var focus);
        SetFocusedApp(focus, "WindowsTerminal.exe");

        rule.ProcessEvent(new KanataMessageEvent(intent));

        var sequence = Assert.Single(keyboard.Sequences);
        Assert.Equal(2, sequence.Count);
        // First chord: Ctrl+Space (psmux prefix)
        Assert.Equal(0x20, sequence[0].VirtualKey);
        Assert.Equal(KeyModifiers.Ctrl, sequence[0].Modifiers);
        // Second chord: bare direction key
        Assert.Equal(expectedDirectionVk, sequence[1].VirtualKey);
        Assert.Equal(KeyModifiers.None, sequence[1].Modifiers);
        // Should NOT have fired a komorebic command
        Assert.Empty(runner.Commands);
    }

    [Theory]
    [InlineData("nav.left", "focus left")]
    [InlineData("nav.down", "focus down")]
    [InlineData("nav.up", "focus up")]
    [InlineData("nav.right", "focus right")]
    public void NavIntent_OutsideTerminal_FallsBackToKomorebiFocus(string intent, string expectedArgs)
    {
        var rule = CreateRule(out var runner, out var keyboard, out var focus);
        SetFocusedApp(focus, "chrome.exe");

        rule.ProcessEvent(new KanataMessageEvent(intent));

        var cmd = Assert.Single(runner.Commands);
        Assert.Equal("komorebic", cmd.TargetFilePath);
        Assert.Equal(expectedArgs, cmd.Arguments);
        // Should NOT have sent keystrokes
        Assert.Empty(keyboard.Sequences);
    }

    [Theory]
    [InlineData("nav.left", "focus left")]
    [InlineData("nav.right", "focus right")]
    public void NavIntent_NoFocusedApp_FallsBackToKomorebiFocus(string intent, string expectedArgs)
    {
        var rule = CreateRule(out var runner, out var keyboard, out _);
        // focus tracker has no events yet, FocusedExe == null

        rule.ProcessEvent(new KanataMessageEvent(intent));

        var cmd = Assert.Single(runner.Commands);
        Assert.Equal("komorebic", cmd.TargetFilePath);
        Assert.Equal(expectedArgs, cmd.Arguments);
        Assert.Empty(keyboard.Sequences);
    }

    [Fact]
    public void NavIntent_FocusChangesToTerminal_NextDispatchUsesPsmux()
    {
        var rule = CreateRule(out var runner, out var keyboard, out var focus);

        // First dispatch with no focus → fallback
        rule.ProcessEvent(new KanataMessageEvent("nav.right"));
        Assert.Single(runner.Commands);
        Assert.Empty(keyboard.Sequences);

        // Focus changes to terminal
        SetFocusedApp(focus, "WindowsTerminal.exe");

        // Second dispatch → psmux
        rule.ProcessEvent(new KanataMessageEvent("nav.right"));
        Assert.Single(runner.Commands); // still just the first command
        Assert.Single(keyboard.Sequences);
    }

    private static void SetFocusedApp(AppFocusTracker focus, string exe)
    {
        // Feed a synthetic komorebi state so the tracker picks up the focused exe
        var state = EventListeners.Tests.TestJson.State(
            tiled: [new(Hwnd: 100, Title: "x", Exe: exe)]);
        focus.ProcessEvent(new KomorebiWindowEvent("FocusChange", null, state));
    }
}
