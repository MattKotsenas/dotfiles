using System.Text.Json;
using EventListeners.Models;
using Microsoft.Extensions.Logging;

namespace EventListeners;

/// <summary>
/// Auto-closes the Serena MCP "Serena Dashboard" window whenever it appears.
///
/// Serena repeatedly spawns a native WinForms window (exe <c>python.exe</c>,
/// title "Serena Dashboard"). This rule sends WM_CLOSE as soon as komorebi
/// reports the window via a <c>Show</c> event.
///
/// Matching is on exe + title, deliberately NOT class: the WinForms class suffix
/// (<c>WindowsForms10.Window.8.app.0.*</c>) is regenerated per process, and the
/// exe check guards against closing a browser window that merely displays the
/// same localhost dashboard page.
/// </summary>
public sealed class SerenaDashboardRule : IEventRule
{
    private const string SerenaExeName = "python.exe";
    private const string SerenaTitle = "Serena Dashboard";

    private readonly ILogger<SerenaDashboardRule> _logger;
    private readonly IWindowAction _windowAction;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true
    };

    public string Name => "SerenaDashboardRule";

    public SerenaDashboardRule(ILogger<SerenaDashboardRule> logger, IWindowAction windowAction)
    {
        _logger = logger;
        _windowAction = windowAction;
    }

    public void ProcessEvent(IEvent evt)
    {
        if (evt is not KomorebiWindowEvent e) return;
        if (e.EventType != "Show" || !e.Content.HasValue) return;

        var window = ParseShowWindow(e.Content.Value);
        if (window is null) return;

        if (!string.Equals(window.Exe, SerenaExeName, StringComparison.OrdinalIgnoreCase) ||
            window.Title != SerenaTitle)
        {
            return;
        }

        _logger.LogInformation("Serena Dashboard detected (HWND: {Hwnd}); closing", window.Hwnd);
        _windowAction.Close(window.Hwnd);
    }

    private KomorebiWindow? ParseShowWindow(JsonElement content)
    {
        // Show content is a [reason, window] tuple, e.g. ["ObjectShow", { hwnd, title, exe, class }].
        if (content.ValueKind != JsonValueKind.Array || content.GetArrayLength() < 2)
        {
            return null;
        }

        try
        {
            return content[1].Deserialize<KomorebiWindow>(JsonOptions);
        }
        catch (JsonException ex)
        {
            _logger.LogWarning(ex, "Failed to parse window content in Show event");
            return null;
        }
    }
}
