using System.Globalization;

namespace PointerUi.Acceptance.Runner;

public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        var options = RunnerOptions.Parse(args);
        Directory.CreateDirectory(options.Artifacts);
        try
        {
            if (!File.Exists(options.MarkerPath)
                || !string.Equals(
                    File.ReadAllText(options.MarkerPath).Trim(),
                    AcceptanceContract.MarkerContent,
                    StringComparison.Ordinal))
            {
                throw new InvalidOperationException(
                    "The VM acceptance marker is missing or invalid.");
            }

            Environment.SetEnvironmentVariable(
                AcceptanceContract.VmEnabledVariable,
                "1");
            Environment.SetEnvironmentVariable(
                AcceptanceContract.MarkerPathVariable,
                options.MarkerPath);
            Environment.SetEnvironmentVariable(
                AcceptanceContract.ArtifactsPathVariable,
                options.Artifacts);
            var result = await DotnetProcess.RunAsync(
                workingDirectory: null,
                options.ProcessTimeout,
                "test",
                options.Solution,
                "-c",
                "Release",
                "--no-build",
                "--nologo",
                "--filter",
                "Category=VmAcceptance|Category=Visual",
                "--results-directory",
                Path.Combine(options.Artifacts, "TestResults"),
                "--logger",
                "trx",
                "--blame-hang-timeout",
                $"{options.BlameTimeout.TotalMinutes:0}m");
            File.WriteAllText(
                Path.Combine(options.Artifacts, "test.log"),
                result.Output + result.Error);
            if (result.ExitCode != 0)
            {
                throw new InvalidOperationException(
                    $"Acceptance tests exited {result.ExitCode}.");
            }

            File.WriteAllText(options.ResultPath, "0");
            return 0;
        }
        catch (Exception exception)
            when (!IsFatal(exception))
        {
            File.WriteAllText(
                options.ErrorPath,
                exception.ToString());
            File.WriteAllText(options.ResultPath, "1");
            return 1;
        }
    }

    private static bool IsFatal(Exception exception) =>
        exception is OutOfMemoryException
        or StackOverflowException
        or AccessViolationException;
}

internal sealed record RunnerOptions(
    string Solution,
    string MarkerPath,
    string Artifacts,
    string ResultPath,
    string ErrorPath,
    TimeSpan BlameTimeout,
    TimeSpan ProcessTimeout)
{
    public static RunnerOptions Parse(string[] args)
    {
        var values = new Dictionary<string, string>(
            StringComparer.Ordinal);
        for (var index = 0; index < args.Length; index += 2)
        {
            if (index + 1 >= args.Length
                || !args[index].StartsWith(
                    "--",
                    StringComparison.Ordinal))
            {
                throw new ArgumentException(
                    "Runner arguments must be option/value pairs.");
            }
            values.Add(args[index], args[index + 1]);
        }

        if (!int.TryParse(
                Required(values, "--timeout-minutes"),
                NumberStyles.None,
                CultureInfo.InvariantCulture,
                out var timeoutMinutes)
            || timeoutMinutes is < 1 or > 120)
        {
            throw new ArgumentException(
                "--timeout-minutes must be between 1 and 120.");
        }

        return new RunnerOptions(
            Path.GetFullPath(Required(values, "--solution")),
            Path.GetFullPath(Required(values, "--marker")),
            Path.GetFullPath(Required(values, "--artifacts")),
            Path.GetFullPath(Required(values, "--result")),
            Path.GetFullPath(Required(values, "--error")),
            TimeSpan.FromMinutes(timeoutMinutes),
            TimeSpan.FromMinutes(timeoutMinutes + 2));
    }

    private static string Required(
        IReadOnlyDictionary<string, string> values,
        string option) =>
        values.TryGetValue(option, out var value)
        && !string.IsNullOrWhiteSpace(value)
            ? value
            : throw new ArgumentException(
                $"{option} is required.");
}
