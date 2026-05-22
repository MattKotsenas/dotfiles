using CliWrap;
using EventListeners.Models;
using Microsoft.Extensions.Logging;

namespace EventListeners;

/// <summary>
/// Executes komorebic commands received as push-msg events from kanata.
/// Messages prefixed with "komorebic " are parsed and executed.
/// The "cheatsheet" message opens the keymap reference.
/// </summary>
public sealed class KomorebicCommandRule : IEventRule
{
    private readonly ILogger<KomorebicCommandRule> _logger;
    private readonly ICommandRunner _runner;

    public string Name => "KomorebicCommandRule";

    public KomorebicCommandRule(ILogger<KomorebicCommandRule> logger, ICommandRunner runner)
    {
        _logger = logger;
        _runner = runner;
    }

    public void ProcessEvent(IEvent evt)
    {
        if (evt is not KanataMessageEvent e) return;

        if (e.Message.StartsWith("komorebic ", StringComparison.Ordinal))
        {
            var args = e.Message["komorebic ".Length..];
            _ = RunAsync(Cli.Wrap("komorebic").WithArguments(args).WithValidation(CommandResultValidation.None), args);
        }
        else if (e.Message == "cheatsheet")
        {
            var keymap = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".config", "keyboard", "KEYMAP.md");

            _ = RunAsync(Cli.Wrap("wt.exe").WithArguments($"-w _quake glow -p \"{keymap}\"").WithValidation(CommandResultValidation.None), "cheatsheet");
        }
    }

    private async Task RunAsync(Command command, string description)
    {
        try
        {
            var result = await _runner.RunAsync(command);
            if (result.ExitCode != 0)
            {
                _logger.LogWarning("{Description} exited {ExitCode}", description, result.ExitCode);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to run {Description}", description);
        }
    }
}
