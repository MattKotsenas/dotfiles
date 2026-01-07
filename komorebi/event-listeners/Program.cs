using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace EventListeners;

/// <summary>
/// Exit codes for the application.
/// </summary>
public static class ExitCodes
{
    public const int Success = 0;
    public const int SubscriptionFailed = 1;
    public const int UnsubscriptionFailed = 2;
    public const int PipeConnectionFailed = 3;
    public const int UnexpectedError = 99;
}

/// <summary>
/// Native Win32 interop methods.
/// </summary>
public static partial class Win32
{
    public const uint WM_CLOSE = 0x0010;

    [LibraryImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool PostMessageW(nint hWnd, uint msg, nint wParam, nint lParam);
}

/// <summary>
/// Represents the event type information in a Komorebi event.
/// The content can be either a string or a window object depending on the event type.
/// </summary>
public sealed class KomorebiEventType
{
    public string? Type { get; set; }
    public JsonElement? Content { get; set; }
}

/// <summary>
/// Represents a window in the Komorebi state.
/// </summary>
public sealed class KomorebiWindow
{
    public long Hwnd { get; set; }
    public string? Title { get; set; }
    public string? Exe { get; set; }
    public string? Class { get; set; }
}

/// <summary>
/// Represents a Komorebi window event.
/// </summary>
public sealed class KomorebiEvent
{
    public KomorebiEventType? Event { get; set; }
    public JsonElement? State { get; set; }
}

/// <summary>
/// Background service that listens to Komorebi events via a named pipe.
/// </summary>
public sealed class KomorebiEventListenerService : BackgroundService
{
    private const int CloseDelayMilliseconds = 2000;

    private readonly string _pipeName;
    private readonly ILogger<KomorebiEventListenerService> _logger;
    private readonly IHostApplicationLifetime _appLifetime;
    private bool _subscribed;

    /// <summary>
    /// Tracks windows pending close. Key is HWND, value is the CancellationTokenSource to cancel the close.
    /// </summary>
    private readonly ConcurrentDictionary<long, CancellationTokenSource> _pendingCloses = new();

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true
    };

    public KomorebiEventListenerService(
        ILogger<KomorebiEventListenerService> logger,
        IHostApplicationLifetime appLifetime)
    {
        _logger = logger;
        _appLifetime = appLifetime;
        _pipeName = $"komorebi-event-{Guid.NewGuid()}";
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await using var pipeServer = new NamedPipeServerStream(
                _pipeName,
                PipeDirection.In,
                1,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous);

            _logger.LogInformation("Created named pipe: {PipeName}", _pipeName);

            // Subscribe to Komorebi events
            if (!await SubscribeToPipeAsync())
            {
                Environment.ExitCode = ExitCodes.SubscriptionFailed;
                _appLifetime.StopApplication();
                return;
            }

            _subscribed = true;

            _logger.LogInformation("Waiting for Komorebi to connect...");

            try
            {
                await pipeServer.WaitForConnectionAsync(stoppingToken);
            }
            catch (OperationCanceledException)
            {
                _logger.LogInformation("Shutdown requested while waiting for connection");
                return;
            }

            _logger.LogInformation("Komorebi connected");

            using var reader = new StreamReader(pipeServer);

            while (!stoppingToken.IsCancellationRequested)
            {
                string? line;
                try
                {
                    line = await reader.ReadLineAsync(stoppingToken);
                }
                catch (OperationCanceledException)
                {
                    break;
                }

                if (string.IsNullOrEmpty(line))
                {
                    // Check if pipe is still connected
                    if (!pipeServer.IsConnected)
                    {
                        _logger.LogWarning("Pipe disconnected");
                        break;
                    }
                    continue;
                }

                ProcessEvent(line);
            }
        }
        catch (IOException ex)
        {
            _logger.LogError(ex, "Pipe connection error");
            Environment.ExitCode = ExitCodes.PipeConnectionFailed;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Unexpected error in event listener");
            Environment.ExitCode = ExitCodes.UnexpectedError;
        }
        finally
        {
            await CleanupAsync();
        }
    }

    private void ProcessEvent(string json)
    {
        _logger.LogDebug("Received event JSON:\n{Json}", json);

        KomorebiEvent? evt;
        try
        {
            evt = JsonSerializer.Deserialize<KomorebiEvent>(json, JsonOptions);
        }
        catch (JsonException ex)
        {
            _logger.LogWarning(ex, "Failed to parse event JSON: {Json}", json);
            return;
        }

        if (evt?.Event is null)
        {
            return;
        }

        var eventType = evt.Event.Type;
        _logger.LogDebug("Received event: {EventType}", eventType);

        // First, check if any tracked windows have had their titles changed in the state
        // This is necessary because TitleUpdate events don't always fire for the window we're tracking
        if (evt.State.HasValue && _pendingCloses.Count > 0)
        {
            CheckStateForTitleChanges(evt.State.Value);
        }

        // Handle "Show" events to detect new Teams popup windows
        if (eventType == "Show")
        {
            if (evt.Event.Content is { } content &&
                content.ValueKind == JsonValueKind.Array &&
                content.GetArrayLength() >= 2)
            {
                var windowElement = content[1];
                try
                {
                    var window = windowElement.Deserialize<KomorebiWindow>(JsonOptions);
                    if (window is not null)
                    {
                        HandleShowEvent(window);
                    }
                }
                catch (JsonException ex)
                {
                    _logger.LogWarning(ex, "Failed to parse window content");
                }
            }
        }
    }

    /// <summary>
    /// Scans the state for any tracked windows whose titles have changed away from "Microsoft Teams".
    /// </summary>
    private void CheckStateForTitleChanges(JsonElement state)
    {
        try
        {
            // Navigate: state.monitors.elements[*].workspaces.elements[*].containers.elements[*].windows.elements[*]
            if (!state.TryGetProperty("monitors", out var monitors) ||
                !monitors.TryGetProperty("elements", out var monitorElements))
            {
                return;
            }

            foreach (var monitor in monitorElements.EnumerateArray())
            {
                if (!monitor.TryGetProperty("workspaces", out var workspaces) ||
                    !workspaces.TryGetProperty("elements", out var workspaceElements))
                {
                    continue;
                }

                foreach (var workspace in workspaceElements.EnumerateArray())
                {
                    if (!workspace.TryGetProperty("containers", out var containers) ||
                        !containers.TryGetProperty("elements", out var containerElements))
                    {
                        continue;
                    }

                    foreach (var container in containerElements.EnumerateArray())
                    {
                        if (!container.TryGetProperty("windows", out var windows) ||
                            !windows.TryGetProperty("elements", out var windowElements))
                        {
                            continue;
                        }

                        foreach (var windowElement in windowElements.EnumerateArray())
                        {
                            CheckWindowForTitleChange(windowElement);
                        }
                    }
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Error scanning state for title changes");
        }
    }

    private void CheckWindowForTitleChange(JsonElement windowElement)
    {
        if (!windowElement.TryGetProperty("hwnd", out var hwndElement) ||
            !windowElement.TryGetProperty("title", out var titleElement))
        {
            return;
        }

        var hwnd = hwndElement.GetInt64();
        var title = titleElement.GetString();

        // Check if we're tracking this window
        if (!_pendingCloses.TryGetValue(hwnd, out var cts))
        {
            return;
        }

        // If the title changed away from "Microsoft Teams", cancel the pending close
        if (title != "Microsoft Teams")
        {
            _logger.LogInformation(
                "Window {Hwnd} title changed to '{Title}' (detected from state), cancelling scheduled close",
                hwnd, title);

            CancelPendingClose(hwnd, cts);
        }
    }

    private void HandleShowEvent(KomorebiWindow window)
    {
        _logger.LogDebug("Show event: {Exe} - {Title} (HWND: {Hwnd})",
            window.Exe, window.Title, window.Hwnd);

        // Check if this is a Teams popup window that should be closed
        if (window.Exe != "ms-teams.exe" || window.Title != "Microsoft Teams")
        {
            return;
        }

        // If already tracking this window, don't start another timer
        if (_pendingCloses.ContainsKey(window.Hwnd))
        {
            _logger.LogDebug("Window {Hwnd} is already pending close", window.Hwnd);
            return;
        }

        _logger.LogInformation(
            "Teams popup detected (HWND: {Hwnd}), scheduling close in {Delay}ms",
            window.Hwnd, CloseDelayMilliseconds);

        var cts = new CancellationTokenSource();
        if (!_pendingCloses.TryAdd(window.Hwnd, cts))
        {
            // Another thread added it first
            cts.Dispose();
            return;
        }

        // Start the delayed close
        _ = CloseWindowAfterDelayAsync(window.Hwnd, cts.Token);
    }

    private async Task CloseWindowAfterDelayAsync(long hwnd, CancellationToken cancellationToken)
    {
        try
        {
            await Task.Delay(CloseDelayMilliseconds, cancellationToken);

            // Timer expired, close the window
            _logger.LogInformation("Closing Teams popup window (HWND: {Hwnd})", hwnd);

            var hwndPtr = (nint)hwnd;
            if (!Win32.PostMessageW(hwndPtr, Win32.WM_CLOSE, nint.Zero, nint.Zero))
            {
                var error = Marshal.GetLastWin32Error();
                _logger.LogWarning("PostMessage failed with error code: {ErrorCode}", error);
            }
        }
        catch (OperationCanceledException)
        {
            _logger.LogDebug("Close cancelled for window {Hwnd}", hwnd);
        }
        finally
        {
            // Clean up tracking
            if (_pendingCloses.TryRemove(hwnd, out var cts))
            {
                cts.Dispose();
            }
        }
    }

    private void CancelPendingClose(long hwnd, CancellationTokenSource cts)
    {
        try
        {
            cts.Cancel();
        }
        catch (ObjectDisposedException)
        {
            // Already disposed, ignore
        }

        if (_pendingCloses.TryRemove(hwnd, out var removed))
        {
            removed.Dispose();
        }
    }

    private async Task<bool> SubscribeToPipeAsync()
    {
        _logger.LogInformation("Subscribing to Komorebi events with pipe: {PipeName}", _pipeName);

        try
        {
            using var process = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = "komorebic",
                    Arguments = $"subscribe-pipe {_pipeName}",
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true
                }
            };

            process.Start();
            var stdout = await process.StandardOutput.ReadToEndAsync();
            var stderr = await process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync();

            if (process.ExitCode != 0)
            {
                _logger.LogError(
                    "Failed to subscribe to Komorebi pipe. Exit code: {ExitCode}, StdErr: {StdErr}, StdOut: {StdOut}",
                    process.ExitCode, stderr, stdout);
                return false;
            }

            _logger.LogInformation("Successfully subscribed to Komorebi events");
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to execute komorebic subscribe-pipe command");
            return false;
        }
    }

    private async Task UnsubscribeFromPipeAsync()
    {
        _logger.LogInformation("Unsubscribing from Komorebi events for pipe: {PipeName}", _pipeName);

        try
        {
            using var process = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = "komorebic",
                    Arguments = $"unsubscribe-pipe {_pipeName}",
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true
                }
            };

            process.Start();
            var stderr = await process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync();

            if (process.ExitCode != 0)
            {
                _logger.LogWarning(
                    "Failed to unsubscribe from Komorebi pipe. Exit code: {ExitCode}, StdErr: {StdErr}",
                    process.ExitCode, stderr);
            }
            else
            {
                _logger.LogInformation("Successfully unsubscribed from Komorebi events");
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to execute komorebic unsubscribe-pipe command");
        }
    }

    private async Task CleanupAsync()
    {
        if (_subscribed)
        {
            await UnsubscribeFromPipeAsync();
            _subscribed = false;
        }
    }
}

public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        var builder = Host.CreateApplicationBuilder(args);

        builder.Services.AddHostedService<KomorebiEventListenerService>();

        // Configure logging to console
        builder.Logging.AddConsole();

        var host = builder.Build();

        await host.RunAsync();

        return Environment.ExitCode;
    }
}
