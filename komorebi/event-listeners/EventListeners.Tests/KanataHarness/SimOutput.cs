namespace EventListeners.Tests.KanataHarness;

/// <summary>One emitted key event from the simulator.</summary>
public sealed record KeyEvent(string Direction, string Key);

public sealed record MouseMoveEvent(string Direction, int Distance);

public sealed record MouseScrollEvent(string Direction, int Distance);

public sealed record MouseButtonEvent(string Direction, string Button);

/// <summary>
/// Parsed result of running kanata_simulated_input against a config + sim input.
/// </summary>
public sealed record SimOutput(
    IReadOnlyList<string> Intents,
    IReadOnlyList<string> LayerNames,
    IReadOnlyList<string> KeyOutputs,
    IReadOnlyList<KeyEvent> KeyEvents,
    IReadOnlyList<MouseMoveEvent> MouseMoves,
    IReadOnlyList<MouseScrollEvent> MouseScrolls,
    IReadOnlyList<MouseButtonEvent> MouseButtons,
    string RawStdout,
    string RawStderr);
