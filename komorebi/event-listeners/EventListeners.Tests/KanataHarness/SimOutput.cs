namespace EventListeners.Tests.KanataHarness;

/// <summary>One emitted key event from the simulator.</summary>
public sealed record KeyEvent(string Direction, string Key);

/// <summary>
/// Parsed result of running kanata_simulated_input against a config + sim input.
/// </summary>
public sealed record SimOutput(
    IReadOnlyList<string> Intents,
    IReadOnlyList<string> LayerNames,
    IReadOnlyList<string> KeyOutputs,
    IReadOnlyList<KeyEvent> KeyEvents,
    string RawStdout,
    string RawStderr)
{
    /// <summary>Final layer entered by the state machine.</summary>
    public string? FinalLayer => LayerNames.Count > 0 ? LayerNames[^1] : null;
}
