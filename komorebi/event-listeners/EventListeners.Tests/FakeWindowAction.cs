using System.Collections.Concurrent;

namespace EventListeners.Tests;

/// <summary>
/// Test double for <see cref="IWindowAction"/>. Records all invocations.
/// Provides <see cref="WaitForCloseAsync"/> so tests can await asynchronous close calls
/// produced by <c>Task.Delay</c> continuations after <c>FakeTimeProvider.Advance</c>.
/// </summary>
public sealed class FakeWindowAction : IWindowAction
{
    private readonly ConcurrentQueue<long> _closedHwnds = new();
    private readonly SemaphoreSlim _closeSignal = new(0);
    private readonly ConcurrentQueue<(string Kind, byte R, byte G, byte B)> _borderColours = new();

    public IReadOnlyCollection<long> ClosedHwnds => _closedHwnds.ToArray();

    public IReadOnlyCollection<(string Kind, byte R, byte G, byte B)> BorderColours => _borderColours.ToArray();

    public int ToggleFloatCalls { get; private set; }

    public void Close(long hwnd)
    {
        _closedHwnds.Enqueue(hwnd);
        _closeSignal.Release();
    }

    public void ToggleFloat() => ToggleFloatCalls++;

    public void SetBorderColour(string windowKind, byte r, byte g, byte b)
    {
        _borderColours.Enqueue((windowKind, r, g, b));
    }

    /// <summary>
    /// Waits up to <paramref name="timeout"/> for the next Close call to be recorded.
    /// Returns true if a Close was observed; false on timeout.
    /// </summary>
    public Task<bool> WaitForCloseAsync(TimeSpan timeout) => _closeSignal.WaitAsync(timeout);
}
