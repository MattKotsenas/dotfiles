using System.Net.Sockets;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using EventListeners.Models;

namespace EventListeners;

/// <summary>
/// Background service that connects to kanata's TCP server and dispatches layer
/// change events to rules. Reconnects automatically if the connection drops.
/// </summary>
public sealed class KanataEventListenerService : BackgroundService
{
    private readonly ILogger<KanataEventListenerService> _logger;
    private readonly IEnumerable<IEventRule> _rules;
    private readonly int _port;

    private static readonly TimeSpan InitialReconnectDelay = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan MaxReconnectDelay = TimeSpan.FromSeconds(30);

    public KanataEventListenerService(
        ILogger<KanataEventListenerService> logger,
        IEnumerable<IEventRule> rules,
        IConfiguration configuration)
    {
        _logger = logger;
        _rules = rules;
        _port = configuration.GetValue("Kanata:Port", 9999);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
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
                _logger.LogWarning(ex, "Kanata TCP connection lost, reconnecting in {Delay}s", delay.TotalSeconds);
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

    private async Task ConnectAndListenAsync(CancellationToken stoppingToken)
    {
        using var client = new TcpClient();
        await client.ConnectAsync("127.0.0.1", _port, stoppingToken);
        _logger.LogInformation("Connected to kanata TCP server on port {Port}", _port);

        await using var stream = client.GetStream();
        using var reader = new StreamReader(stream);

        while (!stoppingToken.IsCancellationRequested)
        {
            var line = await reader.ReadLineAsync(stoppingToken);
            if (line is null) break;
            if (string.IsNullOrWhiteSpace(line)) continue;

            ProcessLine(line);
        }
    }

    private void ProcessLine(string line)
    {
        var evt = ParseEvent(line);
        if (evt is null) return;

        _logger.LogDebug("Kanata event: {EventType}", evt.GetType().Name);

        foreach (var rule in _rules)
        {
            try
            {
                rule.ProcessEvent(evt);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Rule '{RuleName}' threw processing {EventType}", rule.Name, evt.GetType().Name);
            }
        }
    }

    /// <summary>
    /// Parses a kanata TCP JSON line into an <see cref="IEvent"/>.
    /// Returns null for unrecognized or malformed lines.
    /// </summary>
    internal static IEvent? ParseEvent(string line)
    {
        // Format: {"LayerChange":{"new":"base"}}
        if (line.Contains("LayerChange"))
        {
            var newIdx = line.IndexOf("\"new\"", StringComparison.Ordinal);
            if (newIdx < 0) return null;
            var colonIdx = line.IndexOf(':', newIdx + 5);
            if (colonIdx < 0) return null;
            var quoteStart = line.IndexOf('"', colonIdx + 1);
            var quoteEnd = line.IndexOf('"', quoteStart + 1);
            if (quoteStart < 0 || quoteEnd < 0) return null;

            return new KanataLayerChangeEvent(line[(quoteStart + 1)..quoteEnd]);
        }

        // Format: {"MessagePush":{"message":"komorebic focus left"}}
        if (line.Contains("MessagePush"))
        {
            var msgIdx = line.IndexOf("\"message\"", StringComparison.Ordinal);
            if (msgIdx < 0) return null;
            var colonIdx = line.IndexOf(':', msgIdx + 9);
            if (colonIdx < 0) return null;
            var quoteStart = line.IndexOf('"', colonIdx + 1);
            var quoteEnd = line.IndexOf('"', quoteStart + 1);
            if (quoteStart < 0 || quoteEnd < 0) return null;

            return new KanataMessageEvent(line[(quoteStart + 1)..quoteEnd]);
        }

        return null;
    }
}
