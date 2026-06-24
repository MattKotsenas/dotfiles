namespace EventListeners.Tests;

/// <summary>Test double for <see cref="IWindowSweeper"/>; counts sweep invocations.</summary>
public sealed class FakeWindowSweeper : IWindowSweeper
{
    public int SweepCount { get; private set; }

    public Task SweepAsync(CancellationToken cancellationToken = default)
    {
        SweepCount++;
        return Task.CompletedTask;
    }
}
