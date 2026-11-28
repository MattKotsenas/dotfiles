using System.Text.Json;
using EventListeners.Models;
using Microsoft.Extensions.Logging;

namespace EventListeners;

/// <summary>Hides the Windows Terminal window tagged by the PowerShell profile for a Rex SSH transport.</summary>
internal sealed class RexSshWindowRule(ILogger<RexSshWindowRule> logger, IWindowAction windowAction) : IEventRule
{
    private const string TerminalExe = "WindowsTerminal.exe";
    private const string SentinelTitle = "Rex SSH transport";

    public string Name => nameof(RexSshWindowRule);

    public void ProcessEvent(IEvent evt)
    {
        // The shell sets the title after the window appears. Komorebi normally
        // forwards that as TitleUpdate, but can classify a name change as Show.
        if (evt is not KomorebiWindowEvent { EventType: "Show" or "TitleUpdate", Content: { } content } ||
            content.ValueKind != JsonValueKind.Array ||
            content.GetArrayLength() < 2)
        {
            return;
        }

        var window = content[1];
        if (window.ValueKind != JsonValueKind.Object ||
            !window.TryGetProperty("exe", out var exe) ||
            exe.ValueKind != JsonValueKind.String ||
            !string.Equals(exe.GetString(), TerminalExe, StringComparison.OrdinalIgnoreCase) ||
            !window.TryGetProperty("title", out var title) ||
            title.ValueKind != JsonValueKind.String ||
            !title.ValueEquals(SentinelTitle) ||
            !window.TryGetProperty("hwnd", out var handle) ||
            handle.ValueKind != JsonValueKind.Number ||
            !handle.TryGetInt64(out var hwnd) || hwnd <= 0)
        {
            return;
        }

        // Windows Terminal's default windowing behavior gives a delegated console
        // its own window. This workaround hides that window without disconnecting Rex.
        if (windowAction.HideIfMatches(hwnd, TerminalExe, SentinelTitle))
        {
            logger.LogInformation("Requested hide for Rex SSH window {Hwnd}", hwnd);
        }
    }
}
