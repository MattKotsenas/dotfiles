using EventListeners.Tests.KanataHarness;

namespace EventListeners.Tests.Kanata;

/// <summary>
/// Sanity tests for the KanataSimulator harness itself.
/// Verifies the binary is built, the config is parseable, and basic
/// observations work end-to-end.
/// </summary>
[Trait("Category", "KanataHarness")]
public class KanataSimulatorSmokeTests
{
    [Fact]
    public void SimulatorBinary_Exists()
    {
        Assert.True(File.Exists(TestPaths.SimulatorBinary),
            $"kanata_simulated_input.exe not found at {TestPaths.SimulatorBinary}. " +
            "See kanata/sim/README.md for rebuild instructions.");
    }

    [Fact]
    public void ProductionConfig_Exists()
    {
        Assert.True(File.Exists(TestPaths.ProductionConfig),
            $"production kanata.kbd not found at {TestPaths.ProductionConfig}");
    }

    [Fact]
    public async Task EmptyInput_RunsSuccessfully()
    {
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput().Wait(10));

        // No intents fired, no key outputs, no errors
        Assert.Empty(output.Intents);
        Assert.Empty(output.KeyOutputs);
    }

    [Fact]
    public async Task TapCaps_F_L_FiresFocusRightIntent()
    {
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput().Tap("caps").Tap("f").Tap("l").Settle());

        Assert.Contains("wm.focus.right", output.Intents);
    }
}
