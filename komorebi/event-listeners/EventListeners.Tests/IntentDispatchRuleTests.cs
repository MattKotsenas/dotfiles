using CliWrap;
using Microsoft.Extensions.Logging.Abstractions;

namespace EventListeners.Tests;

public class IntentDispatchRuleTests
{
    private static IntentDispatchRule CreateRule(out RecordingCommandRunner runner) =>
        CreateRule(out runner, out _, out _);

    private static IntentDispatchRule CreateRule(
        out RecordingCommandRunner runner,
        out FakeWindowSweeper sweeper,
        out FakeLocalSoundPlayer soundPlayer)
    {
        runner = new RecordingCommandRunner();
        sweeper = new FakeWindowSweeper();
        soundPlayer = new FakeLocalSoundPlayer();
        return new IntentDispatchRule(
            NullLogger<IntentDispatchRule>.Instance,
            runner,
            sweeper,
            new FakeTeamsMeetingJoin(),
            new FakeTeamsCallControls(),
            soundPlayer);
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
    public void KnownIntent_DispatchesExpectedCommand(string intent, string expectedExe, string expectedArgs)
    {
        var rule = CreateRule(out var runner);

        rule.ProcessEvent(new KanataMessageEvent(intent));

        var cmd = Assert.Single(runner.Commands);
        Assert.Equal(expectedExe, cmd.TargetFilePath);
        Assert.Equal(expectedArgs, cmd.Arguments);
        Assert.Equal(CommandResultValidation.None, cmd.Validation);
    }

    [Fact]
    public void ReacquireIntent_InvokesSweeper_WithoutRunningCommand()
    {
        var rule = CreateRule(out var runner, out var sweeper, out _);

        Assert.Equal(0, sweeper.SweepCount); // precondition: not yet swept

        rule.ProcessEvent(new KanataMessageEvent("wm.window.reacquire"));

        Assert.Equal(1, sweeper.SweepCount);
        // The sweep is delegated to IWindowSweeper; the dispatcher itself issues no command.
        Assert.Empty(runner.Commands);
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

    [Fact]
    public void TeamsJoinIntent_InvokesJoin_WithoutRunningCommand()
    {
        var runner = new RecordingCommandRunner();
        var teamsJoin = new FakeTeamsMeetingJoin();
        var teamsCall = new FakeTeamsCallControls();
        var rule = new IntentDispatchRule(
            NullLogger<IntentDispatchRule>.Instance,
            runner,
            new FakeWindowSweeper(),
            teamsJoin,
            teamsCall,
            new FakeLocalSoundPlayer());
        Assert.Equal(0, teamsJoin.JoinCount);

        rule.ProcessEvent(new KanataMessageEvent("teams.meeting.join"));

        Assert.Equal(1, teamsJoin.JoinCount);
        Assert.Equal(0, teamsCall.LeaveCount);
        Assert.Empty(runner.Commands);
    }

    [Fact]
    public void TeamsLeaveIntent_InvokesLeave_WithoutRunningCommand()
    {
        var runner = new RecordingCommandRunner();
        var teamsJoin = new FakeTeamsMeetingJoin();
        var teamsCall = new FakeTeamsCallControls();
        var rule = new IntentDispatchRule(
            NullLogger<IntentDispatchRule>.Instance,
            runner,
            new FakeWindowSweeper(),
            teamsJoin,
            teamsCall,
            new FakeLocalSoundPlayer());
        Assert.Equal(0, teamsCall.LeaveCount);

        rule.ProcessEvent(new KanataMessageEvent("teams.call.leave"));

        Assert.Equal(1, teamsCall.LeaveCount);
        // Leaving must not be confused with joining: they share a key, not a meaning.
        Assert.Equal(0, teamsJoin.JoinCount);
        Assert.Empty(runner.Commands);
    }

    [Theory]
    [InlineData("sound.play.hiyo", LocalSound.Hiyo)]
    [InlineData("sound.play.horns", LocalSound.Horns)]
    public void SoundIntent_PlaysLocally_WithoutRunningCommand(string intent, LocalSound expected)
    {
        var rule = CreateRule(out var runner, out _, out var soundPlayer);
        Assert.Empty(soundPlayer.Played); // precondition

        rule.ProcessEvent(new KanataMessageEvent(intent));

        Assert.Equal([expected], soundPlayer.Played);
        Assert.Empty(runner.Commands);
    }

    [Fact]
    public void FailedSoundPlayback_IsReported()
    {
        var logger = new RecordingLogger<IntentDispatchRule>();
        var soundPlayer = new FakeLocalSoundPlayer { Succeeds = false };
        var rule = new IntentDispatchRule(
            logger,
            new RecordingCommandRunner(),
            new FakeWindowSweeper(),
            new FakeTeamsMeetingJoin(),
            new FakeTeamsCallControls(),
            soundPlayer);

        rule.ProcessEvent(new KanataMessageEvent("sound.play.hiyo"));

        Assert.Contains(logger.Warnings, warning => warning.Contains("sound.play.hiyo", StringComparison.Ordinal));
    }
}

internal sealed class FakeTeamsMeetingJoin : ITeamsMeetingJoin
{
    public int JoinCount { get; private set; }

    public void Join() => JoinCount++;
}

internal sealed class FakeTeamsCallControls : ITeamsCallControls
{
    public int LeaveCount { get; private set; }

    public void Leave() => LeaveCount++;
}

internal sealed class FakeLocalSoundPlayer : ILocalSoundPlayer
{
    private readonly List<LocalSound> _played = [];

    public IReadOnlyList<LocalSound> Played => _played;

    public bool Succeeds { get; set; } = true;

    public bool Play(LocalSound sound)
    {
        _played.Add(sound);
        return Succeeds;
    }
}
