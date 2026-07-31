using Microsoft.Extensions.Logging;

namespace EventListeners;

public interface ITeamsCallControls
{
    void Leave();
}

/// <summary>
/// Drives the controls of a live Teams call.
///
/// A call window is identified by the control itself rather than by its title: an
/// in-call window is titled <c>meeting | Microsoft Teams</c>, which is the same
/// shape as every other Teams window, but only a call offers a hangup button.
///
/// Pressing the button rather than sending a shortcut means the call need not be
/// the focused window, so this reaches a call minimized into its monitor window.
/// The binding still lives in the Teams overlay, so Teams itself must be focused
/// for the key to arrive here at all.
/// </summary>
internal sealed class TeamsCallControls(
    ILogger<TeamsCallControls> logger,
    ITeamsSurface teams) : ITeamsCallControls
{
    private const string HangUpAutomationId = "hangup-button";

    /// <summary>
    /// How long to keep looking. A cold Teams window can report an incomplete tree,
    /// so one miss is not proof that no call is running; a second look usually finds
    /// it. Bounded because failing to leave must not become failing forever.
    /// </summary>
    private static readonly TimeSpan RetryWindow = TimeSpan.FromSeconds(2);

    private static readonly TimeSpan RetryInterval = TimeSpan.FromMilliseconds(250);

    /// <summary>
    /// A ceiling on one UIA scan. The calls are synchronous and a provider can block
    /// without ever returning, which would otherwise strand the in-flight flag and
    /// make every later leave a no-op.
    /// </summary>
    private static readonly TimeSpan ScanTimeout = TimeSpan.FromSeconds(5);

    private int _running;

    public void Leave() => _ = RunAsync();

    /// <summary>
    /// One leave attempt, including the in-flight guard. Awaitable so a test can
    /// prove the guard is released rather than waiting on a clock.
    /// </summary>
    internal async Task RunAsync()
    {
        if (Interlocked.CompareExchange(ref _running, 1, 0) != 0)
        {
            logger.LogDebug("Ignoring a leave request while one is already running");
            return;
        }

        try
        {
            await LeaveAsync();
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Leaving the Teams call failed");
        }
        finally
        {
            Volatile.Write(ref _running, 0);
        }
    }

    internal async Task LeaveAsync()
    {
        var deadline = DateTime.UtcNow + RetryWindow;
        while (true)
        {
            var result = await SearchAsync();
            switch (result)
            {
                case ControlSearch.Invoked:
                    logger.LogInformation("Left the Teams call");
                    return;

                case ControlSearch.Ambiguous:
                    logger.LogInformation(
                        "More than one Teams call is running, so which to leave is ambiguous; " +
                        "leave the one you mean from Teams itself");
                    return;

                // A miss or a failed read may just be a cold tree, so look again
                // until the window closes rather than reporting no call outright.
                case ControlSearch.NotFound:
                case ControlSearch.Failed:
                    if (DateTime.UtcNow >= deadline)
                    {
                        logger.LogInformation(
                            result == ControlSearch.NotFound
                                ? "No Teams call to leave"
                                : "Could not read Teams reliably, so nothing was pressed");
                        return;
                    }

                    await Task.Delay(RetryInterval);
                    break;
            }
        }
    }

    /// <summary>
    /// Runs one scan with a ceiling on how long it may take. A hung scan is
    /// abandoned rather than waited on; the orphaned call may still complete later,
    /// which is a lesser evil than never leaving a call again.
    /// </summary>
    private async Task<ControlSearch> SearchAsync()
    {
        try
        {
            return await Task.Run(() => teams.InvokeUniqueInAnyWindow(HangUpAutomationId))
                .WaitAsync(ScanTimeout);
        }
        catch (TimeoutException)
        {
            logger.LogWarning("Reading the Teams UI did not finish within {Timeout}s", ScanTimeout.TotalSeconds);
            return ControlSearch.Failed;
        }
    }
}
