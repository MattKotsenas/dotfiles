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

    public IReadOnlyCollection<long> ClosedHwnds => _closedHwnds.ToArray();

    public int ToggleFloatCalls { get; private set; }

    public void Close(long hwnd)
    {
        _closedHwnds.Enqueue(hwnd);
        _closeSignal.Release();
    }

    public void ToggleFloat() => ToggleFloatCalls++;

    /// <summary>
    /// Waits up to <paramref name="timeout"/> for the next Close call to be recorded.
    /// Returns true if a Close was observed; false on timeout.
    /// </summary>
    public Task<bool> WaitForCloseAsync(TimeSpan timeout) => _closeSignal.WaitAsync(timeout);
}
