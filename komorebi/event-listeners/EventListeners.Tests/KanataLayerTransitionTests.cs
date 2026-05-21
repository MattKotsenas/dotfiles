using System.Net.Sockets;
using System.Text.Json;

namespace EventListeners.Tests;

/// <summary>
/// Tests kanata layer transitions and push-msg actions by connecting to the
/// running kanata TCP server and sending ActOnFakeKey commands.
///
/// These tests require kanata to be running with --port 9999 and the current
/// kanata.kbd config loaded. They are integration tests, not unit tests.
///
/// Skip with: dotnet test --filter "Category!=KanataIntegration"
/// </summary>
[Trait("Category", "KanataIntegration")]
public class KanataLayerTransitionTests : IAsyncLifetime
{
    private TcpClient _client = null!;
    private StreamReader _reader = null!;
    private StreamWriter _writer = null!;
    private readonly List<KanataEvent> _events = [];

    private const int Port = 9999;
    private const int EventWaitMs = 500;

    public async Task InitializeAsync()
    {
        _client = new TcpClient();
        await _client.ConnectAsync("127.0.0.1", Port);
        var stream = _client.GetStream();
        _reader = new StreamReader(stream);
        _writer = new StreamWriter(stream) { AutoFlush = true };

        // Read initial LayerChange event (kanata sends current layer on connect)
        await ReadEventsAsync(1);
        _events.Clear();
    }

    public Task DisposeAsync()
    {
        // Return to base layer by sending Escape (CapsLock emergency)
        _reader.Dispose();
        _writer.Dispose();
        _client.Dispose();
        return Task.CompletedTask;
    }

    [Fact]
    public async Task SingleTap_ThenWorkspaceKey_ReturnsToBase()
    {
        await SendFakeKey("caps", "Tap");
        await Task.Delay(300); // wait past tap-dance timeout
        await ReadEventsAsync(1);

        Assert.Contains(_events, e => e.LayerName == "wm");

        _events.Clear();
        await SendFakeKey("1", "Tap");
        await ReadEventsAsync(2); // expect: message + layer back to base

        Assert.Contains(_events, e => e.Message == "komorebic focus-workspaces 0");
        Assert.Contains(_events, e => e.LayerName == "base");
    }

    [Fact]
    public async Task SingleTap_Focus_ReturnsToBase()
    {
        await SendFakeKey("caps", "Tap");
        await Task.Delay(300);
        await ReadEventsAsync(1);
        _events.Clear();

        await SendFakeKey("f", "Tap");
        await ReadEventsAsync(1); // enter wm-focus
        Assert.Contains(_events, e => e.LayerName == "wm-focus");

        _events.Clear();
        await SendFakeKey("l", "Tap");
        await ReadEventsAsync(2); // message + back to base

        Assert.Contains(_events, e => e.Message == "komorebic focus right");
        Assert.Contains(_events, e => e.LayerName == "base");
    }

    [Fact]
    public async Task DoubleTap_EntersToggleMode()
    {
        await SendFakeKey("caps", "Tap");
        await Task.Delay(50); // within tap-dance window
        await SendFakeKey("caps", "Tap");
        await Task.Delay(300);
        await ReadEventsAsync(1);

        Assert.Contains(_events, e => e.LayerName == "wm-toggle");
    }

    [Fact]
    public async Task ToggleMode_SubModSticky()
    {
        // Enter toggle mode
        await SendFakeKey("caps", "Tap");
        await Task.Delay(50);
        await SendFakeKey("caps", "Tap");
        await Task.Delay(300);
        await ReadEventsAsync(1);
        _events.Clear();

        // Press D to enter move toggle
        await SendFakeKey("d", "Tap");
        await ReadEventsAsync(1);
        Assert.Contains(_events, e => e.LayerName == "wm-move-toggle");

        // Press H - should stay in wm-move-toggle (no layer change, just message)
        _events.Clear();
        await SendFakeKey("h", "Tap");
        await ReadEventsAsync(1);
        Assert.Contains(_events, e => e.Message == "komorebic move left");
        Assert.DoesNotContain(_events, e => e.LayerName is not null);

        // Press L - still in wm-move-toggle
        _events.Clear();
        await SendFakeKey("l", "Tap");
        await ReadEventsAsync(1);
        Assert.Contains(_events, e => e.Message == "komorebic move right");

        // Exit with CapsLock
        _events.Clear();
        await SendFakeKey("caps", "Tap");
        await Task.Delay(300);
        await ReadEventsAsync(1);
        Assert.Contains(_events, e => e.LayerName == "base");
    }

    [Fact]
    public async Task ToggleMode_SubModSwitching()
    {
        // Enter toggle mode
        await SendFakeKey("caps", "Tap");
        await Task.Delay(50);
        await SendFakeKey("caps", "Tap");
        await Task.Delay(300);
        await ReadEventsAsync(1);
        _events.Clear();

        // D → move mode
        await SendFakeKey("d", "Tap");
        await ReadEventsAsync(1);
        Assert.Contains(_events, e => e.LayerName == "wm-move-toggle");

        // S → switch to stack mode
        _events.Clear();
        await SendFakeKey("s", "Tap");
        await ReadEventsAsync(1);
        Assert.Contains(_events, e => e.LayerName == "wm-stack-toggle");

        // Exit
        _events.Clear();
        await SendFakeKey("caps", "Tap");
        await Task.Delay(300);
        await ReadEventsAsync(1);
        Assert.Contains(_events, e => e.LayerName == "base");
    }

    [Fact]
    public async Task DeadKey_UnmappedKeysBlocked()
    {
        await SendFakeKey("caps", "Tap");
        await Task.Delay(300);
        await ReadEventsAsync(1);
        _events.Clear();

        // Press 'z' - unmapped, should be deadkeyed (no events)
        await SendFakeKey("z", "Tap");
        await Task.Delay(200);

        // Read whatever came through
        _client.GetStream().ReadTimeout = 200;
        try
        {
            var line = await _reader.ReadLineAsync();
            if (line is not null)
            {
                var parsed = ParseEvent(line);
                if (parsed is not null) _events.Add(parsed);
            }
        }
        catch (IOException) { }
        catch (TimeoutException) { }

        // Should have no message events (deadkeyed)
        Assert.DoesNotContain(_events, e => e.Message is not null);
    }

    private async Task SendFakeKey(string key, string action)
    {
        var json = JsonSerializer.Serialize(new { ActOnFakeKey = new { name = key, action } });
        await _writer.WriteLineAsync(json);
    }

    private async Task ReadEventsAsync(int expectedCount)
    {
        _client.GetStream().ReadTimeout = EventWaitMs;
        for (var i = 0; i < expectedCount + 2; i++) // read a few extra in case
        {
            try
            {
                var line = await _reader.ReadLineAsync();
                if (line is null) break;
                var parsed = ParseEvent(line);
                if (parsed is not null) _events.Add(parsed);
            }
            catch (IOException) { break; }
            catch (TimeoutException) { break; }
        }
    }

    private static KanataEvent? ParseEvent(string line)
    {
        if (line.Contains("LayerChange"))
        {
            var idx = line.IndexOf("\"new\"", StringComparison.Ordinal);
            if (idx < 0) return null;
            var colon = line.IndexOf(':', idx + 5);
            var qs = line.IndexOf('"', colon + 1);
            var qe = line.IndexOf('"', qs + 1);
            if (qs < 0 || qe < 0) return null;
            return new KanataEvent { LayerName = line[(qs + 1)..qe] };
        }

        if (line.Contains("MessagePush"))
        {
            var idx = line.IndexOf("\"message\"", StringComparison.Ordinal);
            if (idx < 0) return null;
            var colon = line.IndexOf(':', idx + 9);
            var qs = line.IndexOf('"', colon + 1);
            var qe = line.IndexOf('"', qs + 1);
            if (qs < 0 || qe < 0) return null;
            return new KanataEvent { Message = line[(qs + 1)..qe] };
        }

        return null;
    }

    private sealed class KanataEvent
    {
        public string? LayerName { get; init; }
        public string? Message { get; init; }
    }
}
