using EventListeners.Win32;
using Microsoft.Extensions.Logging;

namespace EventListeners;

/// <summary>
/// A display's position and size in virtual-screen coordinates. Mirrors the shape
/// komorebi reports in a monitor's <c>size</c> field, so the two can be compared
/// directly.
/// </summary>
public readonly record struct MonitorBounds(int Left, int Top, int Width, int Height);

/// <summary>
/// Answers whether a monitor komorebi still lists is actually attached.
/// </summary>
public interface IMonitorTopology
{
    /// <summary>
    /// True when a physically attached display occupies exactly <paramref name="bounds"/>.
    /// </summary>
    bool IsAttached(MonitorBounds bounds);
}

/// <summary>
/// Win32 implementation of <see cref="IMonitorTopology"/>.
///
/// <para>
/// komorebi can keep a disconnected monitor in its state, so a monitor index proves
/// nothing about whether that monitor exists, and moving a window to a stale one
/// strands it on a workspace nobody can see. The check is a point hit-test:
/// <c>MonitorFromPoint</c> with <c>MONITOR_DEFAULTTONULL</c> returns null when no
/// live display covers the point.
/// </para>
/// </summary>
public sealed class Win32MonitorTopology : IMonitorTopology
{
    private readonly ILogger<Win32MonitorTopology> _logger;

    public Win32MonitorTopology(ILogger<Win32MonitorTopology> logger)
    {
        _logger = logger;
    }

    public bool IsAttached(MonitorBounds bounds)
    {
        if (bounds.Width <= 0 || bounds.Height <= 0)
        {
            return false;
        }

        var centre = new Point
        {
            X = bounds.Left + (bounds.Width / 2),
            Y = bounds.Top + (bounds.Height / 2),
        };

        var handle = NativeMethods.MonitorFromPoint(centre, NativeMethods.MONITOR_DEFAULTTONULL);
        if (handle == nint.Zero)
        {
            return false;
        }

        var info = new MonitorInfo { CbSize = (uint)System.Runtime.InteropServices.Marshal.SizeOf<MonitorInfo>() };
        if (!NativeMethods.GetMonitorInfoW(handle, ref info))
        {
            _logger.LogWarning("GetMonitorInfo failed for the display at {Left},{Top}", bounds.Left, bounds.Top);
            return false;
        }

        var live = new MonitorBounds(
            info.RcMonitor.Left,
            info.RcMonitor.Top,
            info.RcMonitor.Right - info.RcMonitor.Left,
            info.RcMonitor.Bottom - info.RcMonitor.Top);

        return live == bounds;
    }
}
