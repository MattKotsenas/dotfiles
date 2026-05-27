using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace EventListeners;

/// <summary>
/// BackgroundService that maintains a long-lived connection to an external system,
/// reconnecting with exponential backoff when the connection drops.
///
/// Derivatives implement <see cref="ConnectAndListenAsync"/> to establish the
/// connection and process events until it closes. Any thrown exception (other than
/// <see cref="OperationCanceledException"/> on shutdown) triggers a backoff retry.
/// </summary>
public abstract class ReconnectingBackgroundService : BackgroundService
{
    private static readonly TimeSpan DefaultInitialReconnectDelay = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan DefaultMaxReconnectDelay = TimeSpan.FromSeconds(30);

    private readonly ILogger _logger;

    protected ReconnectingBackgroundService(ILogger logger)
    {
        _logger = logger;
    }

    // Test-injectable. Production uses the defaults via the parameterless init.
    internal TimeSpan InitialReconnectDelay { get; init; } = DefaultInitialReconnectDelay;
    internal TimeSpan MaxReconnectDelay { get; init; } = DefaultMaxReconnectDelay;

    /// <summary>
    /// Short noun phrase identifying the connection in log messages
    /// (e.g. "Kanata TCP" or "Komorebi pipe").
    /// </summary>
    protected abstract string ConnectionDescription { get; }

    /// <summary>
    /// One-time setup invoked before the reconnect loop starts. Exceptions are not retried.
    /// </summary>
    protected virtual Task OnStartingAsync(CancellationToken stoppingToken) => Task.CompletedTask;

    /// <summary>
    /// Establishes the connection and processes events until the connection closes or
    /// <paramref name="stoppingToken"/> fires. Any exception triggers a backoff retry.
    /// </summary>
    protected abstract Task ConnectAndListenAsync(CancellationToken stoppingToken);

    protected sealed override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await OnStartingAsync(stoppingToken);

        var delay = InitialReconnectDelay;

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await ConnectAndListenAsync(stoppingToken);
                delay = InitialReconnectDelay;
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "{ConnectionDescription} connection lost, reconnecting in {Delay}s",
                    ConnectionDescription, delay.TotalSeconds);
            }

            try
            {
                await Task.Delay(delay, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }

            delay = TimeSpan.FromSeconds(Math.Min(delay.TotalSeconds * 2, MaxReconnectDelay.TotalSeconds));
        }
    }
}
