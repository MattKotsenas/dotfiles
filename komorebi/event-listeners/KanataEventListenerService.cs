using System.Globalization;
using System.Net.Sockets;
using System.Text;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using EventListeners.Models;

namespace EventListeners;

/// <summary>
/// Background service that connects to kanata's TCP server and dispatches layer
/// change events to rules. Reconnects automatically if the connection drops.
///
/// Also exposes <see cref="IKanataClient"/> so other components can send
/// requests (e.g., ChangeLayer) over the same long-lived connection. Kanata's
/// TCP protocol is bidirectional: one client connection serves both event
/// broadcast and request submission.
/// </summary>
public sealed class KanataEventListenerService : ReconnectingBackgroundService, IKanataClient
{
    private readonly ILogger<KanataEventListenerService> _logger;
    private readonly IEnumerable<IEventRule> _rules;
    private readonly int _port;

    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private NetworkStream? _stream;

    public KanataEventListenerService(
        ILogger<KanataEventListenerService> logger,
        IEnumerable<IEventRule> rules,
        IConfiguration configuration)
        : base(logger)
    {
        _logger = logger;
        _rules = rules;
        _port = configuration.GetValue("Kanata:Port", 9999);
    }

    protected override string ConnectionDescription => "Kanata TCP";

    public async Task SendChangeLayerAsync(string layerName, CancellationToken cancellationToken = default)
    {
        var json = string.Format(
            CultureInfo.InvariantCulture,
            "{{\"ChangeLayer\":{{\"new\":\"{0}\"}}}}\n",
            layerName);
        await SendAsync(json, $"ChangeLayer({layerName})", cancellationToken);
    }

    public async Task TapVirtualKeyAsync(string virtualKeyName, CancellationToken cancellationToken = default)
    {
        var json = string.Format(
            CultureInfo.InvariantCulture,
            "{{\"ActOnFakeKey\":{{\"name\":\"{0}\",\"action\":\"Tap\"}}}}\n",
            virtualKeyName);
        await SendAsync(json, $"ActOnFakeKey({virtualKeyName})", cancellationToken);
    }

    private async Task SendAsync(
        string json,
        string description,
        CancellationToken cancellationToken)
    {
        var stream = _stream;
        if (stream is null)
        {
            _logger.LogWarning("Cannot send {Request}: kanata not connected yet", description);
            return;
        }

        var bytes = Encoding.UTF8.GetBytes(json);

        await _writeLock.WaitAsync(cancellationToken);
        try
        {
            await stream.WriteAsync(bytes, cancellationToken);
            await stream.FlushAsync(cancellationToken);
            _logger.LogDebug("Sent {Request}", description);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to send {Request}", description);
            // Stream will be re-established by the listener loop on reconnect
        }
        finally
        {
            _writeLock.Release();
        }
    }

    protected override async Task ConnectAndListenAsync(CancellationToken stoppingToken)
    {
        using var client = new TcpClient();
        await client.ConnectAsync("127.0.0.1", _port, stoppingToken);
        _logger.LogInformation("Connected to kanata TCP server on port {Port}", _port);

        await using var stream = client.GetStream();
        _stream = stream;
        try
        {
            using var reader = new StreamReader(stream);
            while (!stoppingToken.IsCancellationRequested)
            {
                var line = await reader.ReadLineAsync(stoppingToken);
                if (line is null) break;
                if (string.IsNullOrWhiteSpace(line)) continue;

                ProcessLine(line);
            }
        }
        finally
        {
            _stream = null;
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
