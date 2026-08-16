using PointerUi.Windows;

namespace PointerUi.Recorder;

public sealed record RecorderOptions(
    string OutputPath,
    string FixtureName,
    CaptureLimits Limits,
    bool Overwrite)
{
    public string DiagnosticsPath
    {
        get
        {
            var directory = Path.GetDirectoryName(OutputPath)
                ?? string.Empty;
            var fileName = Path.GetFileNameWithoutExtension(OutputPath);
            return Path.Combine(
                directory,
                $"{fileName}.diagnostics.json");
        }
    }
}

public sealed record RecorderParseResult(
    RecorderOptions? Options,
    string? Error,
    bool ShowHelp)
{
    public static RecorderParseResult Parse(string[] args)
    {
        string? output = null;
        string? name = null;
        var maxDepth = CaptureLimits.Default.MaxDepth;
        var maxElements =
            CaptureLimits.Default.MaxElementsPerWindow;
        var overwrite = false;
        var allowLiveCapture = false;

        for (var index = 0; index < args.Length; index++)
        {
            switch (args[index])
            {
                case "--help" or "-h":
                    return new RecorderParseResult(null, null, true);
                case "--allow-live-desktop-capture":
                    allowLiveCapture = true;
                    break;
                case "--overwrite":
                    overwrite = true;
                    break;
                case "--output":
                    if (!TryValue(args, ref index, out output))
                    {
                        return Failure("--output requires a path.");
                    }
                    break;
                case "--name":
                    if (!TryValue(args, ref index, out name))
                    {
                        return Failure("--name requires a fixture name.");
                    }
                    break;
                case "--max-depth":
                    if (!TryInt(args, ref index, out maxDepth))
                    {
                        return Failure("--max-depth requires an integer.");
                    }
                    break;
                case "--max-elements-per-window":
                    if (!TryInt(args, ref index, out maxElements))
                    {
                        return Failure(
                            "--max-elements-per-window requires an integer.");
                    }
                    break;
                default:
                    return Failure($"Unknown argument '{args[index]}'.");
            }
        }

        if (!allowLiveCapture)
        {
            return Failure(
                "Live desktop capture is disabled. Run only in the dedicated VM with --allow-live-desktop-capture.");
        }
        if (string.IsNullOrWhiteSpace(output))
        {
            return Failure("--output is required.");
        }
        if (!string.Equals(
                Path.GetExtension(output),
                ".json",
                StringComparison.OrdinalIgnoreCase))
        {
            return Failure("--output must name a .json file.");
        }
        if (string.IsNullOrWhiteSpace(name))
        {
            return Failure("--name is required.");
        }

        var limits = new CaptureLimits(maxDepth, maxElements);
        try
        {
            limits.Validate();
        }
        catch (ArgumentOutOfRangeException exception)
        {
            return Failure(exception.Message);
        }

        return new RecorderParseResult(
            new RecorderOptions(
                Path.GetFullPath(output),
                name,
                limits,
                overwrite),
            null,
            false);
    }

    private static bool TryValue(
        IReadOnlyList<string> args,
        ref int index,
        out string? value)
    {
        if (index + 1 >= args.Count)
        {
            value = null;
            return false;
        }
        value = args[++index];
        return !string.IsNullOrWhiteSpace(value);
    }

    private static bool TryInt(
        IReadOnlyList<string> args,
        ref int index,
        out int value)
    {
        if (!TryValue(args, ref index, out var raw))
        {
            value = 0;
            return false;
        }
        return int.TryParse(
            raw,
            System.Globalization.NumberStyles.None,
            System.Globalization.CultureInfo.InvariantCulture,
            out value);
    }

    private static RecorderParseResult Failure(string error) =>
        new(null, error, false);
}
