using System.Text;

namespace EventListeners.Tests.KanataHarness;

/// <summary>
/// Fluent builder for kanata_simulated_input simulation files.
///
/// Generates lines of: <c>d:KEY t:MS u:KEY t:MS</c>
/// where d=down, u=up, t=tick.
/// </summary>
public sealed class SimInput
{
    private readonly StringBuilder _sb = new();
    private const int DefaultBetweenTaps = 10;
    private const int DefaultHoldDuration = 10;

    /// <summary>
    /// Tap (down then up) a key with the default hold duration.
    /// Adds a small delay after for the state machine to settle.
    /// </summary>
    public SimInput Tap(string key)
    {
        _sb.Append($"d:{key} t:{DefaultHoldDuration} u:{key} t:{DefaultBetweenTaps} ");
        return this;
    }

    /// <summary>Press a key down, no release.</summary>
    public SimInput Down(string key)
    {
        _sb.Append($"d:{key} ");
        return this;
    }

    /// <summary>Release a key.</summary>
    public SimInput Up(string key)
    {
        _sb.Append($"u:{key} ");
        return this;
    }

    /// <summary>Advance simulation time by N milliseconds.</summary>
    public SimInput Wait(int milliseconds)
    {
        _sb.Append($"t:{milliseconds} ");
        return this;
    }

    /// <summary>
    /// Switch the active kanata layer (mirrors what TCP ChangeLayer does in
    /// production). Use this to simulate a particular focus context for
    /// overlay tests.
    /// </summary>
    public SimInput Layer(string layerName)
    {
        _sb.Append($"ls:{layerName} ");
        return this;
    }

    /// <summary>
    /// Append a final settle period so any pending tap-dance / tap-hold
    /// timers resolve before the simulation ends.
    /// </summary>
    public SimInput Settle(int milliseconds = 500)
    {
        return Wait(milliseconds);
    }

    public override string ToString() => _sb.ToString().TrimEnd();
}
