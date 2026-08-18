using System.ComponentModel;
using System.Runtime.InteropServices;
using PointerUi.Windows;

namespace PointerUi.Acceptance.Tests;

internal sealed record HostWindowSnapshot(
    PixelRect Bounds,
    long ExtendedStyle,
    bool IsPerMonitorV2);

internal static class HostWindowCatalog
{
    private const int GwlExStyle = -20;

    public const long Transparent = 0x00000020;
    public const long ToolWindow = 0x00000080;
    public const long NoActivate = 0x08000000;
    private static readonly nint PerMonitorV2 =
        new(-4);

    private delegate bool EnumWindowsProc(
        nint window,
        nint data);

    public static IReadOnlyList<HostWindowSnapshot>
        Enumerate(int processId)
    {
        var windows = new List<HostWindowSnapshot>();
        if (!EnumWindows(
                (window, data) =>
                {
                    GetWindowThreadProcessId(
                        window,
                        out var owner);
                    if (owner != processId
                        || !IsWindowVisible(window))
                    {
                        return true;
                    }
                    if (!GetWindowRect(window, out var bounds))
                    {
                        throw new Win32Exception(
                            Marshal.GetLastPInvokeError(),
                            "Reading overlay bounds failed.");
                    }
                    windows.Add(new HostWindowSnapshot(
                        bounds.ToPixelRect(),
                        GetWindowLongPtr(
                            window,
                            GwlExStyle).ToInt64(),
                        AreDpiAwarenessContextsEqual(
                            GetWindowDpiAwarenessContext(
                                window),
                            PerMonitorV2)));
                    return true;
                },
                nint.Zero))
        {
            throw new Win32Exception(
                Marshal.GetLastPInvokeError(),
                "Enumerating overlay windows failed.");
        }
        return windows;
    }

    public static nint ForegroundWindow() =>
        GetForegroundWindow();

    public static uint ScreenChecksum(
        PixelPoint point,
        int radius = 3) =>
        ScreenChecksum(new PixelRect(
            point.X - radius,
            point.Y - radius,
            radius * 2 + 1,
            radius * 2 + 1));

    public static uint ScreenChecksum(PixelRect bounds)
    {
        var desktop = GetDC(nint.Zero);
        if (desktop == nint.Zero)
        {
            throw new Win32Exception(
                Marshal.GetLastPInvokeError(),
                "Reading the desktop surface failed.");
        }
        try
        {
            var checksum = 0U;
            var step = Math.Max(
                1,
                checked((int)Math.Min(
                    bounds.Width,
                    bounds.Height)) / 16);
            for (
                var y = checked((int)bounds.Y);
                y < bounds.Y + bounds.Height;
                y += step)
            {
                for (
                    var x = checked((int)bounds.X);
                    x < bounds.X + bounds.Width;
                    x += step)
                {
                    checksum = unchecked(
                        checksum * 16777619
                        ^ GetPixel(
                            desktop,
                            x,
                            y));
                }
            }

            return checksum;
        }
        finally
        {
            _ = ReleaseDC(nint.Zero, desktop);
        }
    }

    public static uint ScreenColor(PixelPoint point)
    {
        var desktop = GetDC(nint.Zero);
        if (desktop == nint.Zero)
        {
            throw new Win32Exception(
                Marshal.GetLastPInvokeError(),
                "Reading the desktop surface failed.");
        }
        try
        {
            return GetPixel(
                desktop,
                checked((int)point.X),
                checked((int)point.Y));
        }
        finally
        {
            _ = ReleaseDC(nint.Zero, desktop);
        }
    }

    public static void SetPointer(PixelPoint point)
    {
        if (!SetCursorPos(
                checked((int)point.X),
                checked((int)point.Y)))
        {
            throw new Win32Exception(
                Marshal.GetLastPInvokeError(),
                "Moving the acceptance pointer failed.");
        }
    }

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumWindows(
        EnumWindowsProc callback,
        nint data);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(
        nint window,
        out int processId);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(nint window);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetWindowRect(
        nint window,
        out Rect bounds);

    [DllImport("user32.dll")]
    private static extern nint GetForegroundWindow();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern nint GetDC(nint window);

    [DllImport("user32.dll")]
    private static extern int ReleaseDC(
        nint window,
        nint hdc);

    [DllImport("gdi32.dll")]
    private static extern uint GetPixel(
        nint hdc,
        int x,
        int y);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetCursorPos(
        int x,
        int y);

    [DllImport(
        "user32.dll",
        EntryPoint = "GetWindowLongPtrW",
        SetLastError = true)]
    private static extern nint GetWindowLongPtr(
        nint window,
        int index);

    [DllImport("user32.dll")]
    private static extern nint GetWindowDpiAwarenessContext(
        nint window);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AreDpiAwarenessContextsEqual(
        nint first,
        nint second);

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
}
