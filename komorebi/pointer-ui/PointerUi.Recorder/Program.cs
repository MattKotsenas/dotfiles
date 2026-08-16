using System.ComponentModel;
using System.Runtime.InteropServices;
using PointerUi.Windows;

namespace PointerUi.Recorder;

public static class Program
{
    [MTAThread]
    public static int Main(string[] args)
    {
        var parsed = RecorderParseResult.Parse(args);
        if (parsed.ShowHelp)
        {
            Console.WriteLine(Usage);
            return 0;
        }
        if (parsed.Error is not null)
        {
            Console.Error.WriteLine(parsed.Error);
            Console.Error.WriteLine(Usage);
            return 2;
        }

        var options = parsed.Options
            ?? throw new InvalidOperationException(
                "Successful parsing returned no options.");
        if (!options.Overwrite
            && (File.Exists(options.OutputPath)
                || File.Exists(options.DiagnosticsPath)))
        {
            Console.Error.WriteLine(
                "Output already exists. Use --overwrite to replace it.");
            return 2;
        }

        try
        {
            var captured = new WindowsDesktopCaptureSource()
                .Capture(options.Limits, options.ProcessKey);
            var projected = DiscoveryProjector.Project(
                captured.Capture,
                options.FixtureName,
                new WindowRoleSession());
            var diagnostics = captured.Diagnostics
                .Concat(projected.Diagnostics)
                .OrderBy(
                    diagnostic => diagnostic.Code,
                    StringComparer.Ordinal)
                .ThenBy(
                    diagnostic => diagnostic.Window,
                    StringComparer.Ordinal)
                .ToList();

            FixtureDocument.Write(
                options.OutputPath,
                projected.Fixture,
                options.Overwrite);
            FixtureDocument.WriteDiagnostics(
                options.DiagnosticsPath,
                diagnostics,
                options.Overwrite);

            Console.WriteLine(
                $"Captured {projected.Fixture.Windows.Count} windows and "
                + $"{projected.Fixture.Windows.Sum(window => window.Targets.Count)} targets.");
            Console.WriteLine($"Fixture: {options.OutputPath}");
            Console.WriteLine($"Diagnostics: {options.DiagnosticsPath}");
            return 0;
        }
        catch (Exception exception)
            when (exception is COMException
                or Win32Exception
                or InvalidOperationException
                or ArgumentException)
        {
            Console.Error.WriteLine(
                $"Windows desktop capture failed: {exception.Message}");
            return 1;
        }
        catch (Exception exception)
            when (exception is IOException
                or UnauthorizedAccessException)
        {
            Console.Error.WriteLine(
                $"Writing the capture failed: {exception.Message}");
            return 1;
        }
    }

    private static string Usage =>
        $"""
        PointerUi.Recorder
          --allow-live-desktop-capture
          --output <fixture.json>
          --name <fixture-name>
          [--process <executable-name>]
          [--max-depth <{CaptureLimits.MinDepth}-{CaptureLimits.MaxDepthLimit}>]
          [--max-elements-per-window <{CaptureLimits.MinElementsPerWindow}-{CaptureLimits.MaxElementsPerWindowLimit}>]
          [--overwrite]

        This command reads the live Windows desktop. Run it only in the dedicated VM.
        """;
}
