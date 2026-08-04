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
    private readonly ConcurrentQueue<string> _actions = new();
    private readonly ConcurrentQueue<string> _borderWrites = new();

    public IReadOnlyCollection<long> ClosedHwnds => _closedHwnds.ToArray();

    public int ToggleFloatCalls { get; private set; }

    /// <summary>
    /// Set false to make <see cref="MoveToMonitorAsync"/> report failure.
    /// </summary>
    public bool MoveSucceeds { get; set; } = true;

    /// <summary>
    /// When set, <see cref="MoveToMonitorAsync"/> waits on it, so a test can hold a
    /// placement mid-flight and drive another event past it.
    /// </summary>
    public TaskCompletionSource? BlockMove { get; set; }

    /// <summary>
    /// The window <see cref="GetForegroundWindow"/> reports. Set it mid-placement to
    /// simulate focus moving to another window between komorebic commands.
    /// </summary>
    public long ForegroundWindow { get; set; }

    /// <summary>
    /// Komorebic actions in the order they were invoked, each tagged with the window
    /// that held the foreground when it ran, since that is the window komorebic acts
    /// on. A test that recorded only the command names could not tell a placement
    /// that hit the right window from one that hit the wrong one.
    /// </summary>
    public IReadOnlyList<string> Actions => _actions.ToArray();

    public void Close(long hwnd)
    {
        _closedHwnds.Enqueue(hwnd);
        _closeSignal.Release();
    }

    public void ToggleFloat() => ToggleFloatCalls++;

    /// <summary>
    /// When set, <see cref="SetBorderColourAsync"/> waits on it, so a test can hold
    /// a recolour in flight and drive another layer change past it.
    /// </summary>
    public TaskCompletionSource? BlockBorder { get; set; }

    public long GetForegroundWindow() => ForegroundWindow;

    /// <summary>
    /// Set false to make <see cref="SetBorderColourAsync"/> report failure.
    /// </summary>
    public bool BorderWriteSucceeds { get; set; } = true;

    public async Task<bool> SetBorderColourAsync(BorderWindowKind kind, BorderColour colour)
    {
        _borderWrites.Enqueue($"{kind} {colour.R},{colour.G},{colour.B}");

        if (BlockBorder is { } block)
        {
            await block.Task;
        }

        return BorderWriteSucceeds;
    }

    /// <summary>Border colours written, in the order they were requested.</summary>
    public IReadOnlyList<string> BorderWrites => _borderWrites.ToArray();

    public async Task<bool> MoveToMonitorAsync(int monitorIndex)
    {
        _actions.Enqueue($"move-to-monitor {monitorIndex} on {ForegroundWindow}");

        if (BlockMove is { } block)
        {
            await block.Task;
        }

        return MoveSucceeds;
    }

    public Task PromoteAsync()
    {
        _actions.Enqueue($"promote on {ForegroundWindow}");
        return Task.CompletedTask;
    }

    /// <summary>
    /// Waits up to <paramref name="timeout"/> for the next Close call to be recorded.
    /// Returns true if a Close was observed; false on timeout.
    /// </summary>
    public Task<bool> WaitForCloseAsync(TimeSpan timeout) => _closeSignal.WaitAsync(timeout);
}
