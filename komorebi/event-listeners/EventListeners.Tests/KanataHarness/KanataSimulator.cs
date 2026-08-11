using System.Text.RegularExpressions;
using System.Globalization;
using CliWrap;
using CliWrap.Buffered;

namespace EventListeners.Tests.KanataHarness;

/// <summary>
/// Wraps the patched <c>kanata_simulated_input.exe</c> binary so tests can
/// run kanata configs deterministically without installing OS keyboard hooks.
///
/// Usage:
/// <code>
/// var output = await KanataSimulator.RunAsync(
///     config: TestPaths.ProductionConfig,
///     input: new SimInput().Tap("caps").Tap("f").Tap("l").Settle());
/// Assert.Contains("wm.focus.right", output.Intents);
/// </code>
/// </summary>
public static class KanataSimulator
{
    // INFO log lines from the patched binary include push-msg payloads:
    //   [INFO] push-msg: [Atom("wm.focus.right")]
    private static readonly Regex PushMsgPattern = new(
        @"push-msg:\s*\[Atom\(""(?<msg>[^""]+)""\)\]",
        RegexOptions.Compiled);

    // Runtime layer transitions logged by kanata:
    //   [INFO] layer-switch: base-terminal (index 3)
    // Also matches the initial layer set via `ls:NAME` sim input.
    private static readonly Regex LayerPattern = new(
        @"layer-switch:\s+(?<layer>[\w-]+)",
        RegexOptions.Compiled);

    // stdout key event lines:
    //   out:↓Escape
    //   out:↑Escape
    private static readonly Regex KeyOutPattern = new(
        @"^out:(?<dir>[↓↑])(?<key>\S+)",
        RegexOptions.Compiled);

    private static readonly Regex MouseMovePattern = new(
        @"^out🖰:move (?<direction>\w+),(?<distance>\d+)",
        RegexOptions.Compiled);

    private static readonly Regex MouseScrollPattern = new(
        @"^scroll:(?<direction>\w+),(?<distance>\d+)",
        RegexOptions.Compiled);

    private static readonly Regex MouseButtonPattern = new(
        @"^out🖰:(?<direction>[↓↑])(?<button>\w+)",
        RegexOptions.Compiled);

    public static async Task<SimOutput> RunAsync(string config, SimInput input)
    {
        var binary = TestPaths.SimulatorBinary;
        var simFile = await WriteSimFileAsync(input);

        try
        {
            var result = await Cli.Wrap(binary)
                .WithArguments(args => args.Add("-c").Add(config).Add("-s").Add(simFile))
                .WithValidation(CommandResultValidation.None)
                .ExecuteBufferedAsync();

            return Parse(result.StandardOutput, result.StandardError);
        }
        finally
        {
            try
            {
                File.Delete(simFile);
            }
            catch (IOException exception)
            {
                Console.Error.WriteLine(
                    $"Unable to delete simulator input '{simFile}': {exception.Message}");
            }
            catch (UnauthorizedAccessException exception)
            {
                Console.Error.WriteLine(
                    $"Unable to delete simulator input '{simFile}': {exception.Message}");
            }
        }
    }

    private static async Task<string> WriteSimFileAsync(SimInput input)
    {
        var path = Path.Combine(Path.GetTempPath(), $"kanata-sim-{Guid.NewGuid():N}.sim");
        await File.WriteAllTextAsync(path, input.ToString());
        return path;
    }

    private static SimOutput Parse(string stdout, string stderr)
    {
        var intents = new List<string>();
        var layers = new List<string>();
        var keyOutputs = new List<string>();
        var keyEvents = new List<KeyEvent>();
        var mouseMoves = new List<MouseMoveEvent>();
        var mouseScrolls = new List<MouseScrollEvent>();
        var mouseButtons = new List<MouseButtonEvent>();

        foreach (var line in stderr.Split('\n'))
        {
            var pushMatch = PushMsgPattern.Match(line);
            if (pushMatch.Success)
            {
                intents.Add(pushMatch.Groups["msg"].Value);
            }

            var layerMatch = LayerPattern.Match(line);
            if (layerMatch.Success)
            {
                layers.Add(layerMatch.Groups["layer"].Value);
            }
        }

        foreach (var line in stdout.Split('\n'))
        {
            var trimmed = line.Trim();
            var keyMatch = KeyOutPattern.Match(trimmed);
            if (keyMatch.Success)
            {
                var arrow = keyMatch.Groups["dir"].Value;
                var key = keyMatch.Groups["key"].Value;
                var dir = arrow == "↓" ? "down" : "up";
                keyOutputs.Add($"{dir}:{key}");
                keyEvents.Add(new KeyEvent(arrow, key));
            }

            var moveMatch = MouseMovePattern.Match(trimmed);
            if (moveMatch.Success)
            {
                mouseMoves.Add(new MouseMoveEvent(
                    moveMatch.Groups["direction"].Value,
                    int.Parse(
                        moveMatch.Groups["distance"].Value,
                        CultureInfo.InvariantCulture)));
            }

            var scrollMatch = MouseScrollPattern.Match(trimmed);
            if (scrollMatch.Success)
            {
                mouseScrolls.Add(new MouseScrollEvent(
                    scrollMatch.Groups["direction"].Value,
                    int.Parse(
                        scrollMatch.Groups["distance"].Value,
                        CultureInfo.InvariantCulture)));
            }

            var buttonMatch = MouseButtonPattern.Match(trimmed);
            if (buttonMatch.Success)
            {
                mouseButtons.Add(new MouseButtonEvent(
                    buttonMatch.Groups["direction"].Value,
                    buttonMatch.Groups["button"].Value));
            }
        }

        return new SimOutput(
            intents,
            layers,
            keyOutputs,
            keyEvents,
            mouseMoves,
            mouseScrolls,
            mouseButtons,
            stdout,
            stderr);
    }
}
