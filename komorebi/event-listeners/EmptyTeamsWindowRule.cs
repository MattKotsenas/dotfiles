using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Text.Json;
using EventListeners.Models;
using EventListeners.Win32;
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
public sealed class EmptyTeamsWindowRule : IKomorebiEventRule
{
    private const int CloseDelayMilliseconds = 2000;
    private const string TeamsExeName = "ms-teams.exe";
    private const string EmptyTeamsTitle = "Microsoft Teams";

    private readonly ILogger<EmptyTeamsWindowRule> _logger;

    /// <summary>
    /// Tracks windows pending close. Key is HWND, value is the CancellationTokenSource to cancel the close.
    /// </summary>
    private readonly ConcurrentDictionary<long, CancellationTokenSource> _pendingCloses = new();

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true
    };

    public string Name => "EmptyTeamsWindowRule";

    public EmptyTeamsWindowRule(ILogger<EmptyTeamsWindowRule> logger)
    {
        _logger = logger;
    }

    public void ProcessEvent(string eventType, JsonElement? content, JsonElement? state)
    {
        // Check state for title changes on every event (if we have pending closes)
        if (state.HasValue && _pendingCloses.Count > 0)
        {
            CheckStateForTitleChanges(state.Value);
        }

        // Handle "Show" events to detect new Teams popup windows
        if (eventType == "Show" && content.HasValue)
        {
            HandleShowEvent(content.Value);
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

        // Check if this is a Teams popup window that should be closed
        if (window.Exe != TeamsExeName || window.Title != EmptyTeamsTitle)
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

        // Start the delayed close (fire and forget)
        _ = CloseWindowAfterDelayAsync(window.Hwnd, cts.Token);
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
        if (title != EmptyTeamsTitle)
        {
            _logger.LogInformation(
                "Window {Hwnd} title changed to '{Title}', cancelling scheduled close",
                hwnd, title);

            CancelPendingClose(hwnd, cts);
        }
    }

    private async Task CloseWindowAfterDelayAsync(long hwnd, CancellationToken cancellationToken)
    {
        try
        {
            await Task.Delay(CloseDelayMilliseconds, cancellationToken);

            // Timer expired, close the window
            _logger.LogInformation("Closing Teams popup window (HWND: {Hwnd})", hwnd);

            var hwndPtr = (nint)hwnd;
            if (!NativeMethods.PostMessageW(hwndPtr, NativeMethods.WM_CLOSE, nint.Zero, nint.Zero))
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
            // Already disposed, ignore
        }

        if (_pendingCloses.TryRemove(hwnd, out var removed))
        {
            removed.Dispose();
        }
    }
}
