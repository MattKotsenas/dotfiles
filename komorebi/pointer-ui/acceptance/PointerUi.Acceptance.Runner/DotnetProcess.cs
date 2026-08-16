using System.Diagnostics;

namespace PointerUi.Acceptance.Runner;

internal static class DotnetProcess
{
    public static Process Start(
        string? workingDirectory,
        params string[] arguments)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            WorkingDirectory = workingDirectory,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        foreach (var argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        return Process.Start(startInfo)
            ?? throw new InvalidOperationException(
                "dotnet did not start.");
    }

    public static async Task<DotnetProcessResult> RunAsync(
        string? workingDirectory,
        TimeSpan timeout,
        params string[] arguments)
    {
        using var process = Start(
            workingDirectory,
            arguments);
        try
        {
            var output = process.StandardOutput.ReadToEndAsync();
            var error = process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync().WaitAsync(timeout);
            return new DotnetProcessResult(
                process.ExitCode,
                await output,
                await error);
        }
        finally
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync();
            }
        }
    }
}

internal sealed record DotnetProcessResult(
    int ExitCode,
    string Output,
    string Error);
