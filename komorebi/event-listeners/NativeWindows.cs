using System.Diagnostics;
using System.Runtime.InteropServices;

namespace EventListeners.Win32;

/// <summary>
/// Win32 helpers for the reacquire sweep: enumerate top-level windows and force a
/// window to the foreground.
///
/// Foreground forcing uses the AttachThreadInput dance because a plain
/// SetForegroundWindow is silently rejected for many windows (notably WebView2-hosted
/// apps like the new Teams) when called from a background thread -- the foreground
/// lock. komorebi's only "force manage" path is <c>ManageFocusedWindow</c>, so the
/// sweep has to make each target genuinely foreground before asking komorebi to take it.
/// </summary>
public static partial class NativeWindows
{
    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    private const uint GW_HWNDNEXT = 2;
    private const int GWL_STYLE = -16;
    private const int GWL_EXSTYLE = -20;
    private const long WS_CHILD = 0x40000000L;
    private const long WS_EX_TOOLWINDOW = 0x00000080L;
    private const long WS_EX_NOACTIVATE = 0x08000000L;
    private const uint DWMWA_CLOAKED = 14;
    private const int SW_RESTORE = 9;
    private const byte VK_MENU = 0x12;
    private const uint KEYEVENTF_KEYUP = 0x0002;

    [LibraryImport("user32.dll")]
    private static partial nint GetTopWindow(nint hWnd);

    [LibraryImport("user32.dll")]
    private static partial nint GetWindow(nint hWnd, uint uCmd);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool IsWindowVisible(nint hWnd);

    [LibraryImport("user32.dll")]
    private static partial int GetWindowTextLengthW(nint hWnd);

    [LibraryImport("user32.dll")]
    private static unsafe partial int GetWindowTextW(nint hWnd, char* lpString, int nMaxCount);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetWindowRect(nint hWnd, out RECT lpRect);

    [LibraryImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    private static partial nint GetWindowLongPtr(nint hWnd, int nIndex);

    [LibraryImport("user32.dll")]
    private static partial uint GetWindowThreadProcessId(nint hWnd, out uint lpdwProcessId);

    [LibraryImport("dwmapi.dll")]
    private static partial int DwmGetWindowAttribute(nint hWnd, uint dwAttribute, out int pvAttribute, int cbAttribute);

    [LibraryImport("user32.dll")]
    private static partial nint GetForegroundWindow();

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool SetForegroundWindow(nint hWnd);

    [LibraryImport("user32.dll")]
    private static partial nint SetActiveWindow(nint hWnd);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool BringWindowToTop(nint hWnd);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool ShowWindow(nint hWnd, int nCmdShow);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool AttachThreadInput(uint idAttach, uint idAttachTo, [MarshalAs(UnmanagedType.Bool)] bool fAttach);

    [LibraryImport("kernel32.dll")]
    private static partial uint GetCurrentThreadId();

    [LibraryImport("user32.dll")]
    private static partial void keybd_event(byte bVk, byte bScan, uint dwFlags, nuint dwExtraInfo);

    /// <summary>Handle of the current foreground window (0 if none).</summary>
    public static nint GetForeground() => GetForegroundWindow();

    /// <summary>Enumerate every top-level window in Z-order.</summary>
    public static IReadOnlyList<WindowInfo> EnumerateTopLevel()
    {
        var list = new List<WindowInfo>();
        for (var h = GetTopWindow(nint.Zero); h != nint.Zero; h = GetWindow(h, GW_HWNDNEXT))
        {
            list.Add(Describe(h));
        }

        return list;
    }

    private static WindowInfo Describe(nint h)
    {
        var len = GetWindowTextLengthW(h);
        var title = string.Empty;
        if (len > 0)
        {
            var buffer = new char[len + 1];
            int copied;
            unsafe
            {
                fixed (char* p = buffer)
                {
                    copied = GetWindowTextW(h, p, buffer.Length);
                }
            }

            title = new string(buffer, 0, Math.Clamp(copied, 0, buffer.Length - 1));
        }

        var style = (long)GetWindowLongPtr(h, GWL_STYLE);
        var exStyle = (long)GetWindowLongPtr(h, GWL_EXSTYLE);

        DwmGetWindowAttribute(h, DWMWA_CLOAKED, out var cloaked, sizeof(int));
        GetWindowRect(h, out var rect);

        GetWindowThreadProcessId(h, out var processId);
        var exe = string.Empty;
        try
        {
            using var process = Process.GetProcessById((int)processId);
            exe = process.ProcessName;
        }
        catch
        {
            // Process may have exited between enumeration and lookup; leave exe empty.
        }

        return new WindowInfo
        {
            Hwnd = h,
            Title = title,
            Exe = exe,
            Width = rect.Right - rect.Left,
            Height = rect.Bottom - rect.Top,
            IsVisible = IsWindowVisible(h),
            IsCloaked = cloaked != 0,
            IsToolWindow = (exStyle & WS_EX_TOOLWINDOW) != 0,
            IsNoActivate = (exStyle & WS_EX_NOACTIVATE) != 0,
            IsChild = (style & WS_CHILD) != 0,
        };
    }

    /// <summary>
    /// Best-effort: bring <paramref name="hwnd"/> to the foreground, returning whether
    /// it is the foreground window afterwards. Uses AttachThreadInput so it succeeds for
    /// windows that reject a bare SetForegroundWindow.
    /// </summary>
    public static bool ForceForeground(nint hwnd)
    {
        var foreground = GetForegroundWindow();
        var targetThread = GetWindowThreadProcessId(hwnd, out _);
        var foregroundThread = GetWindowThreadProcessId(foreground, out _);
        var currentThread = GetCurrentThreadId();

        // A synthetic ALT tap releases the foreground lock that otherwise makes
        // SetForegroundWindow a no-op when called from a non-foreground thread.
        keybd_event(VK_MENU, 0, 0, nuint.Zero);
        keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, nuint.Zero);

        var attachedForeground = foregroundThread != currentThread && AttachThreadInput(currentThread, foregroundThread, true);
        var attachedTarget = targetThread != currentThread && AttachThreadInput(currentThread, targetThread, true);
        try
        {
            ShowWindow(hwnd, SW_RESTORE);
            BringWindowToTop(hwnd);
            SetForegroundWindow(hwnd);
            SetActiveWindow(hwnd);
        }
        finally
        {
            if (attachedForeground) AttachThreadInput(currentThread, foregroundThread, false);
            if (attachedTarget) AttachThreadInput(currentThread, targetThread, false);
        }

        return GetForegroundWindow() == hwnd;
    }
}
