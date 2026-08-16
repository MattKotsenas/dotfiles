using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace PointerUi.Windows;

internal sealed record NativeWindowCandidate(
    nint Hwnd,
    int ProcessId,
    string ProcessKey,
    long ProcessStartTimeUtcTicks,
    PixelRect Bounds,
    double Dpi,
    bool IsForeground,
    bool IsVisible,
    bool IsMinimized,
    bool IsCloaked,
    bool IsOnCurrentDesktop,
    bool IsToolWindow,
    bool IsNoActivate,
    bool IsChild,
    string ClassName);

internal sealed record NativeWindowEnumerationResult(
    IReadOnlyList<NativeWindowCandidate> Windows,
    IReadOnlyList<ProjectionDiagnostic> Diagnostics);

internal static class WindowEligibility
{
    public static bool IsEligible(NativeWindowCandidate window) =>
        window.IsVisible
        && !window.IsMinimized
        && !window.IsCloaked
        && window.IsOnCurrentDesktop
        && !window.IsToolWindow
        && !window.IsNoActivate
        && !window.IsChild
        && window.Bounds.Width >= 32
        && window.Bounds.Height >= 32
        && !string.Equals(
            window.ClassName,
            "Progman",
            StringComparison.Ordinal)
        && !string.Equals(
            window.ClassName,
            "WorkerW",
            StringComparison.Ordinal);
}

internal static unsafe partial class NativeWindowCatalog
{
    private const int GwlStyle = -16;
    private const int GwlExStyle = -20;
    private const long WsChild = 0x40000000L;
    private const long WsExToolWindow = 0x00000080L;
    private const long WsExNoActivate = 0x08000000L;
    private const uint DwmwaExtendedFrameBounds = 9;
    private const uint DwmwaCloaked = 14;
    private const int SmXVirtualScreen = 76;
    private const int SmYVirtualScreen = 77;
    private const int SmCxVirtualScreen = 78;
    private const int SmCyVirtualScreen = 79;

    private delegate bool EnumWindowsProc(nint hwnd, nint lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [ComImport]
    [Guid("A5CD92FF-29BE-454C-8D04-D82879FB3F1B")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IVirtualDesktopManager
    {
        [PreserveSig]
        int IsWindowOnCurrentVirtualDesktop(
            nint topLevelWindow,
            [MarshalAs(UnmanagedType.Bool)] out bool onCurrentDesktop);

    }

    [LibraryImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool EnumWindows(
        EnumWindowsProc callback,
        nint lParam);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool IsWindowVisible(nint hwnd);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool IsIconic(nint hwnd);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetWindowRect(nint hwnd, out Rect rect);

    [LibraryImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    private static partial nint GetWindowLongPtr(
        nint hwnd,
        int index);

    [LibraryImport("user32.dll")]
    private static partial uint GetWindowThreadProcessId(
        nint hwnd,
        out uint processId);

    [LibraryImport("user32.dll")]
    private static partial nint GetForegroundWindow();

    [LibraryImport("user32.dll")]
    private static partial uint GetDpiForWindow(nint hwnd);

    [LibraryImport("user32.dll")]
    private static partial int GetSystemMetrics(int index);

    [LibraryImport(
        "user32.dll",
        EntryPoint = "GetClassNameW")]
    private static partial int GetClassName(
        nint hwnd,
        char* className,
        int maxCount);

    [LibraryImport("dwmapi.dll")]
    private static partial int DwmGetWindowAttribute(
        nint hwnd,
        uint attribute,
        out Rect value,
        int valueSize);

    [LibraryImport("dwmapi.dll")]
    private static partial int DwmGetWindowAttribute(
        nint hwnd,
        uint attribute,
        out int value,
        int valueSize);

    public static PixelRect VirtualDesktopBounds() =>
        new(
            GetSystemMetrics(SmXVirtualScreen),
            GetSystemMetrics(SmYVirtualScreen),
            GetSystemMetrics(SmCxVirtualScreen),
            GetSystemMetrics(SmCyVirtualScreen));

    public static NativeWindowEnumerationResult Enumerate(
        string? processKey)
    {
        var windows = new List<NativeWindowCandidate>();
        var diagnostics = new List<ProjectionDiagnostic>();
        var foreground = GetForegroundWindow();
        var currentProcessId = Environment.ProcessId;
        var virtualDesktopManager = CreateVirtualDesktopManager();
        try
        {
            var completed = EnumWindows(
                (hwnd, _) => TryCollectWindow(
                    hwnd,
                    () => Describe(
                            hwnd,
                            foreground,
                            currentProcessId,
                            virtualDesktopManager,
                            diagnostics,
                            processKey),
                    windows,
                    diagnostics),
                nint.Zero);
            if (!completed)
            {
                throw new Win32Exception(
                    Marshal.GetLastPInvokeError(),
                    "Enumerating top-level windows failed.");
            }
        }
        finally
        {
            if (Marshal.IsComObject(virtualDesktopManager))
            {
                Marshal.FinalReleaseComObject(virtualDesktopManager);
            }
        }

        return new NativeWindowEnumerationResult(
            windows,
            diagnostics);
    }

    internal static bool TryCollectWindow(
        nint hwnd,
        Func<NativeWindowCandidate?> describe,
        List<NativeWindowCandidate> windows,
        List<ProjectionDiagnostic> diagnostics)
    {
        try
        {
            var candidate = describe();
            if (candidate is not null
                && WindowEligibility.IsEligible(candidate))
            {
                windows.Add(candidate);
            }
        }
        catch (Exception exception)
            when (!ExceptionPolicy.IsFatal(exception))
        {
            diagnostics.Add(new ProjectionDiagnostic(
                "desktop-query-failed",
                $"0x{hwnd:X}",
                exception.Message));
        }
        return true;
    }

    private static NativeWindowCandidate? Describe(
        nint hwnd,
        nint foreground,
        int currentProcessId,
        IVirtualDesktopManager virtualDesktopManager,
        List<ProjectionDiagnostic> diagnostics,
        string? processKeyFilter)
    {
        GetWindowThreadProcessId(hwnd, out var rawProcessId);
        var processId = checked((int)rawProcessId);
        if (processId == 0 || processId == currentProcessId)
        {
            return null;
        }

        string processKey;
        long processStartTimeUtcTicks;
        try
        {
            using var process = Process.GetProcessById(processId);
            processKey = $"{process.ProcessName}.exe";
            processStartTimeUtcTicks =
                process.StartTime.ToUniversalTime().Ticks;
        }
        catch (ArgumentException)
        {
            diagnostics.Add(new ProjectionDiagnostic(
                "process-vanished",
                $"0x{hwnd:X}",
                "The owning process exited during enumeration."));
            return null;
        }
        catch (InvalidOperationException)
        {
            diagnostics.Add(new ProjectionDiagnostic(
                "process-unreadable",
                $"0x{hwnd:X}",
                "The owning process could not be read."));
            return null;
        }
        catch (Win32Exception exception)
        {
            diagnostics.Add(new ProjectionDiagnostic(
                "process-unreadable",
                $"0x{hwnd:X}",
                exception.Message));
            return null;
        }
        if (processKeyFilter is not null
            && !string.Equals(
                processKey,
                processKeyFilter,
                StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var style = (long)GetWindowLongPtr(hwnd, GwlStyle);
        var exStyle = (long)GetWindowLongPtr(hwnd, GwlExStyle);
        int cloaked;
        DwmGetWindowAttribute(
            hwnd,
            DwmwaCloaked,
            out cloaked,
            sizeof(int));

        var onCurrentDesktopResult =
            virtualDesktopManager.IsWindowOnCurrentVirtualDesktop(
                hwnd,
                out var onCurrentDesktop);
        Marshal.ThrowExceptionForHR(onCurrentDesktopResult);

        var bounds = WindowBounds(hwnd);
        var dpi = GetDpiForWindow(hwnd);
        Span<char> classNameBuffer = stackalloc char[256];
        int classNameLength;
        fixed (char* className = classNameBuffer)
        {
            classNameLength = GetClassName(
                hwnd,
                className,
                classNameBuffer.Length);
        }

        return new NativeWindowCandidate(
            hwnd,
            processId,
            processKey,
            processStartTimeUtcTicks,
            bounds,
            dpi == 0 ? RenderingMetrics.DefaultDpi : dpi,
            hwnd == foreground,
            IsWindowVisible(hwnd),
            IsIconic(hwnd),
            cloaked != 0,
            onCurrentDesktop,
            (exStyle & WsExToolWindow) != 0,
            (exStyle & WsExNoActivate) != 0,
            (style & WsChild) != 0,
            classNameLength > 0
                ? new string(classNameBuffer[..classNameLength])
                : string.Empty);
    }

    private static PixelRect WindowBounds(nint hwnd)
    {
        Rect bounds;
        var result = DwmGetWindowAttribute(
            hwnd,
            DwmwaExtendedFrameBounds,
            out bounds,
            Marshal.SizeOf<Rect>());
        if (result != 0 && !GetWindowRect(hwnd, out bounds))
        {
            return default;
        }

        return new PixelRect(
            bounds.Left,
            bounds.Top,
            bounds.Right - bounds.Left,
            bounds.Bottom - bounds.Top);
    }

    private static IVirtualDesktopManager CreateVirtualDesktopManager()
    {
        var type = Type.GetTypeFromCLSID(
            new Guid("AA509086-5CA9-4C25-8F95-589D3C07B48A"),
            throwOnError: true)
            ?? throw new InvalidOperationException(
                "Virtual Desktop Manager COM class is unavailable.");
        return (IVirtualDesktopManager)(
            Activator.CreateInstance(type)
            ?? throw new InvalidOperationException(
                "Virtual Desktop Manager could not be created."));
    }
}
