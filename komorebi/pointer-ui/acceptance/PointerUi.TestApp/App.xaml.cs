using System.IO;
using System.Windows;
using System.Windows.Threading;

namespace PointerUi.TestApp;

public partial class App : Application
{
    private ScenarioCommandWatcher? _commandWatcher;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        var options = ScenarioOptions.Parse(e.Args);
        ShutdownMode = ShutdownMode.OnExplicitShutdown;

        var scenario = AcceptanceScenarioCatalog.Create(
            options.Scenario);
        foreach (var window in scenario.Windows)
        {
            window.Show();
        }
        scenario.Windows[^1].Activate();
        scenario.Windows[^1].Focus();

        Dispatcher.BeginInvoke(
            () =>
            {
                StartCommandWatcher(options, scenario);
                Directory.CreateDirectory(
                    Path.GetDirectoryName(options.ReadyFile)
                    ?? string.Empty);
                using var stream = new FileStream(
                    options.ReadyFile,
                    FileMode.CreateNew,
                    FileAccess.Write,
                    FileShare.Read);
                using var writer = new StreamWriter(stream);
                writer.WriteLine(
                    $"ready:{Environment.ProcessId}");
            },
            DispatcherPriority.ApplicationIdle);
    }

    private void StartCommandWatcher(
        ScenarioOptions options,
        AcceptanceScenario scenario)
    {
        var directory = Path.GetDirectoryName(options.CommandFile)
            ?? throw new InvalidOperationException(
                "Command file has no directory.");
        Directory.CreateDirectory(directory);
        _commandWatcher = new ScenarioCommandWatcher(
            options.CommandFile,
            command => Dispatcher.BeginInvoke(
                () =>
                {
                    if (!string.Equals(
                            command,
                            "mutate",
                            StringComparison.Ordinal))
                    {
                        throw new InvalidOperationException(
                            $"Unknown scenario command '{command}'.");
                    }
                    scenario.Mutate();
                    Dispatcher.BeginInvoke(
                        () =>
                        {
                            using var stream = new FileStream(
                                options.AcknowledgementFile,
                                FileMode.CreateNew,
                                FileAccess.Write,
                                FileShare.Read);
                            using var writer =
                                new StreamWriter(stream);
                            writer.WriteLine("mutated");
                        },
                        DispatcherPriority.ContextIdle);
                },
                DispatcherPriority.ApplicationIdle));
        _commandWatcher.Start();
    }
}

internal sealed record ScenarioOptions(
    string Scenario,
    string ReadyFile,
    string CommandFile,
    string AcknowledgementFile)
{
    public static ScenarioOptions Parse(string[] args)
    {
        string? scenario = null;
        string? readyFile = null;
        string? commandFile = null;
        string? acknowledgementFile = null;
        for (var index = 0; index < args.Length; index++)
        {
            switch (args[index])
            {
                case "--scenario":
                    scenario = Value(args, ref index, "--scenario");
                    break;
                case "--ready-file":
                    readyFile = Value(args, ref index, "--ready-file");
                    break;
                case "--command-file":
                    commandFile = Value(args, ref index, "--command-file");
                    break;
                case "--ack-file":
                    acknowledgementFile = Value(
                        args,
                        ref index,
                        "--ack-file");
                    break;
                default:
                    throw new ArgumentException(
                        $"Unknown argument '{args[index]}'.");
            }
        }

        return new ScenarioOptions(
            scenario
                ?? throw new ArgumentException("--scenario is required."),
            Path.GetFullPath(
                readyFile
                ?? throw new ArgumentException(
                    "--ready-file is required.")),
            Path.GetFullPath(
                commandFile
                ?? throw new ArgumentException(
                    "--command-file is required.")),
            Path.GetFullPath(
                acknowledgementFile
                ?? throw new ArgumentException(
                    "--ack-file is required.")));
    }

    private static string Value(
        IReadOnlyList<string> args,
        ref int index,
        string option)
    {
        if (++index >= args.Count
            || string.IsNullOrWhiteSpace(args[index]))
        {
            throw new ArgumentException(
                $"{option} requires a value.");
        }
        return args[index];
    }
}
