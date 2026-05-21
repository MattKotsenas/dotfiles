using System.Diagnostics;
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

    public string Name => "KomorebicCommandRule";

    public KomorebicCommandRule(ILogger<KomorebicCommandRule> logger)
    {
        _logger = logger;
    }

    public void ProcessEvent(IEvent evt)
    {
        if (evt is not KanataMessageEvent e) return;

        if (e.Message.StartsWith("komorebic ", StringComparison.Ordinal))
        {
            var args = e.Message["komorebic ".Length..];
            RunKomorebic(args);
        }
        else if (e.Message == "cheatsheet")
        {
            RunCheatsheet();
        }
    }

    private void RunKomorebic(string arguments)
    {
        try
        {
            using var process = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = "komorebic",
                    Arguments = arguments,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true
                }
            };

            process.Start();
            process.WaitForExit();

            if (process.ExitCode != 0)
            {
                var stderr = process.StandardError.ReadToEnd();
                _logger.LogWarning("komorebic {Args} exited {ExitCode}: {StdErr}",
                    arguments, process.ExitCode, stderr);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to invoke komorebic {Args}", arguments);
        }
    }

    private void RunCheatsheet()
    {
        try
        {
            var keymap = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".config", "keyboard", "KEYMAP.md");

            using var process = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = "wt.exe",
                    Arguments = $"-w _quake glow -p \"{keymap}\"",
                    UseShellExecute = false,
                    CreateNoWindow = true
                }
            };

            process.Start();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to open cheatsheet");
        }
    }
}
