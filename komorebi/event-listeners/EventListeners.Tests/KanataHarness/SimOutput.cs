namespace EventListeners.Tests.KanataHarness;

/// <summary>
/// Parsed result of running kanata_simulated_input against a config + sim input.
/// </summary>
public sealed record SimOutput(
    IReadOnlyList<string> Intents,
    IReadOnlyList<string> LayerNames,
    IReadOnlyList<string> KeyOutputs,
    string RawStdout,
    string RawStderr)
{
    /// <summary>Final layer entered by the state machine.</summary>
    public string? FinalLayer => LayerNames.Count > 0 ? LayerNames[^1] : null;
}
