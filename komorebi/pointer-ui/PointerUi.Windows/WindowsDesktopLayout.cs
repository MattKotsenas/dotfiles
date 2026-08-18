using System.ComponentModel;
using System.Runtime.InteropServices;

namespace PointerUi.Windows;

public sealed record MonitorSnapshot(
    PixelRect Bounds,
    double Dpi);

public sealed record DesktopLayoutSnapshot(
    PixelRect VirtualBounds,
    PixelPoint Pointer,
    IReadOnlyList<MonitorSnapshot> Monitors);

public static partial class WindowsDesktopLayout
{
    private delegate bool MonitorEnumProc(
        nint monitor,
        nint hdc,
        ref Rect bounds,
        nint data);

    public static DesktopLayoutSnapshot Capture()
    {
        if (!GetCursorPos(out var pointer))
        {
            throw new Win32Exception(
                Marshal.GetLastPInvokeError(),
                "Reading the pointer position failed.");
        }

        var monitors = new List<MonitorSnapshot>();
        Exception? monitorError = null;
        if (!EnumDisplayMonitors(
                nint.Zero,
                nint.Zero,
                (
                    nint monitor,
                    nint hdc,
                    ref Rect bounds,
                    nint data) =>
                {
                    var info = new MonitorInfo
                    {
                        Size = Marshal.SizeOf<MonitorInfo>(),
                    };
                    if (!GetMonitorInfo(monitor, ref info))
                    {
                        monitorError = new Win32Exception(
                            Marshal.GetLastPInvokeError(),
                            "Reading monitor bounds failed.");
                        return false;
                    }
                    var dpiResult = GetDpiForMonitor(
                        monitor,
                        0,
                        out var dpiX,
                        out _);
                    if (dpiResult != 0)
                    {
                        monitorError =
                            Marshal.GetExceptionForHR(dpiResult);
                        return false;
                    }

                    monitors.Add(new MonitorSnapshot(
                        info.Monitor.ToPixelRect(),
                        dpiX));
                    return true;
                },
                nint.Zero))
        {
            if (monitorError is not null)
            {
                throw monitorError;
            }
            throw new Win32Exception(
                Marshal.GetLastPInvokeError(),
                "Enumerating display monitors failed.");
        }
        if (monitors.Count == 0)
        {
            throw new InvalidOperationException(
                "No display monitors were found.");
        }

        return new DesktopLayoutSnapshot(
            NativeWindowCatalog.VirtualDesktopBounds(),
            new PixelPoint(pointer.X, pointer.Y),
            monitors
                .OrderBy(monitor => monitor.Bounds.X)
                .ThenBy(monitor => monitor.Bounds.Y)
                .ToList());
    }

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumDisplayMonitors(
        nint hdc,
        nint clip,
        MonitorEnumProc callback,
        nint data);

    [LibraryImport(
        "user32.dll",
        EntryPoint = "GetMonitorInfoW",
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetMonitorInfo(
        nint monitor,
        ref MonitorInfo info);

    [LibraryImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetCursorPos(
        out Point point);

    [LibraryImport("shcore.dll")]
    private static partial int GetDpiForMonitor(
        nint monitor,
        uint dpiType,
        out uint dpiX,
        out uint dpiY);

    [StructLayout(LayoutKind.Sequential)]
    private struct Point
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;

        public readonly PixelRect ToPixelRect() =>
            new(
                Left,
                Top,
                Right - Left,
                Bottom - Top);
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct MonitorInfo
    {
        public int Size;
        public Rect Monitor;
        public Rect WorkArea;
        public uint Flags;
    }
}
