using System.Runtime.InteropServices;

namespace EventListeners.Win32;

/// <summary>
/// Native Win32 interop methods.
/// </summary>
public static partial class NativeMethods
{
    public const uint WM_CLOSE = 0x0010;

    [LibraryImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool PostMessageW(nint hWnd, uint msg, nint wParam, nint lParam);
}
