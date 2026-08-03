using System.Runtime.InteropServices;

namespace EventListeners.Win32;

/// <summary>
/// Native Win32 interop methods.
/// </summary>
public static partial class NativeMethods
{
    public const uint WM_CLOSE = 0x0010;

    /// <summary>Return NULL rather than a nearest-monitor fallback when the point is off-screen.</summary>
    public const uint MONITOR_DEFAULTTONULL = 0;

    [LibraryImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool PostMessageW(nint hWnd, uint msg, nint wParam, nint lParam);

    [LibraryImport("user32.dll")]
    public static partial nint GetForegroundWindow();

    [LibraryImport("user32.dll")]
    public static partial nint MonitorFromPoint(Point pt, uint dwFlags);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool GetMonitorInfoW(nint hMonitor, ref MonitorInfo lpmi);
}

[StructLayout(LayoutKind.Sequential)]
public struct Point
{
    public int X;
    public int Y;
}

[StructLayout(LayoutKind.Sequential)]
public struct Rect
{
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
}

[StructLayout(LayoutKind.Sequential)]
public struct MonitorInfo
{
    public uint CbSize;
    public Rect RcMonitor;
    public Rect RcWork;
    public uint DwFlags;
}
