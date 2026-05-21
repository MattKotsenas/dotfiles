using System.Collections.Concurrent;
using System.Text.Json;
using EventListeners.Models;
using Microsoft.Extensions.Logging;

namespace EventListeners;

/// <summary>
/// Rule that closes empty Microsoft Teams popup windows.
/// Teams creates windows with the title "Microsoft Teams" that are either:
/// 1. Temporary popups that should be closed
/// 2. Real windows that will get a proper title (e.g., "Meeting with X | Microsoft Teams")
///
/// This rule waits for a delay period, and if the title hasn't changed, closes the window.
/// </summary>
public sealed class EmptyTeamsWindowRule : IEventRule
{
    private static readonly TimeSpan CloseDelay = TimeSpan.FromSeconds(2);
    private const string TeamsExeName = "ms-teams.exe";
    private const string EmptyTeamsTitle = "Microsoft Teams";

    private readonly ILogger<EmptyTeamsWindowRule> _logger;
    private readonly IWindowAction _windowAction;
    private readonly TimeProvider _timeProvider;

    /// <summary>
    /// Tracks windows pending close. Key is HWND, value is the CancellationTokenSource to cancel the close.
    /// </summary>
    private readonly ConcurrentDictionary<long, CancellationTokenSource> _pendingCloses = new();

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true
    };

    public string Name => "EmptyTeamsWindowRule";

    public EmptyTeamsWindowRule(
        ILogger<EmptyTeamsWindowRule> logger,
        IWindowAction windowAction,
        TimeProvider timeProvider)
    {
        _logger = logger;
        _windowAction = windowAction;
        _timeProvider = timeProvider;
    }

    public void ProcessEvent(IEvent evt)
    {
        if (evt is not KomorebiWindowEvent e) return;

        if (e.State.HasValue && !_pendingCloses.IsEmpty)
        {
            CheckStateForTitleChanges(e.State.Value);
        }

        if (e.EventType == "Show" && e.Content.HasValue)
        {
            HandleShowEvent(e.Content.Value);
        }
    }

    private void HandleShowEvent(JsonElement content)
    {
        // Content is an array: [reason_string, window_object]
        if (content.ValueKind != JsonValueKind.Array || content.GetArrayLength() < 2)
        {
            return;
        }

        KomorebiWindow? window;
        try
        {
            window = content[1].Deserialize<KomorebiWindow>(JsonOptions);
        }
        catch (JsonException ex)
        {
            _logger.LogWarning(ex, "Failed to parse window content in Show event");
            return;
        }

        if (window is null)
        {
            return;
        }

        _logger.LogDebug("Show event: {Exe} - {Title} (HWND: {Hwnd})",
            window.Exe, window.Title, window.Hwnd);

        if (window.Exe != TeamsExeName || window.Title != EmptyTeamsTitle)
        {
            return;
        }

        if (_pendingCloses.ContainsKey(window.Hwnd))
        {
            _logger.LogDebug("Window {Hwnd} is already pending close", window.Hwnd);
            return;
        }

        _logger.LogInformation(
            "Teams popup detected (HWND: {Hwnd}), scheduling close in {Delay}",
            window.Hwnd, CloseDelay);

        var cts = new CancellationTokenSource();
        if (!_pendingCloses.TryAdd(window.Hwnd, cts))
        {
            cts.Dispose();
            return;
        }

        _ = CloseWindowAfterDelayAsync(window.Hwnd, cts.Token);
    }

    private void CheckStateForTitleChanges(JsonElement state)
    {
        foreach (var window in state.EnumerateAllWindows())
        {
            if (!_pendingCloses.TryGetValue(window.Hwnd, out var cts))
            {
                continue;
            }

            if (window.Title != EmptyTeamsTitle)
            {
                _logger.LogInformation(
                    "Window {Hwnd} title changed to '{Title}', cancelling scheduled close",
                    window.Hwnd, window.Title);
                CancelPendingClose(window.Hwnd, cts);
            }
        }
    }

    private async Task CloseWindowAfterDelayAsync(long hwnd, CancellationToken cancellationToken)
    {
        try
        {
            await Task.Delay(CloseDelay, _timeProvider, cancellationToken);

            _logger.LogInformation("Closing Teams popup window (HWND: {Hwnd})", hwnd);
            _windowAction.Close(hwnd);
        }
        catch (OperationCanceledException)
        {
            _logger.LogDebug("Close cancelled for window {Hwnd}", hwnd);
        }
        finally
        {
            if (_pendingCloses.TryRemove(hwnd, out var removedCts))
            {
                removedCts.Dispose();
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
        }

        if (_pendingCloses.TryRemove(hwnd, out var removed))
        {
            removed.Dispose();
        }
    }
}
