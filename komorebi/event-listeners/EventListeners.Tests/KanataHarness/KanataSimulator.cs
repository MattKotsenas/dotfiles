using System.Text.RegularExpressions;
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

    // [INFO] Entered layer: ... (deflayermap (NAME) ...)
    // The layer body follows on subsequent lines; we extract the layer name.
    private static readonly Regex LayerPattern = new(
        @"\(deflayermap\s+\((?<layer>[\w-]+)\)",
        RegexOptions.Compiled);

    // stdout key event lines:
    //   out:↓Escape
    //   out:↑Escape
    private static readonly Regex KeyOutPattern = new(
        @"^out:(?<dir>[↓↑])(?<key>\S+)",
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
            try { File.Delete(simFile); } catch { /* best-effort */ }
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
            var keyMatch = KeyOutPattern.Match(line.Trim());
            if (keyMatch.Success)
            {
                var dir = keyMatch.Groups["dir"].Value == "↓" ? "down" : "up";
                keyOutputs.Add($"{dir}:{keyMatch.Groups["key"].Value}");
            }
        }

        return new SimOutput(intents, layers, keyOutputs, stdout, stderr);
    }
}
