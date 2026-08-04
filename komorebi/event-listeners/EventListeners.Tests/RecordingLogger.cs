using Microsoft.Extensions.Logging;

namespace EventListeners.Tests;

/// <summary>
/// Records what a rule logged, so a test can assert that ordinary traffic passes
/// without complaint rather than only that it takes no action.
/// </summary>
public sealed class RecordingLogger<T> : ILogger<T>
{
    private readonly List<string> _warnings = [];

    public IReadOnlyList<string> Warnings
    {
        get { lock (_warnings) { return _warnings.ToArray(); } }
    }

    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

    public bool IsEnabled(LogLevel logLevel) => true;

    public void Log<TState>(
        LogLevel logLevel,
        EventId eventId,
        TState state,
        Exception? exception,
        Func<TState, Exception?, string> formatter)
    {
        if (logLevel < LogLevel.Warning) return;

        lock (_warnings)
        {
            _warnings.Add(formatter(state, exception));
        }
    }
}
