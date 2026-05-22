using CliWrap;
using Microsoft.Extensions.Logging.Abstractions;

namespace EventListeners.Tests;

public class KomorebicCommandRuleTests
{
    private static KomorebicCommandRule CreateRule(out RecordingCommandRunner runner)
    {
        runner = new RecordingCommandRunner();
        return new KomorebicCommandRule(NullLogger<KomorebicCommandRule>.Instance, runner);
    }

    [Theory]
    [InlineData("komorebic focus left", "komorebic", "focus left")]
    [InlineData("komorebic focus right", "komorebic", "focus right")]
    [InlineData("komorebic move-to-workspace 3", "komorebic", "move-to-workspace 3")]
    [InlineData("komorebic toggle-float", "komorebic", "toggle-float")]
    [InlineData("komorebic focus-workspaces 0", "komorebic", "focus-workspaces 0")]
    public void KomorebicMessage_ExecutesCorrectCommand(string message, string expectedExe, string expectedArgs)
    {
        var rule = CreateRule(out var runner);

        rule.ProcessEvent(new KanataMessageEvent(message));

        var cmd = Assert.Single(runner.Commands);
        Assert.Equal(expectedExe, cmd.TargetFilePath);
        Assert.Equal(expectedArgs, cmd.Arguments);
        Assert.Equal(CommandResultValidation.None, cmd.Validation);
    }

    [Fact]
    public void CheatsheetMessage_ExecutesWtWithGlow()
    {
        var rule = CreateRule(out var runner);

        rule.ProcessEvent(new KanataMessageEvent("cheatsheet"));

        var cmd = Assert.Single(runner.Commands);
        Assert.Equal("wt.exe", cmd.TargetFilePath);
        Assert.Contains("KEYMAP.md", cmd.Arguments);
        Assert.Contains("glow", cmd.Arguments);
        Assert.Equal(CommandResultValidation.None, cmd.Validation);
    }

    [Theory]
    [InlineData("unknown-message")]
    [InlineData("")]
    [InlineData("komorebic")]  // no space after prefix = no match
    public void UnknownMessage_NoCommandExecuted(string message)
    {
        var rule = CreateRule(out var runner);

        rule.ProcessEvent(new KanataMessageEvent(message));

        Assert.Empty(runner.Commands);
    }

    [Fact]
    public void KomorebiWindowEvent_Ignored()
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
