using System.Text.Json;
using CliWrap;
using CliWrap.Buffered;
using EventListeners.Win32;
using Microsoft.Extensions.Logging;

namespace EventListeners;

/// <summary>
/// "Reacquire" sweep: force-manage every untracked, tileable top-level window, then
/// retile. This is the reliable alternative to restarting komorebi (which only
/// re-enumerates as a lossy snapshot). Bound to <c>CAP a r</c> via the
/// <c>wm.window.reacquire</c> intent.
/// </summary>
public interface IWindowSweeper
{
    /// <summary>
    /// Manage every untracked window that passes <see cref="WindowFilter"/>, restore
    /// the originally-focused window, then retile. Never throws.
    /// </summary>
    Task SweepAsync(CancellationToken cancellationToken = default);
}

public sealed class WindowSweeper : IWindowSweeper
{
    // komorebi tracks the foreground via a WinEvent hook, so we give it a beat to
    // observe the focus change before issuing `manage`.
    private static readonly TimeSpan FocusSettle = TimeSpan.FromMilliseconds(300);

    private readonly ILogger<WindowSweeper> _logger;
    private readonly ICommandRunner _runner;

    public WindowSweeper(ILogger<WindowSweeper> logger, ICommandRunner runner)
    {
        _logger = logger;
        _runner = runner;
    }

    public async Task SweepAsync(CancellationToken cancellationToken = default)
    {
        try
        {
            var tracked = await GetTrackedHwndsAsync(cancellationToken);

            var candidates = NativeWindows.EnumerateTopLevel()
                .Where(w => WindowFilter.ShouldManage(w, tracked))
                .ToList();

            _logger.LogInformation("Reacquire sweep: {Count} untracked window(s) to manage", candidates.Count);

            var original = NativeWindows.GetForeground();

            foreach (var window in candidates)
            {
                cancellationToken.ThrowIfCancellationRequested();

                if (!NativeWindows.ForceForeground((nint)window.Hwnd))
                {
                    _logger.LogDebug("Could not foreground '{Title}' ({Exe}); leaving untracked", window.Title, window.Exe);
                    continue;
                }

                await Task.Delay(FocusSettle, cancellationToken);
                await Komorebic("manage", cancellationToken);
                await Task.Delay(FocusSettle, cancellationToken);
            }

            // Put the user's focus back where it was before the sweep flicked through windows.
            if (original != nint.Zero)
            {
                NativeWindows.ForceForeground(original);
            }

            // Always retile -- this makes `wm.window.reacquire` a strict superset of the
            // old `wm.layout.retile`, so nothing is lost by rebinding the key.
            await Komorebic("retile", cancellationToken);
        }
        catch (OperationCanceledException)
        {
            // Shutting down; nothing to do.
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Reacquire sweep failed");
        }
    }

    private async Task<IReadOnlySet<long>> GetTrackedHwndsAsync(CancellationToken cancellationToken)
    {
        var result = await _runner.RunBufferedAsync(
            Cli.Wrap("komorebic").WithArguments("state").WithValidation(CommandResultValidation.None),
            cancellationToken);

        try
        {
            using var document = JsonDocument.Parse(result.StandardOutput);
            return document.RootElement.EnumerateAllWindows().Select(w => w.Hwnd).ToHashSet();
        }
        catch (JsonException ex)
        {
            // Treat unreadable state as "nothing tracked": worst case we re-issue manage
            // for already-managed windows, which komorebi treats as a no-op.
            _logger.LogWarning(ex, "Could not parse komorebic state; treating all windows as untracked");
            return new HashSet<long>();
        }
    }

    private async Task Komorebic(string args, CancellationToken cancellationToken)
    {
        var result = await _runner.RunAsync(
            Cli.Wrap("komorebic").WithArguments(args).WithValidation(CommandResultValidation.None),
            cancellationToken);

        if (result.ExitCode != 0)
        {
            _logger.LogWarning("komorebic {Args} exited {ExitCode}", args, result.ExitCode);
        }
    }
}
