using System.Globalization;
using System.Net.Sockets;
using System.Text;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace EventListeners;

/// <summary>
/// Sends requests to kanata's TCP server. Opens a fresh connection per request --
/// requests are infrequent (one per focus change) so per-send overhead is fine,
/// and the simple "open, write, close" pattern avoids stale-connection bugs.
/// </summary>
public sealed class TcpKanataClient : IKanataClient
{
    private readonly ILogger<TcpKanataClient> _logger;
    private readonly int _port;

    public TcpKanataClient(ILogger<TcpKanataClient> logger, IConfiguration configuration)
    {
        _logger = logger;
        _port = configuration.GetValue("Kanata:Port", 9999);
    }

    public async Task SendChangeLayerAsync(string layerName, CancellationToken cancellationToken = default)
    {
        var json = string.Format(CultureInfo.InvariantCulture, "{{\"ChangeLayer\":{{\"new\":\"{0}\"}}}}\n", layerName);
        var bytes = Encoding.UTF8.GetBytes(json);

        try
        {
            using var client = new TcpClient();
            await client.ConnectAsync("127.0.0.1", _port, cancellationToken);
            await using var stream = client.GetStream();
            await stream.WriteAsync(bytes, cancellationToken);
            _logger.LogDebug("Sent ChangeLayer({Layer}) to kanata", layerName);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to send ChangeLayer({Layer}) to kanata", layerName);
        }
    }
}
